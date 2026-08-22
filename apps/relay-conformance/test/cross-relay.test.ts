// Cross-relay conformance: the same black-box HTTP contract driven against
// BOTH relay implementations, plus the edge cases a real deployment hits when
// an owner's data is reset or moved between them.
//
// `conformance.test.ts` pins the Go relay alone. Two adapters sit at the relay
// seam, so the contract has to be asserted of both or it isn't a contract —
// and the divergences at the bottom of this file are what that gap was hiding.
//
// Cloudflare runs under `wrangler dev --local` (miniflare: local D1 + R2, no
// network, no account). If wrangler isn't installed the cross-relay and
// Cloudflare blocks skip rather than fail, so this suite stays runnable on a
// machine that only has Go.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SyncEnvelope } from "@simplysync/protocol";
import {
  cleanupGoBinary,
  isGoAvailable,
  launchRelay,
  type LaunchedRelay,
} from "./conformance/launch-relay";
import {
  isWranglerAvailable,
  launchCloudflareRelay,
} from "./conformance/launch-cloudflare";
import {
  createTestIdentity,
  makeEnvelopes,
  type TestIdentity,
} from "./conformance/envelopes";
import { getStatus, pullEvents, pushEvents } from "./conformance/http";

const CLOUDFLARE = isWranglerAvailable();
const BOOT_MS = 240_000;

if (!isGoAvailable()) {
  throw new Error("[cross-relay] `go` was not found on PATH");
}

let go: LaunchedRelay;
let cf: LaunchedRelay | undefined;

beforeAll(async () => {
  go = await launchRelay({ RATE_LIMIT_ENABLED: "false" });
  if (CLOUDFLARE) cf = await launchCloudflareRelay();
}, BOOT_MS);

afterAll(async () => {
  await Promise.all([go?.kill(), cf?.kill()]);
  cleanupGoBinary();
});

// --- helpers ---------------------------------------------------------------

// Every test owner is a different client. Cloudflare keys its owner-creation
// limiter (5/min) on CF-Connecting-IP, which `wrangler dev` never sets, so
// without this the whole suite shares one budget and 429s partway through.
// Go ignores the header, so the Go half is unaffected.
function ipFor(who: TestIdentity): string {
  const id = who.identity.ownerId;
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `10.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`;
}

const push = (base: string, who: TestIdentity, events: readonly SyncEnvelope[]) =>
  pushEvents(base, who, events as SyncEnvelope[], { ip: ipFor(who) });

const pullRaw = (base: string, who: TestIdentity, after: string) =>
  pullEvents(base, who, after, { ip: ipFor(who) });

const status = (base: string, who: TestIdentity) =>
  getStatus(base, who, { ip: ipFor(who) });

interface PullBody {
  readonly events: SyncEnvelope[];
  readonly nextCursor: string;
}

async function pull(base: string, who: TestIdentity, after = ""): Promise<PullBody> {
  const res = await pullRaw(base, who, after);
  expect(res.status).toBe(200);
  return (await res.json()) as PullBody;
}

async function eventIds(base: string, who: TestIdentity): Promise<string[]> {
  return (await pull(base, who)).events.map((e) => e.eventId);
}

async function usedBytes(base: string, who: TestIdentity): Promise<number> {
  const body = (await (await status(base, who)).json()) as {
    account?: { usedBytes?: number };
  };
  return body.account?.usedBytes ?? -1;
}

async function seed(
  base: string,
  count = 3,
): Promise<{ who: TestIdentity; events: SyncEnvelope[] }> {
  const who = await createTestIdentity();
  const events = await makeEnvelopes(who, count);
  expect((await push(base, who, events)).status).toBe(200);
  return { who, events };
}

/** Each implementation, so one `test.each`-style block asserts both. */
function implementations(): { name: string; base: () => string }[] {
  const list = [{ name: "go", base: () => go.baseUrl }];
  if (CLOUDFLARE) list.push({ name: "cloudflare", base: () => cf!.baseUrl });
  return list;
}

// --- contract parity -------------------------------------------------------

