// The relay HTTP contract, asserted of EVERY implementation.
//
// One block per adapter (see conformance/adapters.ts), so an assertion written
// once is proven of both relays: the Go relay as a real subprocess, the
// Cloudflare relay under `wrangler dev --local` (miniflare: local D1 + R2, no
// network, no account). Neither is imported — every call below is a plain
// fetch(), so a divergence shows up here the way it would to a client.
//
// Behaviour only ONE implementation has is deliberately not in this file. It
// lives as a named, pinned exception in cross-relay.test.ts. If an assertion
// here would have to know which relay it is talking to, it belongs there.
//
// Envelopes are generated with the real @simplysync/protocol crypto
// (deriveIdentity -> encryptPayload), not hand-built JSON, so pushes exercise
// the same envelope shape a real client sends.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  deriveStreamId,
  HLC_MAX_FUTURE_DRIFT_MS,
  sha256Base64UrlBytes,
  type SyncEnvelope,
} from "@simplysync/protocol";
import {
  implementations,
  killAll,
  TINY_BLOB_BYTES,
  type BootedRelays,
} from "./conformance/adapters";
import { cleanupGoBinary } from "./conformance/launch-relay";
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

// Cloudflare's first boot on a machine may have to fetch and unpack workerd.
const BOOT_MS = 240_000;

// --- reads, phrased the way a client would phrase them ----------------------

interface PullBody {
  readonly events: SyncEnvelope[];
  readonly nextCursor: string;
}

async function pull(
  base: string,
  who: TestIdentity,
  after = "",
  limit?: number,
): Promise<PullBody> {
  const res = await pullEvents(base, who, after, { limit });
  expect(res.status).toBe(200);
  return (await res.json()) as PullBody;
}

async function eventIds(base: string, who: TestIdentity): Promise<string[]> {
  return (await pull(base, who)).events.map((event) => event.eventId);
}

async function storedBytes(base: string, who: TestIdentity): Promise<number> {
  const res = await getUsage(base, who);
  expect(res.status).toBe(200);
  return ((await res.json()) as { storedBytes: number }).storedBytes;
}

/** A fresh owner with `count` events already pushed. */
async function seed(
  base: string,
  count = 3,
): Promise<{ who: TestIdentity; events: SyncEnvelope[] }> {
  const who = await createTestIdentity();
  const events = await makeEnvelopes(who, count);
  const res = await pushEvents(base, who, events);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ accepted: count, duplicate: 0 });
  return { who, events };
}

/**
 * Spend a limiter's budget until it answers 429, in parallel waves.
 *
 * Sequential requests are wrong here — both relays count in a fixed window, so
 * a slow loop rolls into the next one and never trips. But a single wave sized
 * to the budget is not enough either: an implementation whose budget cannot be
 * shrunk to test size (Cloudflare's limits are bindings, not vars) leaves only
 * a few requests of headroom, and a locally-simulated limiter that is a little
 * lenient never answers. Waves keep the whole attempt inside one window while
 * giving a lenient limiter several times its budget to react, and stop the
 * moment it does.
 */
async function spendUntilRateLimited(
  budget: number,
  wave: (size: number, waveIndex: number) => Promise<Response[]>,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < 3 && !statuses.includes(429); i += 1) {
    const responses = await wave(budget + 10, i);
    statuses.push(...responses.map((res) => res.status));
  }
  return statuses;
}

/** The stream ids of a `makeEnvelopes` batch — one per row, in push order. */
async function streamIdsOf(
  who: TestIdentity,
  count: number,
): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      deriveStreamId(who.identity.streamKey!, "note", `row-${i}`),
    ),
  );
}

