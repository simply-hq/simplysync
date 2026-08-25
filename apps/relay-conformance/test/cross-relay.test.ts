// What only shows up when both relays are running at once: moving an owner
// between implementations, and the places where they answer the same request
// differently.
//
// The contract itself lives in conformance.test.ts, asserted of every adapter.
// This file holds the residue that is deliberately NOT contract:
//
//   - cross-implementation behaviour (a device switching relays),
//   - divergences: same request, two answers, asserted as they behave TODAY,
//   - exceptions: a feature only one implementation has at all.
//
// Everything below is PINNED. Each names the risk it carries, so closing one is
// a deliberate edit here rather than a drift nobody notices.
//
// Cloudflare runs under `wrangler dev --local` (miniflare: local D1 + R2, no
// network, no account). Its blocks skip when wrangler isn't installed — unless
// RELAY_REQUIRE_CLOUDFLARE=1, which CI sets (see conformance/adapters.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sha256Base64UrlBytes, type SyncEnvelope } from "@simplysync/protocol";
import { CLOUDFLARE_AVAILABLE } from "./conformance/adapters";
import {
  cleanupGoBinary,
  launchRelay,
  type LaunchedRelay,
} from "./conformance/launch-relay";
import { launchCloudflareRelay } from "./conformance/launch-cloudflare";
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
  pullEvents,
  pushEvents,
  putBlob,
} from "./conformance/http";

const CLOUDFLARE = CLOUDFLARE_AVAILABLE;
const BOOT_MS = 240_000;
const ADMIN_TOKEN = "conformance-admin-token";
const ADMIN_BASE = "/conformance-admin";

let go: LaunchedRelay;
/** Go with the admin surface on — the ops dashboard has no Cloudflare twin. */
let goAdmin: LaunchedRelay;
/** Go handed Cloudflare's kill switch, to pin that it ignores it. */
let goDisabled: LaunchedRelay;
let cf: LaunchedRelay | undefined;
let cfDisabled: LaunchedRelay | undefined;

beforeAll(async () => {
  [go, goAdmin, goDisabled] = await Promise.all([
    launchRelay({ RATE_LIMIT_ENABLED: "false" }),
    launchRelay({
      RATE_LIMIT_ENABLED: "false",
      ADMIN_TOKEN,
      ADMIN_PATH: ADMIN_BASE.slice(1),
      // Off: the admin-triggered compaction test must be the only thing that
      // can delete an event while it runs.
      COMPACTION_INTERVAL_MS: "0",
    }),
    launchRelay({ RATE_LIMIT_ENABLED: "false", RELAY_DISABLED: "true" }),
  ]);
  if (CLOUDFLARE) {
    [cf, cfDisabled] = await Promise.all([
      launchCloudflareRelay(),
      launchCloudflareRelay({ RELAY_DISABLED: "true" }),
    ]);
  }
}, BOOT_MS);

afterAll(async () => {
  await Promise.all([
    go?.kill(),
    goAdmin?.kill(),
    goDisabled?.kill(),
    cf?.kill(),
    cfDisabled?.kill(),
  ]);
  cleanupGoBinary();
});

// --- helpers ---------------------------------------------------------------

interface PullBody {
  readonly events: SyncEnvelope[];
  readonly nextCursor: string;
}

async function pull(
  base: string,
  who: TestIdentity,
  after = "",
): Promise<PullBody> {
  const res = await pullEvents(base, who, after);
  expect(res.status).toBe(200);
  return (await res.json()) as PullBody;
}

async function eventIds(base: string, who: TestIdentity): Promise<string[]> {
  return (await pull(base, who)).events.map((event) => event.eventId);
}

async function usedBytes(base: string, who: TestIdentity): Promise<number> {
  const res = await getUsage(base, who);
  expect(res.status).toBe(200);
  return ((await res.json()) as { storedBytes: number }).storedBytes;
}

async function streamCount(base: string, who: TestIdentity): Promise<number> {
  const body = (await (await getStatus(base, who)).json()) as {
    account?: { streams?: number };
  };
  return body.account?.streams ?? -1;
}

async function seed(
  base: string,
  count = 3,
): Promise<{ who: TestIdentity; events: SyncEnvelope[] }> {
  const who = await createTestIdentity();
  const events = await makeEnvelopes(who, count);
  expect((await pushEvents(base, who, events)).status).toBe(200);
  return { who, events };
}

/** Runs the Cloudflare compaction cron on demand (`wrangler dev --test-scheduled`). */
async function runCron(base: string): Promise<void> {
  const res = await fetch(`${base}/__scheduled?cron=0+*/6+*+*+*`);
  expect(res.status).toBe(200);
}

// --- moving an owner between implementations -------------------------------