for (const impl of implementations()) {
  describe(`relay contract — ${impl.name}`, () => {
    test("an owner that never pushed is unknown to both status and pull", async () => {
      const who = await createTestIdentity();
      expect((await status(impl.base(), who)).status).toBe(404);
      expect((await pullRaw(impl.base(), who, "")).status).toBe(404);
    });

    test("push then pull returns the same events in the same order", async () => {
      const { who, events } = await seed(impl.base());
      const body = await pull(impl.base(), who);
      expect(body.events.map((e) => e.eventId)).toEqual(
        events.map((e) => e.eventId),
      );
      // The cursor is opaque to a client but must be stable: pulling from it
      // returns nothing and echoes it back rather than rewinding.
      const tail = await pull(impl.base(), who, body.nextCursor);
      expect(tail.events).toEqual([]);
      expect(tail.nextCursor).toBe(body.nextCursor);
    });

    test("re-pushing the same events is idempotent and free", async () => {
      const { who, events } = await seed(impl.base());
      const before = await usedBytes(impl.base(), who);

      const again = await push(impl.base(), who, events);
      expect(await again.json()).toEqual({ accepted: 0, duplicate: events.length });
      expect(await usedBytes(impl.base(), who)).toBe(before);
      expect((await eventIds(impl.base(), who)).length).toBe(events.length);
    });

    test("an uninterpretable cursor reads from the beginning, it does not error", async () => {
      // Matters for a device whose stored cursor predates the current cursor
      // format: it must re-pull (the seen-set dedupes) rather than stall.
      const { who, events } = await seed(impl.base());
      const body = await pull(impl.base(), who, "not-a-cursor");
      expect(body.events.map((e) => e.eventId)).toEqual(
        events.map((e) => e.eventId),
      );
    });

    test("a wiped relay forgets the owner, and a re-push restores it fully", async () => {
      // "Wiped" = the same relay after a lost volume, a fresh deploy, or a
      // restore from before this owner existed: the client still holds the
      // recovery key, the relay holds nothing.
      const { who, events } = await seed(impl.base());
      expect((await eventIds(impl.base(), who)).length).toBe(events.length);

      const wiped =
        impl.name === "go"
          ? await launchRelay({ RATE_LIMIT_ENABLED: "false" })
          : await launchCloudflareRelay();
      try {
        expect((await status(wiped.baseUrl, who)).status).toBe(404);
        expect((await pullRaw(wiped.baseUrl, who, "")).status).toBe(404);

        // Re-seeding from the device is the whole recovery path.
        expect((await push(wiped.baseUrl, who, events)).status).toBe(200);
        expect(await eventIds(wiped.baseUrl, who)).toEqual(
          events.map((e) => e.eventId),
        );
      } finally {
        await wiped.kill();
      }
    }, BOOT_MS);
  });
}

// --- moving an owner between implementations -------------------------------

describe.skipIf(!CLOUDFLARE)("migrating an owner between relays", () => {
  test("the same owner reads back identically from Go and Cloudflare", async () => {
    const who = await createTestIdentity();
    const events = await makeEnvelopes(who, 4);

    expect((await push(go.baseUrl, who, events)).status).toBe(200);
    expect((await push(cf!.baseUrl, who, events)).status).toBe(200);

    const fromGo = await pull(go.baseUrl, who);
    const fromCf = await pull(cf!.baseUrl, who);

    // Byte-identical envelopes, same order: a device can switch relays without
    // its local state meaning anything different.
    expect(fromCf.events).toEqual(fromGo.events);
    // ...and both charge the owner the same, so a migration doesn't silently
    // change how close they are to quota.
    expect(await usedBytes(cf!.baseUrl, who)).toBe(
      await usedBytes(go.baseUrl, who),
    );
  });

  test("a cursor from one relay silently SKIPS events on the other", async () => {
    // Why the engine keys pull cursors by relay base URL. A cursor is a
    // per-relay sequence position, not a position in the owner's log, so
    // carrying one across relays loses every event the new relay numbered at
    // or below it — with a 200 and no error anywhere.
    //
    // The dangerous shape in production is swapping the implementation BEHIND
    // an unchanged URL: the engine reuses the cursor, the push re-creates the
    // owner so pull never 404s, and its wipe detection never fires.
    const who = await createTestIdentity();
    const events = await makeEnvelopes(who, 4);
    expect((await push(go.baseUrl, who, events)).status).toBe(200);
    const goCursor = (await pull(go.baseUrl, who)).nextCursor;

    expect((await push(cf!.baseUrl, who, events)).status).toBe(200);
    const honest = await pull(cf!.baseUrl, who);
    expect(honest.events.length).toBe(4);

    const carried = await pull(cf!.baseUrl, who, goCursor);
    expect(carried.events.length).toBeLessThan(honest.events.length);
  });
});

