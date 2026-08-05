// Black-box HTTP conformance suite for the canonical Go relay.
//
// This file boots the Go relay as a real subprocess (never importing its
// internals) and drives its public contract over plain HTTP.
//
// Cloudflare is not covered here because its D1/R2 and rate-limit bindings
// require a separate Workers integration harness rather than a hermetic local
// subprocess.
//
// Envelopes are generated with the real @simplysync/protocol crypto
// (deriveIdentity -> encryptPayload), not hand-built JSON, so pushes exercise
// the same envelope shape a real client sends.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  deriveStreamId,
  HLC_MAX_FUTURE_DRIFT_MS,
  sha256Base64UrlBytes,
} from "@simplysync/protocol";
import {
  cleanupGoBinary,
  isGoAvailable,
  launchRelay,
  type LaunchedRelay,
  type RelayKind,
} from "./conformance/launch-relay";
import {
  createTestIdentity,
  makeEnvelope,
  makeEnvelopes,
  type TestIdentity,
} from "./conformance/envelopes";
import {
  compactStreams,
  getBlob,
  getStatus,
  getUsage,
  headBlob,
  pullEvents,
  pushEvents,
  putBlob,
} from "./conformance/http";

const ADMIN_TOKEN = "conformance-admin-token";
const ADMIN_PATH = "conformance-admin";
const ADMIN_BASE = `/${ADMIN_PATH}`;
const TINY_OWNER_QUOTA_BYTES = 4096;

if (!isGoAvailable()) {
  throw new Error("[conformance] `go` was not found on PATH");
}

const kinds: RelayKind[] = ["go"];

