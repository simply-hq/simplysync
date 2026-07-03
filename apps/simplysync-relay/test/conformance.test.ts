// Black-box HTTP conformance suite for the reference relays.
//
// All three relays (apps/simplysync-relay [Bun], apps/relay-go [Go],
// apps/relay-cloudflare [Cloudflare Workers + D1]) claim to be
// "wire-identical": same endpoints, same request/response shapes, same
// auth/quota semantics. Nothing tested that claim before this suite. This
// file boots the Bun and Go relays as real subprocesses (never importing
// their internals) and runs the identical assertions against each over
// plain HTTP, so a contract divergence shows up as a failure scoped to one
// relay's describe block instead of shipping silently.
//
// Cloudflare is NOT covered here (deferred, see plan 006 Step 4). Confirmed
// by an actual `wrangler dev --local` attempt against apps/relay-cloudflare,
// which hit two real blockers rather than just "seems hard":
//   1. `wrangler d1 migrations apply --local` and `wrangler dev` don't share
//      local D1 state unless sequenced/persisted carefully — a `dev` started
//      before migrations are applied gets "no such table: owners" on every
//      request, and applying migrations after requires restarting `dev`.
//   2. apps/relay-cloudflare/migrations/0002_stream_id.sql unconditionally
//      does `alter table events add column stream_id text`, but
//      0001_init.sql already creates that column — migration 0002 fails with
//      "duplicate column name: stream_id" on any fresh local D1. (A
//      CF-specific migration bug, out of scope here — not touched.)
// The three `unsafe.bindings` ratelimit bindings also report Mode: "remote"
// even under `--local`, i.e. real network/Cloudflare-API access, which is a
// poor fit for a hermetic test process. Booting this headlessly in CI is a
// real project, not a small addition — hence deferred rather than attempted
// further here.
//
// Envelopes are generated with the real @simplysync/protocol crypto
// (deriveIdentity -> encryptPayload), not hand-built JSON, so pushes exercise
// the same envelope shape a real client sends.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sha256Base64UrlBytes } from "@simplysync/protocol";
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
} from "./conformance/envelopes";
import {
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

const goAvailable = isGoAvailable();
if (!goAvailable) {
  console.warn(
    "[conformance] `go` was not found on PATH — skipping the Go relay leg " +
      "of the conformance suite (Bun leg still runs).",
  );
}

const kinds: RelayKind[] = goAvailable ? ["bun", "go"] : ["bun"];

// Populated by the quota test for each relay kind, compared once both legs
// have run (see the "cross-relay comparison" describe block below). Plan 009
// aligned the byte-accounting basis across all three relays (raw received
// envelope bytes, mirroring relay-go's `len(ev.raw)`) — the JS relays'
// re-serialization is byte-identical to that for compliant canonical
// envelopes — so the comparison below now asserts equality rather than only
// logging a delta.
const quotaFindings: Partial<
  Record<RelayKind, { pushesAccepted: number; usedBytesAtFailure: number }>
> = {};

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
    quotaFindings[kind] = {
      pushesAccepted: accepted,
      usedBytesAtFailure: usage.storedBytes,
    };
  });

  // --- metric-label bound (supports plan 003) ---------------------------------

  // Plan 003 (merged) fixed this: routeLabel() in both
  // apps/simplysync-relay/src/metrics.ts and apps/relay-go/metrics.go now
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
  // locked transaction as the insert on both Go and Bun, instead of a
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

afterAll(() => {
  cleanupGoBinary();
});

// ---------------------------------------------------------------------------
// Cross-relay comparison. Declared after describe.each above so it executes
// once both relay legs have finished (bun:test runs top-level blocks in
// declaration order) and quotaFindings is fully populated.
// ---------------------------------------------------------------------------

describe("cross-relay comparison", () => {
  test("quota accounting (pushesAccepted, usedBytes) is identical across relays", () => {
    const entries = Object.entries(quotaFindings) as [
      RelayKind,
      { pushesAccepted: number; usedBytesAtFailure: number },
    ][];
    if (entries.length < 2) {
      console.log(
        "[conformance] only one relay leg ran — nothing to cross-compare.",
      );
      expect(entries.length).toBeGreaterThan(0);
      return;
    }
    // Plan 009 aligned the byte-accounting basis (raw received envelope
    // bytes) across all three relays, so an identical push sequence must now
    // produce identical quota accounting — a divergence here is a real
    // regression, not an expected implementation difference.
    const [[kindA, a], [kindB, b]] = entries;
    console.log(
      `[conformance] quota accounting for ${kindA} vs ${kindB}: ` +
        `${JSON.stringify(a)} / ${JSON.stringify(b)}`,
    );
    expect(a.pushesAccepted).toBe(b.pushesAccepted);
    expect(a.usedBytesAtFailure).toBe(b.usedBytesAtFailure);
  });
});