// --- known divergences -----------------------------------------------------
//
// Asserted as they behave TODAY so a fix has to change this file deliberately
// rather than drift. Each names the risk.

describe.skipIf(!CLOUDFLARE)("divergences between the implementations", () => {
  test("a null streamId: Go accepts it, Cloudflare rejects it", async () => {
    // Same request, two answers. A client that works against one relay can be
    // rejected wholesale by the other.
    const mk = async () => {
      const who = await createTestIdentity();
      const [event] = await makeEnvelopes(who, 1);
      return { who, event: { ...event!, streamId: null } as never };
    };
    const a = await mk();
    expect((await push(go.baseUrl, a.who, [a.event])).status).toBe(200);
    const b = await mk();
    expect((await push(cf!.baseUrl, b.who, [b.event])).status).toBe(400);
  });

  test("neither relay applies the streamId shape rule on push", async () => {
    // Both enforce it on /v1/streams/compact and neither on the push path, so
    // a stream id that could never be produced by the protocol is storable.
    for (const impl of implementations()) {
      const who = await createTestIdentity();
      const [event] = await makeEnvelopes(who, 1);
      const res = await push(impl.base(), who, [
        { ...event!, streamId: "x" },
      ]);
      expect([impl.name, res.status]).toEqual([impl.name, 200]);
    }
  });

  test("an empty streamId destroys an owner's log on Cloudflare, not on Go", async () => {
    // The defect this whole file exists to catch. Go normalises "" to SQL NULL
    // and compaction skips NULL streams. Cloudflare stores the empty string,
    // and '' IS NOT NULL — so every event with an empty streamId is treated as
    // ONE stream and the 6-hourly cron keeps only the highest event id.
    //
    // Fix is two lines in apps/relay-cloudflare/src/index.ts: reuse the
    // existing STREAM_ID_SHAPE regex in validateEnvelope's push path, and
    // store `streamId || null` instead of `streamId ?? null`.
    const blank = async (base: string) => {
      const who = await createTestIdentity();
      const events = (await makeEnvelopes(who, 3)).map((e) => ({
        ...e,
        streamId: "",
      }));
      expect((await push(base, who, events)).status).toBe(200);
      return who;
    };

    const goWho = await blank(go.baseUrl);
    const goStatus = (await (await status(go.baseUrl, goWho)).json()) as {
      account?: { streams?: number };
    };
    expect(goStatus.account?.streams).toBe(0); // NULL: not a stream at all

    const cfWho = await blank(cf!.baseUrl);
    const cfStatus = (await (await status(cf!.baseUrl, cfWho)).json()) as {
      account?: { streams?: number };
    };
    expect(cfStatus.account?.streams).toBe(1); // three distinct rows, one stream

    // Run the compaction cron on demand (--test-scheduled).
    const cron = await fetch(`${cf!.baseUrl}/__scheduled?cron=0+*/6+*+*+*`);
    expect(cron.status).toBe(200);

    expect((await eventIds(cf!.baseUrl, cfWho)).length).toBe(1); // 2 of 3 gone
    expect((await eventIds(go.baseUrl, goWho)).length).toBe(3); // all survive
  });

  test("compaction leaves well-formed streams alone", async () => {
    // Control for the test above: real stream ids are one-per-row, so the
    // cron must delete nothing.
    const { who, events } = await seed(cf!.baseUrl, 3);
    expect((await fetch(`${cf!.baseUrl}/__scheduled?cron=0+*/6+*+*+*`)).status).toBe(
      200,
    );
    expect((await eventIds(cf!.baseUrl, who)).length).toBe(events.length);
  });
});

// A machine without wrangler still runs the Go half; say so rather than
// reporting a green suite that silently checked one implementation.
describe.skipIf(CLOUDFLARE)("cloudflare coverage", () => {
  test.skip("skipped: wrangler is not installed, so only Go was verified", () => {});
});