describe.each(kinds)("relay conformance — %s", (kind) => {
  let relay: LaunchedRelay;
  // Boots with ADMIN_TOKEN/ADMIN_PATH set (for the metric-label assertion)
  // and a tiny MAX_OWNER_BYTES (for the quota assertion) — kept separate from
  // `relay` so the default-config tests above aren't affected by the tiny
  // quota, and combined into one process (rather than two) to limit how many
  // subprocesses this suite has to track and clean up.
  let specialRelay: LaunchedRelay;

  beforeAll(async () => {
    [relay, specialRelay] = await Promise.all([
      launchRelay(kind, { RATE_LIMIT_ENABLED: "false" }),
      launchRelay(kind, {
        ADMIN_TOKEN,
        ADMIN_PATH,
        MAX_OWNER_BYTES: String(TINY_OWNER_QUOTA_BYTES),
        RATE_LIMIT_ENABLED: "false",
      }),
    ]);
  }, 45_000);

  afterAll(async () => {
    await Promise.all([relay?.kill(), specialRelay?.kill()]);
  });

  // --- health ------------------------------------------------------------

  test("GET /health returns 200 with a version field", async () => {
    const res = await fetch(`${relay.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: unknown; version: unknown };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe("string");
  });

  // --- auth gating ---------------------------------------------------------

  test("GET /v1/events with no Authorization header is rejected", async () => {
    const res = await fetch(`${relay.baseUrl}/v1/events?ownerId=nobody`);
    expect([401, 403]).toContain(res.status);
  });

  test("GET /v1/status for an owner that never pushed returns 404", async () => {
    const t = await createTestIdentity();
    const res = await getStatus(relay.baseUrl, t);
    expect(res.status).toBe(404);
  });

  test("wrong bearer token for an existing owner returns 401", async () => {
    const t = await createTestIdentity();
    const event = await makeEnvelope(t);
    const pushRes = await pushEvents(relay.baseUrl, t, [event]);
    expect(pushRes.status).toBe(200); // owner created trust-on-first-use

    const res = await getStatus(relay.baseUrl, t, {
      bearer: "not-the-real-token",
    });
    expect(res.status).toBe(401);
  });

  // --- push/pull round-trip ------------------------------------------------

  test("push then pull returns exactly the pushed events plus a cursor", async () => {
    const t = await createTestIdentity();
    const events = await makeEnvelopes(t, 5);

    const pushRes = await pushEvents(relay.baseUrl, t, events);
    expect(pushRes.status).toBe(200);
    expect(await pushRes.json()).toEqual({ accepted: 5, duplicate: 0 });

    const pullRes = await pullEvents(relay.baseUrl, t, "");
    expect(pullRes.status).toBe(200);
    const pullBody = (await pullRes.json()) as {
      events: { eventId: string }[];
      nextCursor: string;
    };
    expect(pullBody.events).toHaveLength(5);
    expect(typeof pullBody.nextCursor).toBe("string");
    expect(pullBody.nextCursor).not.toBe("");
    expect(pullBody.events.map((e) => e.eventId).sort()).toEqual(
      events.map((e) => e.eventId).sort(),
    );

    const secondPull = await pullEvents(relay.baseUrl, t, pullBody.nextCursor);
    expect(secondPull.status).toBe(200);
    const secondBody = (await secondPull.json()) as { events: unknown[] };
    expect(secondBody.events).toHaveLength(0);
  });

  test("push rejects malformed and future HLC event ids", async () => {
    const malformedOwner = await createTestIdentity();
    const malformed = await makeEnvelope(malformedOwner);
    expect(
      (
        await pushEvents(relay.baseUrl, malformedOwner, [
          { ...malformed, eventId: "not-an-hlc" },
        ])
      ).status,
    ).toBe(400);

    const futureOwner = await createTestIdentity();
    const future = await makeEnvelope(futureOwner, {
      now: Date.now() + HLC_MAX_FUTURE_DRIFT_MS + 60_000,
    });
    expect(
      (await pushEvents(relay.baseUrl, futureOwner, [future])).status,
    ).toBe(400);

  });

  // --- idempotent re-push ----------------------------------------------------

  test("re-pushing the same events is idempotent and leaves usage unchanged", async () => {
    const t = await createTestIdentity();
    const events = await makeEnvelopes(t, 4);
    await pushEvents(relay.baseUrl, t, events);
    const usageBefore = (await (await getUsage(relay.baseUrl, t)).json()) as {
      storedBytes: number;
    };

    const secondPush = await pushEvents(relay.baseUrl, t, events);
    expect(await secondPush.json()).toEqual({ accepted: 0, duplicate: 4 });

    const usageAfter = (await (await getUsage(relay.baseUrl, t)).json()) as {
      storedBytes: number;
    };
    expect(usageAfter.storedBytes).toBe(usageBefore.storedBytes);
  });

  // --- cursor monotonicity ---------------------------------------------------

  test("pull pages are seq-ordered and a later cursor never re-returns earlier events", async () => {
    const t = await createTestIdentity();
    const events = await makeEnvelopes(t, 6);
    await pushEvents(relay.baseUrl, t, events);

    const page1Res = await pullEvents(relay.baseUrl, t, "", { limit: 3 });
    const page1 = (await page1Res.json()) as {
      events: { eventId: string }[];
      nextCursor: string;
    };
    expect(page1.events).toHaveLength(3);

    const page2Res = await pullEvents(relay.baseUrl, t, page1.nextCursor, {
      limit: 3,
    });
    const page2 = (await page2Res.json()) as {
      events: { eventId: string }[];
      nextCursor: string;
    };
    expect(page2.events).toHaveLength(3);

    const page1Ids = new Set(page1.events.map((e) => e.eventId));
    for (const e of page2.events) {
      expect(page1Ids.has(e.eventId)).toBe(false);
    }
    expect(Number(page2.nextCursor)).toBeGreaterThan(Number(page1.nextCursor));

    // Re-pulling from page1's cursor must never return page1's own events again.
    const rePage1Res = await pullEvents(relay.baseUrl, t, page1.nextCursor);
    const rePage1 = (await rePage1Res.json()) as {
      events: { eventId: string }[];
    };
    for (const e of rePage1.events) {
      expect(page1Ids.has(e.eventId)).toBe(false);
    }
  });

  // --- oversized event -------------------------------------------------------

  test("an event exceeding the per-event byte limit is rejected with 413", async () => {
    const t = await createTestIdentity();
    const bigEvent = await makeEnvelope(t, {
      value: { body: "x".repeat(300 * 1024) }, // > default 256 KiB MAX_EVENT_BYTES
    });
    const res = await pushEvents(relay.baseUrl, t, [bigEvent]);
    expect(res.status).toBe(413);
    expect(await res.json()).toHaveProperty("error");
  });

  // --- quota -------------------------------------------------------------------

  test("pushing past the owner byte quota returns 413 with an error body", async () => {
    const t = await createTestIdentity();
    let lastStatus = 200;
    let accepted = 0;
    const maxAttempts = 200;
    for (let i = 0; i < maxAttempts && lastStatus === 200; i += 1) {
      const event = await makeEnvelope(t, {
        counter: i,
        rowId: `quota-row-${i}`,
        value: { body: "x".repeat(128) },
      });
      const res = await pushEvents(specialRelay.baseUrl, t, [event]);
      lastStatus = res.status;
      if (lastStatus === 200) {
        accepted += 1;
      } else {
        expect(res.status).toBe(413);
        expect(await res.json()).toHaveProperty("error");
      }
    }
    expect(lastStatus).toBe(413);

    const usage = (await (await getUsage(specialRelay.baseUrl, t)).json()) as {
      storedBytes: number;
    };
    expect(accepted).toBeGreaterThan(0);
    expect(usage.storedBytes).toBeGreaterThan(0);
  });

  // --- metric-label bound (supports plan 003) ---------------------------------

  // Plan 003 (merged) fixed this: routeLabel() in apps/relay-go/metrics.go now
  // collapses unmatched paths to a fixed "<other>" bucket, so an
  // unauthenticated GET /<raw-path> can no longer plant an arbitrary string
  // (or grow byEndpoint without bound) in the admin metrics. This was
  // `test.failing` while it documented the pre-003 bug; now that 003 has
  // landed it is a normal passing assertion (the anti-regression guard).
  test(
    "admin /stats byEndpoint does not leak an unauthenticated raw path as a label",
    async () => {
      const junkPath = "/junk/path/should-not-leak";
      await fetch(`${specialRelay.baseUrl}${junkPath}`);

      const statsRes = await fetch(
        `${specialRelay.baseUrl}${ADMIN_BASE}/stats`,
        { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } },
      );
      expect(statsRes.status).toBe(200);
      const stats = (await statsRes.json()) as {
        traffic: { byEndpoint: Record<string, number> };
      };
      const leaked = Object.keys(stats.traffic.byEndpoint).some((key) =>
        key.includes(junkPath),
      );
      expect(leaked).toBe(false);
    },
  );

  // --- blobs -----------------------------------------------------------------

  test("blob PUT with a mismatched hash is rejected with 400", async () => {
    const t = await createTestIdentity();
    const bytes = new TextEncoder().encode("hello world");
    const res = await putBlob(relay.baseUrl, t, "not-the-real-hash", bytes);
    expect(res.status).toBe(400);
  });

  test("blob PUT/GET/HEAD round-trip, and re-PUT reports duplicate", async () => {
    const t = await createTestIdentity();
    const bytes = new TextEncoder().encode(`hello blob ${Math.random()}`);
    const hash = await sha256Base64UrlBytes(bytes);

    const putRes = await putBlob(relay.baseUrl, t, hash, bytes);
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ stored: true, duplicate: false });

    const getRes = await getBlob(relay.baseUrl, t, hash);
    expect(getRes.status).toBe(200);
    const receivedBytes = new Uint8Array(await getRes.arrayBuffer());
    expect(receivedBytes).toEqual(bytes);

    const headRes = await headBlob(relay.baseUrl, t, hash);
    expect(headRes.status).toBe(200);

    const rePutRes = await putBlob(relay.baseUrl, t, hash, bytes);
    expect(rePutRes.status).toBe(200);
    expect(await rePutRes.json()).toEqual({ stored: false, duplicate: true });
  });

  // Plan 009 (SECURITY-03): the blob quota check now runs inside the same
  // locked transaction as the insert, instead of a
  // separate pre-transaction read. Driving true concurrent PUTs isn't
  // practical from this black-box HTTP suite, so this drives the check
  // sequentially against specialRelay's tiny quota: it can't observe the
  // race directly, but it does assert the cap is actually enforced (not just
  // pre-checked-and-ignored) and that a duplicate is never charged or
  // rejected even once the owner is over cap.
  test("blob PUT quota is enforced once the owner cap is hit; duplicates aren't charged", async () => {
    const t = await createTestIdentity();
    const chunkBytes = 512; // several chunks fit under TINY_OWNER_QUOTA_BYTES (4096)
    let lastStatus = 200;
    let stored = 0;
    let lastHash = "";
    let lastBytes = new Uint8Array();
    const maxAttempts = 20;

    for (let i = 0; i < maxAttempts && lastStatus === 200; i += 1) {
      const bytes = new TextEncoder().encode(
        `blob-quota-chunk-${i}-`.padEnd(chunkBytes, "x"),
      );
      const hash = await sha256Base64UrlBytes(bytes);
      const res = await putBlob(specialRelay.baseUrl, t, hash, bytes);
      lastStatus = res.status;
      if (lastStatus === 200) {
        const body = (await res.json()) as {
          stored: boolean;
          duplicate: boolean;
        };
        expect(body).toEqual({ stored: true, duplicate: false });
        stored += 1;
        lastHash = hash;
        lastBytes = bytes;
      } else {
        expect(res.status).toBe(413);
        expect(await res.json()).toHaveProperty("error");
      }
    }
    expect(lastStatus).toBe(413);
    expect(stored).toBeGreaterThan(0);

    const usageBefore = (
      await (await getUsage(specialRelay.baseUrl, t)).json()
    ) as { storedBytes: number };

    // A duplicate re-PUT of an already-stored chunk must succeed and must
    // not be charged, even though the owner is now at/over the cap.
    const rePutRes = await putBlob(specialRelay.baseUrl, t, lastHash, lastBytes);
    expect(rePutRes.status).toBe(200);
    expect(await rePutRes.json()).toEqual({ stored: false, duplicate: true });

    const usageAfter = (
      await (await getUsage(specialRelay.baseUrl, t)).json()
    ) as { storedBytes: number };
    expect(usageAfter.storedBytes).toBe(usageBefore.storedBytes);
  });
});

describe.each(kinds)("owner cap — %s", (kind) => {
  let capped: LaunchedRelay;

  beforeAll(async () => {
    capped = await launchRelay(kind, { MAX_OWNERS: "2" });
  }, 45_000);

  afterAll(async () => {
    await capped?.kill();
  });

  test("creating owners past MAX_OWNERS returns 503; existing owners still write", async () => {
    const a = await createTestIdentity();
    const b = await createTestIdentity();
    const c = await createTestIdentity();

    expect((await pushEvents(capped.baseUrl, a, [await makeEnvelope(a)])).status).toBe(200);
    expect((await pushEvents(capped.baseUrl, b, [await makeEnvelope(b)])).status).toBe(200);

    const third = await pushEvents(capped.baseUrl, c, [await makeEnvelope(c)]);
    expect(third.status).toBe(503);
    expect(await third.json()).toHaveProperty("error");

    const again = await pushEvents(capped.baseUrl, a, [
      await makeEnvelope(a, { counter: 1, rowId: "cap-row-2" }),
    ]);
    expect(again.status).toBe(200);
  });
});

describe.each(kinds)("rate limiting — %s", (kind) => {
  let apiLimited: LaunchedRelay;
  let writeLimited: LaunchedRelay;

  beforeAll(async () => {
    [apiLimited, writeLimited] = await Promise.all([
      launchRelay(kind, { RATE_LIMIT_API: "3" }),
      launchRelay(kind, { RATE_LIMIT_WRITE: "2" }),
    ]);
  }, 45_000);

  afterAll(async () => {
    await Promise.all([apiLimited?.kill(), writeLimited?.kill()]);
  });

  test("per-IP API limit returns 429 once exceeded; /health stays exempt", async () => {
    const t = await createTestIdentity();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await getStatus(apiLimited.baseUrl, t)).status);
    }
    expect(statuses).toContain(429);
    expect((await fetch(`${apiLimited.baseUrl}/health`)).status).toBe(200);
  });

  test("per-owner write limit returns 429 once exceeded", async () => {
    const t = await createTestIdentity();
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const res = await pushEvents(writeLimited.baseUrl, t, [
        await makeEnvelope(t, { counter: i, rowId: `rl-row-${i}` }),
      ]);
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(statuses).toContain(429);
  });
});

describe.each(kinds)("oversized body guard — %s", (kind) => {
  let tiny: LaunchedRelay;
  beforeAll(async () => {
    tiny = await launchRelay(kind, {
      MAX_EVENT_BYTES: "1024",
      MAX_EVENTS_PER_PUSH: "2",
    });
  }, 45_000);
  afterAll(async () => {
    await tiny?.kill();
  });

  test("a push body over MAX_EVENT_BYTES*MAX_EVENTS_PER_PUSH is rejected 413", async () => {
    const t = await createTestIdentity();
    const bigBody = JSON.stringify({
      ownerId: t.identity.ownerId,
      events: [{ pad: "x".repeat(8192) }],
    });
    const res = await fetch(`${tiny.baseUrl}/v1/events`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${t.identity.relayAuth}`,
      },
      body: bigBody,
    });
    expect(res.status).toBe(413);
  });
});