for (const adapter of implementations()) {
  describe(`relay contract — ${adapter.name}`, () => {
    let relays: BootedRelays;
    const base = () => relays.base.baseUrl;

    beforeAll(async () => {
      relays = await adapter.boot();
    }, BOOT_MS);

    afterAll(async () => {
      await killAll(relays);
    });

    // --- health + auth gating ---------------------------------------------

    test("GET /health returns 200 with a version field", async () => {
      const res = await fetch(`${base()}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: unknown; version: unknown };
      expect(body.ok).toBe(true);
      expect(typeof body.version).toBe("string");
    });

    test("a request with no Authorization header is rejected", async () => {
      const res = await fetch(`${base()}/v1/events?ownerId=nobody`);
      expect(res.status).toBe(401);
    });

    test("an owner that never pushed is unknown to status, usage and pull", async () => {
      // 404 rather than 401 is load-bearing: a client reads it as "relay up,
      // account empty", which is how it tells a wiped relay from a bad key.
      const who = await createTestIdentity();
      expect((await getStatus(base(), who)).status).toBe(404);
      expect((await getUsage(base(), who)).status).toBe(404);
      expect((await pullEvents(base(), who, "")).status).toBe(404);
    });

    test("a wrong bearer token for an existing owner returns 401", async () => {
      const { who } = await seed(base(), 1); // owner created trust-on-first-use
      const res = await getStatus(base(), who, { bearer: "not-the-real-token" });
      expect(res.status).toBe(401);
    });

    // --- push / pull round-trip -------------------------------------------

    test("push then pull returns the same events in the same order, plus a stable cursor", async () => {
      const { who, events } = await seed(base(), 5);
      const body = await pull(base(), who);
      expect(body.events.map((event) => event.eventId)).toEqual(
        events.map((event) => event.eventId),
      );
      expect(body.nextCursor).not.toBe("");
      // The cursor is opaque to a client but must be stable: pulling from it
      // returns nothing and echoes it back rather than rewinding.
      const tail = await pull(base(), who, body.nextCursor);
      expect(tail.events).toEqual([]);
      expect(tail.nextCursor).toBe(body.nextCursor);
    });

    test("pull pages are ordered and a later cursor never re-returns earlier events", async () => {
      const { who } = await seed(base(), 6);

      const page1 = await pull(base(), who, "", 3);
      expect(page1.events).toHaveLength(3);
      const page2 = await pull(base(), who, page1.nextCursor, 3);
      expect(page2.events).toHaveLength(3);

      const seen = new Set(page1.events.map((event) => event.eventId));
      for (const event of page2.events) expect(seen.has(event.eventId)).toBe(false);
      expect(Number(page2.nextCursor)).toBeGreaterThan(Number(page1.nextCursor));

      const rePage = await pull(base(), who, page1.nextCursor);
      for (const event of rePage.events) expect(seen.has(event.eventId)).toBe(false);
    });

    test("an uninterpretable cursor reads from the beginning, it does not error", async () => {
      // Matters for a device whose stored cursor predates the current cursor
      // format: it must re-pull (the seen-set dedupes) rather than stall.
      const { who, events } = await seed(base());
      const body = await pull(base(), who, "not-a-cursor");
      expect(body.events.map((event) => event.eventId)).toEqual(
        events.map((event) => event.eventId),
      );
    });

    test("push rejects malformed and future HLC event ids", async () => {
      const malformedOwner = await createTestIdentity();
      const malformed = await makeEnvelope(malformedOwner);
      expect(
        (
          await pushEvents(base(), malformedOwner, [
            { ...malformed, eventId: "not-an-hlc" },
          ])
        ).status,
      ).toBe(400);

      const futureOwner = await createTestIdentity();
      const future = await makeEnvelope(futureOwner, {
        now: Date.now() + HLC_MAX_FUTURE_DRIFT_MS + 60_000,
      });
      expect((await pushEvents(base(), futureOwner, [future])).status).toBe(400);
    });

    test("re-pushing the same events is idempotent and free", async () => {
      const { who, events } = await seed(base(), 4);
      const before = await storedBytes(base(), who);

      const again = await pushEvents(base(), who, events);
      expect(await again.json()).toEqual({ accepted: 0, duplicate: 4 });
      expect(await storedBytes(base(), who)).toBe(before);
      expect(await eventIds(base(), who)).toHaveLength(4);
    });

    // --- ceilings ----------------------------------------------------------

    test("an event over the per-event byte limit is rejected with 413", async () => {
      const who = await createTestIdentity();
      const big = await makeEnvelope(who, {
        value: { body: "x".repeat(300 * 1024) }, // > the 256 KiB default
      });
      const res = await pushEvents(base(), who, [big]);
      expect(res.status).toBe(413);
      expect(await res.json()).toHaveProperty("error");
    });

    test("a push body over the declared ceiling is rejected 413 by Content-Length", async () => {
      const who = await createTestIdentity();
      const res = await fetch(`${relays.tinyBody.baseUrl}/v1/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${who.identity.relayAuth}`,
        },
        body: JSON.stringify({
          ownerId: who.identity.ownerId,
          events: [{ pad: "x".repeat(8192) }],
        }),
      });
      expect(res.status).toBe(413);
    });

    test("pushing past the owner quota 413s, but re-pushing what the relay already holds never does", async () => {
      // An idempotent retry is exactly what a flaky network produces: a
      // duplicate stores nothing, so it is charged nothing and must not be
      // rejected either — not even by an owner sitting exactly at the cap.
      const quota = relays.tinyQuota.baseUrl;
      const who = await createTestIdentity();
      const stored: SyncEnvelope[] = [];
      let status = 200;
      for (let i = 0; i < 200 && status === 200; i += 1) {
        const event = await makeEnvelope(who, {
          counter: i,
          rowId: `quota-row-${i}`,
          value: { body: "x".repeat(128) },
        });
        const res = await pushEvents(quota, who, [event]);
        status = res.status;
        if (status === 200) {
          stored.push(event);
        } else {
          expect(status).toBe(413);
          expect(await res.json()).toHaveProperty("error");
        }
      }
      expect(status).toBe(413);
      expect(stored.length).toBeGreaterThan(0);

      const before = await storedBytes(quota, who);
      expect(before).toBeGreaterThan(0);

      const again = await pushEvents(quota, who, stored);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({
        accepted: 0,
        duplicate: stored.length,
      });
      expect(await storedBytes(quota, who)).toBe(before);
    });

    test("creating owners past the fleet cap returns 503; existing owners still write", async () => {
      const capped = relays.ownerCap.baseUrl;
      const [a, b, c] = await Promise.all([
        createTestIdentity(),
        createTestIdentity(),
        createTestIdentity(),
      ]);

      expect((await pushEvents(capped, a!, [await makeEnvelope(a!)])).status).toBe(200);
      expect((await pushEvents(capped, b!, [await makeEnvelope(b!)])).status).toBe(200);

      const third = await pushEvents(capped, c!, [await makeEnvelope(c!)]);
      expect(third.status).toBe(503);
      expect(await third.json()).toHaveProperty("error");

      // A full relay still serves the owners it already has.
      const again = await pushEvents(capped, a!, [
        await makeEnvelope(a!, { counter: 1, rowId: "cap-row-2" }),
      ]);
      expect(again.status).toBe(200);
    });

    // --- rate limits -------------------------------------------------------

    test("the per-IP request budget returns 429 once exceeded; /health stays exempt", async () => {
      const limited = relays.apiLimited.baseUrl;
      const { who } = await seed(limited, 1);
      const statuses = await spendUntilRateLimited(adapter.limits.api, (size) =>
        Promise.all(Array.from({ length: size }, () => getStatus(limited, who))),
      );
      expect(statuses).toContain(429);
      // Health must stay free, or a limiter turns into an outage detector's
      // blind spot.
      expect((await fetch(`${limited}/health`)).status).toBe(200);
    });

    test("the per-owner write budget returns 429 once exceeded", async () => {
      const limited = relays.writeLimited.baseUrl;
      // Seed first: an owner that doesn't exist yet spends the *creation*
      // budget instead, which is a different limiter.
      const { who } = await seed(limited, 1);
      // Each wave mints fresh events (a later `now` gives new HLCs, hence new
      // event ids): a re-push would be a duplicate, which is accounted
      // differently and would not prove the write budget. Minting happens
      // before the wave fires, so the whole spend still lands in one window.
      const statuses = await spendUntilRateLimited(
        adapter.limits.write,
        async (size, waveIndex) => {
          const events = await makeEnvelopes(who, size, {
            now: Date.now() + waveIndex,
          });
          return Promise.all(
            events.map((event) => pushEvents(limited, who, [event])),
          );
        },
      );
      expect(statuses.filter((status) => status === 200).length).toBeGreaterThanOrEqual(1);
      expect(statuses).toContain(429);
    });

    // --- blobs -------------------------------------------------------------

    test("a blob PUT whose bytes don't match the path hash is rejected 400", async () => {
      const who = await createTestIdentity();
      const bytes = new TextEncoder().encode("hello world");
      const res = await putBlob(base(), who, "not-the-real-hash", bytes);
      expect(res.status).toBe(400);
    });

    test("blob PUT/GET/HEAD round-trip, and a re-PUT reports duplicate", async () => {
      const who = await createTestIdentity();
      const bytes = new TextEncoder().encode(`hello blob ${Math.random()}`);
      const hash = await sha256Base64UrlBytes(bytes);

      const put = await putBlob(base(), who, hash, bytes);
      expect(put.status).toBe(200);
      expect(await put.json()).toEqual({ stored: true, duplicate: false });

      const get = await getBlob(base(), who, hash);
      expect(get.status).toBe(200);
      expect(new Uint8Array(await get.arrayBuffer())).toEqual(bytes);

      expect((await headBlob(base(), who, hash)).status).toBe(200);

      const rePut = await putBlob(base(), who, hash, bytes);
      expect(rePut.status).toBe(200);
      expect(await rePut.json()).toEqual({ stored: false, duplicate: true });
    });

    test("blob PUTs are charged against the owner quota; duplicates are not", async () => {
      const quota = relays.tinyQuota.baseUrl;
      const who = await createTestIdentity();
      const chunkBytes = TINY_BLOB_BYTES / 2; // several fit under the quota
      let status = 200;
      let stored = 0;
      let lastHash = "";
      let lastBytes = new Uint8Array();

      for (let i = 0; i < 20 && status === 200; i += 1) {
        const bytes = new TextEncoder().encode(
          `blob-quota-chunk-${i}-`.padEnd(chunkBytes, "x"),
        );
        const hash = await sha256Base64UrlBytes(bytes);
        const res = await putBlob(quota, who, hash, bytes);
        status = res.status;
        if (status === 200) {
          expect(await res.json()).toEqual({ stored: true, duplicate: false });
          stored += 1;
          lastHash = hash;
          lastBytes = bytes;
        } else {
          expect(status).toBe(413);
          expect(await res.json()).toHaveProperty("error");
        }
      }
      expect(status).toBe(413);
      expect(stored).toBeGreaterThan(0);

      // A duplicate of an already-stored chunk must still succeed, and still
      // cost nothing, even though the owner is now at the cap.
      const before = await storedBytes(quota, who);
      const rePut = await putBlob(quota, who, lastHash, lastBytes);
      expect(rePut.status).toBe(200);
      expect(await rePut.json()).toEqual({ stored: false, duplicate: true });
      expect(await storedBytes(quota, who)).toBe(before);
    });

    test("an oversized blob PUT from an unknown owner is rejected without creating the owner", async () => {
      // Size has to be judged before trust-on-first-use creates the owner:
      // a chunk that can only ever be rejected must not mint an owner row and
      // spend the relay's global fleet budget.
      const quota = relays.tinyQuota.baseUrl;
      const who = await createTestIdentity();
      const bytes = new Uint8Array(TINY_BLOB_BYTES * 4);
      const res = await putBlob(quota, who, await sha256Base64UrlBytes(bytes), bytes);
      expect(res.status).toBe(413);

      // Still unknown: nothing was created on the way to that 413.
      expect((await getStatus(quota, who)).status).toBe(404);
      expect((await pullEvents(quota, who, "")).status).toBe(404);
    });

    // --- stream compaction (client-driven tombstone GC) --------------------

    test("compacting a stream drops all its events and reclaims usage; survivors are untouched", async () => {
      const who = await createTestIdentity();
      // Row A: three generations ending in a tombstone. Row B: one live event.
      const rowA = [
        await makeEnvelope(who, { rowId: "row-a", counter: 0 }),
        await makeEnvelope(who, { rowId: "row-a", counter: 1 }),
        await makeEnvelope(who, { rowId: "row-a", counter: 2, op: "delete" }),
      ];
      const rowB = await makeEnvelope(who, { rowId: "row-b", counter: 3 });
      expect((await pushEvents(base(), who, [...rowA, rowB])).status).toBe(200);
      const before = await storedBytes(base(), who);

      const streamA = await deriveStreamId(
        who.identity.streamKey!,
        "note",
        "row-a",
      );
      const res = await compactStreams(base(), who, [streamA]);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deletedEvents: number;
        reclaimedBytes: number;
      };
      expect(body.deletedEvents).toBe(3);
      expect(body.reclaimedBytes).toBeGreaterThan(0);

      expect(await eventIds(base(), who)).toEqual([rowB.eventId]);
      expect(await storedBytes(base(), who)).toBe(before - body.reclaimedBytes);
    });

    test("compaction is idempotent: an unknown or already-compacted stream is a 200 no-op", async () => {
      const who = await createTestIdentity();
      expect(
        (await pushEvents(base(), who, [await makeEnvelope(who, { rowId: "row-x" })]))
          .status,
      ).toBe(200);

      const streamX = await deriveStreamId(
        who.identity.streamKey!,
        "note",
        "row-x",
      );
      const first = await compactStreams(base(), who, [streamX]);
      expect(first.status).toBe(200);
      expect(((await first.json()) as { deletedEvents: number }).deletedEvents).toBe(1);

      const again = await compactStreams(base(), who, [streamX]);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual({
        deletedEvents: 0,
        reclaimedBytes: 0,
      });
    });

    test("compacting more streams than fit in one write drops every one of them", async () => {
      // 100 streams is over the chunk size the Cloudflare relay has to split
      // its statements at (D1 caps bound parameters), so this is what proves
      // the chunked path still behaves as one compaction.
      const count = 100;
      const { who } = await seed(base(), count);
      const streams = await streamIdsOf(who, count);

      const res = await compactStreams(base(), who, streams);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        deletedEvents: number;
        reclaimedBytes: number;
      };
      expect(body.deletedEvents).toBe(count);
      expect(body.reclaimedBytes).toBeGreaterThan(0);
      expect(await eventIds(base(), who)).toEqual([]);
      expect(await storedBytes(base(), who)).toBe(0);
    });

    test("compact auth gating: missing bearer 401, wrong bearer 401, and it never creates an owner", async () => {
      const { who } = await seed(base(), 1);
      const stream = (await streamIdsOf(who, 1))[0]!;

      const noBearer = await fetch(`${base()}/v1/streams/compact`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerId: who.identity.ownerId,
          streamIds: [stream],
        }),
      });
      expect(noBearer.status).toBe(401);

      const wrongBearer = await compactStreams(base(), who, [stream], {
        bearer: "not-the-real-token",
      });
      expect(wrongBearer.status).toBe(401);

      // Purging is never a reason to create an owner.
      const fresh = await createTestIdentity();
      const freshStream = (await streamIdsOf(fresh, 1))[0]!;
      const unknown = await compactStreams(base(), fresh, [freshStream]);
      expect([401, 404]).toContain(unknown.status);
      expect((await getStatus(base(), fresh)).status).toBe(404);
    });

    test("malformed stream ids are rejected 400; an over-limit batch 413", async () => {
      const { who } = await seed(base(), 1);

      for (const bad of ["", "short", "x".repeat(23), "has spaces spaces spac"]) {
        expect((await compactStreams(base(), who, [bad])).status).toBe(400);
      }

      const tooMany = Array.from({ length: 1001 }, (_, i) =>
        `${i}`.padStart(22, "A"),
      );
      expect((await compactStreams(base(), who, tooMany)).status).toBe(413);
    });

    // --- recovery ----------------------------------------------------------

    test(
      "a wiped relay forgets the owner, and a re-push restores it fully",
      async () => {
        // "Wiped" = the same relay after a lost volume, a fresh deploy, or a
        // restore from before this owner existed: the device still holds the
        // recovery key, the relay holds nothing.
        const { who, events } = await seed(base());

        const wiped = await adapter.launchEmpty();
        try {
          expect((await getStatus(wiped.baseUrl, who)).status).toBe(404);
          expect((await pullEvents(wiped.baseUrl, who, "")).status).toBe(404);

          // Re-seeding from the device is the whole recovery path.
          expect((await pushEvents(wiped.baseUrl, who, events)).status).toBe(200);
          expect(await eventIds(wiped.baseUrl, who)).toEqual(
            events.map((event) => event.eventId),
          );
        } finally {
          await wiped.kill();
        }
      },
      BOOT_MS,
    );
  });
}

afterAll(() => {
  cleanupGoBinary();
});