describe.skipIf(!CLOUDFLARE)("migrating an owner between relays", () => {
  test("the same owner reads back identically from Go and Cloudflare", async () => {
    const who = await createTestIdentity();
    const events = await makeEnvelopes(who, 4);

    expect((await pushEvents(go.baseUrl, who, events)).status).toBe(200);
    expect((await pushEvents(cf!.baseUrl, who, events)).status).toBe(200);

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
    expect((await pushEvents(go.baseUrl, who, events)).status).toBe(200);
    const goCursor = (await pull(go.baseUrl, who)).nextCursor;

    expect((await pushEvents(cf!.baseUrl, who, events)).status).toBe(200);
    const honest = await pull(cf!.baseUrl, who);
    expect(honest.events.length).toBe(4);

    const carried = await pull(cf!.baseUrl, who, goCursor);
    expect(carried.events.length).toBeLessThan(honest.events.length);
  });
});

// --- divergences: same request, two answers --------------------------------

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
    expect((await pushEvents(go.baseUrl, a.who, [a.event])).status).toBe(200);
    const b = await mk();
    expect((await pushEvents(cf!.baseUrl, b.who, [b.event])).status).toBe(400);
  });

  test("neither relay applies the streamId shape rule on push", async () => {
    // Both enforce it on /v1/streams/compact and neither on the push path, so
    // a stream id that could never be produced by the protocol is storable.
    for (const [name, base] of [
      ["go", go.baseUrl],
      ["cloudflare", cf!.baseUrl],
    ] as const) {
      const who = await createTestIdentity();
      const [event] = await makeEnvelopes(who, 1);
      const res = await pushEvents(base, who, [{ ...event!, streamId: "x" }]);
      expect([name, res.status]).toEqual([name, 200]);
    }
  });

  test("an empty streamId destroys an owner's log on Cloudflare, not on Go", async () => {
    // The defect this whole file exists to catch. Go normalises "" to SQL NULL
    // and compaction skips NULL streams. Cloudflare stores the empty string,
    // and '' IS NOT NULL — so every event with an empty streamId is treated as
    // ONE stream and the 6-hourly cron keeps only the highest event id.
    //
    // Fix is two lines, now in two files: reuse the existing STREAM_ID_SHAPE
    // regex in `validateEnvelope`'s push path (apps/relay-cloudflare/src/handlers.ts),
    // and store `streamId || null` instead of `streamId ?? null` in
    // `insertAndCharge` (apps/relay-cloudflare/src/store.ts).
    const blank = async (base: string) => {
      const who = await createTestIdentity();
      const events = (await makeEnvelopes(who, 3)).map((event) => ({
        ...event,
        streamId: "",
      }));
      expect((await pushEvents(base, who, events)).status).toBe(200);
      return who;
    };

    const goWho = await blank(go.baseUrl);
    expect(await streamCount(go.baseUrl, goWho)).toBe(0); // NULL: not a stream

    const cfWho = await blank(cf!.baseUrl);
    expect(await streamCount(cf!.baseUrl, cfWho)).toBe(1); // three rows, one stream

    await runCron(cf!.baseUrl);

    expect(await eventIds(cf!.baseUrl, cfWho)).toHaveLength(1); // 2 of 3 gone
    expect(await eventIds(go.baseUrl, goWho)).toHaveLength(3); // all survive
  });

  test("compaction leaves well-formed streams alone", async () => {
    // Control for the test above: real stream ids are one-per-row, so the
    // cron must delete nothing.
    const { who, events } = await seed(cf!.baseUrl, 3);
    await runCron(cf!.baseUrl);
    expect(await eventIds(cf!.baseUrl, who)).toHaveLength(events.length);
  });
});

// --- exceptions: a feature only the Go relay has ---------------------------