// ---------------------------------------------------------------------------
// Stream compaction (plan 017): client-driven tombstone GC. The owner names
// fully-purged streams via POST /v1/streams/compact and the relay drops every
// event of those streams — winners and tombstones included.
// ---------------------------------------------------------------------------

describe.each(kinds)("stream compaction — %s", (kind) => {
  let relay: LaunchedRelay;
  beforeAll(async () => {
    relay = await launchRelay(kind, { RATE_LIMIT_ENABLED: "false" });
  }, 45_000);
  afterAll(async () => {
    await relay?.kill();
  });

  const usedBytes = async (t: TestIdentity): Promise<number> => {
    const res = await getUsage(relay.baseUrl, t);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { storedBytes: number };
    return body.storedBytes;
  };

  test("compacting a stream removes all its events (updates + tombstone) and reclaims usage; survivors are untouched", async () => {
    const t = await createTestIdentity();
    const streamKey = t.identity.streamKey!;
    // Row A: three generations ending in a tombstone. Row B: one live event.
    const rowA = [
      await makeEnvelope(t, { rowId: "row-a", counter: 0 }),
      await makeEnvelope(t, { rowId: "row-a", counter: 1 }),
      await makeEnvelope(t, { rowId: "row-a", counter: 2, op: "delete" }),
    ];
    const rowB = await makeEnvelope(t, { rowId: "row-b", counter: 3 });
    const pushRes = await pushEvents(relay.baseUrl, t, [...rowA, rowB]);
    expect(pushRes.status).toBe(200);
    const before = await usedBytes(t);

    const streamA = await deriveStreamId(streamKey, "note", "row-a");
    const res = await compactStreams(relay.baseUrl, t, [streamA]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      deletedEvents: number;
      reclaimedBytes: number;
    };
    expect(body.deletedEvents).toBe(3);
    expect(body.reclaimedBytes).toBeGreaterThan(0);

    // Only row B survives, and usage dropped by exactly the reported bytes.
    const pullRes = await pullEvents(relay.baseUrl, t, "");
    const pullBody = (await pullRes.json()) as { events: { eventId: string }[] };
    expect(pullBody.events.map((e) => e.eventId)).toEqual([rowB.eventId]);
    expect(await usedBytes(t)).toBe(before - body.reclaimedBytes);
  });

  test("compaction is idempotent: unknown/already-compacted streams are a 200 no-op", async () => {
    const t = await createTestIdentity();
    const event = await makeEnvelope(t, { rowId: "row-x" });
    expect((await pushEvents(relay.baseUrl, t, [event])).status).toBe(200);

    const streamX = await deriveStreamId(t.identity.streamKey!, "note", "row-x");
    const first = await compactStreams(relay.baseUrl, t, [streamX]);
    expect(first.status).toBe(200);
    expect(((await first.json()) as { deletedEvents: number }).deletedEvents).toBe(1);

    const again = await compactStreams(relay.baseUrl, t, [streamX]);
    expect(again.status).toBe(200);
    expect((await again.json()) as object).toEqual({
      deletedEvents: 0,
      reclaimedBytes: 0,
    });
  });

  test("auth gating: missing bearer 401; wrong bearer 401; never creates an owner", async () => {
    const t = await createTestIdentity();
    const event = await makeEnvelope(t, { rowId: "row-y" });
    expect((await pushEvents(relay.baseUrl, t, [event])).status).toBe(200);
    const streamY = await deriveStreamId(t.identity.streamKey!, "note", "row-y");

    const noBearer = await fetch(`${relay.baseUrl}/v1/streams/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: t.identity.ownerId, streamIds: [streamY] }),
    });
    expect(noBearer.status).toBe(401);

    const wrongBearer = await compactStreams(relay.baseUrl, t, [streamY], {
      bearer: "not-the-real-token",
    });
    expect(wrongBearer.status).toBe(401);

    // An owner that never pushed must not be created by a compact call
    // (createIfMissing=false): expect a 4xx, not a silent 200.
    const fresh = await createTestIdentity();
    const freshStream = await deriveStreamId(
      fresh.identity.streamKey!,
      "note",
      "row-z",
    );
    const unknownOwner = await compactStreams(relay.baseUrl, fresh, [freshStream]);
    expect([401, 404]).toContain(unknownOwner.status);
    // ...and the compact must not have minted the owner as a side effect.
    expect((await getStatus(relay.baseUrl, fresh)).status).toBe(404);
  });

  test("malformed stream ids are rejected 400; over-limit batches 413", async () => {
    const t = await createTestIdentity();
    const event = await makeEnvelope(t);
    expect((await pushEvents(relay.baseUrl, t, [event])).status).toBe(200);

    for (const bad of ["", "short", "x".repeat(23), "has spaces spaces spac"]) {
      const res = await compactStreams(relay.baseUrl, t, [bad]);
      expect(res.status).toBe(400);
    }

    const tooMany = Array.from({ length: 1001 }, (_, i) =>
      `${i}`.padStart(22, "A"),
    );
    const res = await compactStreams(relay.baseUrl, t, tooMany);
    expect(res.status).toBe(413);
  });
});

afterAll(() => {
  cleanupGoBinary();
});