describe("go-only behaviour (not contract)", () => {
  test("pull compresses in the handler, which is why only Go sends Vary", async () => {
    // The Go relay is deployed with nothing in front of it, so it gzips the one
    // large response itself and must tell caches it varies by Accept-Encoding.
    // Cloudflare's relay deliberately does NOT (a hand-gzipped body without
    // `encodeBody: "manual"` gets re-encoded by the runtime, which bricked
    // initial sync); its platform negotiates encoding instead. The risk: a
    // cache in front of a self-hosted relay is the one that has to be told.
    const { who } = await seed(go.baseUrl, 20); // over the 1 KiB gzip floor
    const res = await pullEvents(go.baseUrl, who, "");
    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toBe("Accept-Encoding");

    if (CLOUDFLARE) {
      const { who: cfWho } = await seed(cf!.baseUrl, 20);
      const cfRes = await pullEvents(cf!.baseUrl, cfWho, "");
      expect(cfRes.status).toBe(200);
      expect(cfRes.headers.get("vary")).toBeNull();
    }
  });

  test("compaction is triggered by a timer or the admin surface, not a cron", async () => {
    // Go's superseded-event compaction runs on COMPACTION_INTERVAL_MS and can
    // be forced through the admin dashboard; Cloudflare's runs on a Cron
    // Trigger with no HTTP entry point at all. Two mechanisms, one invariant —
    // and no way to make one file assert both.
    const who = await createTestIdentity();
    const generations = [
      await makeEnvelope(who, { rowId: "row-a", counter: 0 }),
      await makeEnvelope(who, { rowId: "row-a", counter: 1 }),
      await makeEnvelope(who, { rowId: "row-a", counter: 2 }),
    ];
    expect((await pushEvents(goAdmin.baseUrl, who, generations)).status).toBe(200);

    const res = await fetch(`${goAdmin.baseUrl}${ADMIN_BASE}/compact`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { deletedEvents: number }).deletedEvents,
    ).toBeGreaterThanOrEqual(2);

    // Last-writer-wins: only the highest event id of the stream survives.
    expect(await eventIds(goAdmin.baseUrl, who)).toEqual([
      generations[2]!.eventId,
    ]);
  });

  test("admin /stats byEndpoint does not leak an unauthenticated raw path as a label", async () => {
    // The Cloudflare relay has no admin surface, so this bound exists only
    // here: routeLabel() collapses unmatched paths to a fixed bucket, or any
    // caller could plant an arbitrary string in the ops metrics and grow
    // byEndpoint without bound.
    const junkPath = "/junk/path/should-not-leak";
    await fetch(`${goAdmin.baseUrl}${junkPath}`);

    const res = await fetch(`${goAdmin.baseUrl}${ADMIN_BASE}/stats`, {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      traffic: { byEndpoint: Record<string, number> };
    };
    const leaked = Object.keys(stats.traffic.byEndpoint).some((key) =>
      key.includes(junkPath),
    );
    expect(leaked).toBe(false);
  });

  test("RELAY_DISABLED means nothing to the Go relay", async () => {
    // Pinned counterpart to the Cloudflare kill switch below: a self-hosted
    // operator stops the process, so Go never grew the var. The risk is an
    // operator setting it here, believing writes are off, and finding they
    // aren't.
    const who = await createTestIdentity();
    expect(
      (await pushEvents(goDisabled.baseUrl, who, [await makeEnvelope(who)])).status,
    ).toBe(200);
  });
});

// --- exceptions: a feature only the Cloudflare relay has -------------------

describe.skipIf(!CLOUDFLARE)("cloudflare-only behaviour (not contract)", () => {
  test("blob GET carries an ETag; the Go relay's does not", async () => {
    // Content-addressed bytes make the hash a free, exact validator, and a zone
    // cache rule in front of /v1/blobs/* can use it. Go serves the same bytes
    // with only Cache-Control, so a cache in front of it revalidates by time
    // alone.
    const who = await createTestIdentity();
    const bytes = new TextEncoder().encode(`etag divergence ${Math.random()}`);
    const hash = await sha256Base64UrlBytes(bytes);

    expect((await putBlob(cf!.baseUrl, who, hash, bytes)).status).toBe(200);
    expect((await getBlob(cf!.baseUrl, who, hash)).headers.get("etag")).toBe(hash);

    expect((await putBlob(go.baseUrl, who, hash, bytes)).status).toBe(200);
    expect((await getBlob(go.baseUrl, who, hash)).headers.get("etag")).toBeNull();
  });

  test("RELAY_DISABLED is a read-only kill switch: writes 503, reads still served", async () => {
    // A metered relay needs a way to stop the bill without losing the data;
    // a self-hosted one just gets stopped. The risk is silent asymmetry: a
    // client seeing 503 on push here and a connection error there.
    const who = await createTestIdentity();
    const push = await pushEvents(cfDisabled!.baseUrl, who, [
      await makeEnvelope(who),
    ]);
    expect(push.status).toBe(503);

    const bytes = new TextEncoder().encode("kill switch");
    const blob = await putBlob(
      cfDisabled!.baseUrl,
      who,
      await sha256Base64UrlBytes(bytes),
      bytes,
    );
    expect(blob.status).toBe(503);

    const compact = await compactStreams(cfDisabled!.baseUrl, who, [
      "A".repeat(22),
    ]);
    expect(compact.status).toBe(503);

    // Reads take the normal path: unknown owner, not "relay off".
    expect((await pullEvents(cfDisabled!.baseUrl, who, "")).status).toBe(404);
  });

  test("owner creation is rate limited per IP; the Go relay has no such limiter", async () => {
    // Cloudflare's relay is a public URL on a metered account, so minting owner
    // rows is the costliest thing to leave open and gets its own budget
    // (5/min/IP). Go's fleet cap is MAX_OWNERS alone. The risk: several devices
    // behind one NAT first-syncing at once are throttled on one relay only.
    const shared = "203.0.113.7";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const who = await createTestIdentity();
      const res = await pushEvents(cf!.baseUrl, who, [await makeEnvelope(who)], {
        ip: shared,
      });
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);

    const goStatuses: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const who = await createTestIdentity();
      const res = await pushEvents(go.baseUrl, who, [await makeEnvelope(who)], {
        ip: shared,
      });
      goStatuses.push(res.status);
    }
    expect(goStatuses).toEqual(Array(7).fill(200));
  });
});

// A machine without wrangler still runs the Go half; say so rather than
// reporting a green suite that silently checked one implementation. In CI
// RELAY_REQUIRE_CLOUDFLARE=1 makes the missing harness a failure instead.
describe.skipIf(CLOUDFLARE)("cloudflare coverage", () => {
  test.skip("skipped: wrangler is not installed, so only Go was verified", () => {});
});
