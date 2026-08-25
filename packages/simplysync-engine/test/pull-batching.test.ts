import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createHlc,
  createMnemonic,
  deriveIdentity,
  encryptPayload,
  type LocalFirstIdentity,
  type SyncEnvelope,
} from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SqliteDriver,
} from "../src/index";
import { fakeRelay, memoryDriver, memoryStorage } from "./support";

// Plan 008: pullAndApply decrypts a page into memory, then applies every row +
// _sync_seen insert inside ONE driver.transaction instead of one auto-commit
// per event. These tests drive that through the public sync() entry point
// (using a synthetic identity + hand-built envelopes, since the engine's
// outward interface has no way to inject "remote" events other than through a
// Relay), plus a driver.transaction call counter to prove the batching
// actually happened rather than merely leaving the outward behaviour
// unchanged.
//
// Step 2 of plan 008 — draining every waiting page within a single sync()
// rather than one page per poll — landed later; its forward-progress
// behaviour is covered by the last describe in this file.

const schema = { note: { id: id("Note"), body: NonEmptyString } };
const RELAY = "http://relay.test";

// One ephemeral Owner for the whole file, so a synthetic envelope encrypts
// under the same identity the engine boots with.
const MNEMONIC = createMnemonic();

/**
 * A Device with a Relay attached and automatic sync switched off, so a pull
 * happens exactly when a test asks for one — no poll tick or connect-time pass
 * lands in the middle of the page being measured.
 *
 * Everything is asserted through the engine's own interface; `db` is here only
 * for the bookkeeping tables that interface deliberately does not expose
 * (_sync_seen, _sync_deferred, _sync_meta).
 */
async function makeHarness(
  options: { decorate?: (driver: SqliteDriver) => SqliteDriver } = {},
) {
  const { driver, db, transactionCalls } = memoryDriver();
  const decorated = options.decorate?.(driver) ?? driver;
  let serving: typeof fetch = (async () =>
    new Response(JSON.stringify({ events: [], nextCursor: "" }), {
      status: 200,
    })) as typeof fetch;
  const boot = (schemaVersion?: number) =>
    createSync({
      createSqliteDriver: () => decorated,
      secureStorage: memoryStorage(),
      fetch: ((input, init) => serving(input, init)) as typeof fetch,
    })(schema, {
      name: "pull-batching",
      externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
      transports: [{ type: "Http", url: RELAY }],
      schemaVersion,
      // The supported off-switch, in place of the earlier trick of assigning
      // state.transports behind setTransports' back to keep the timers quiet.
      autoSync: false,
    });
  const engine = boot();
  await engine.ready;
  const booted = transactionCalls();
  return {
    engine,
    db,
    identity: await deriveIdentity(MNEMONIC),
    /** Transactions opened since boot — boot's own are not part of a pull. */
    transactionCalls: () => transactionCalls() - booted,
    /** Point the Device at a Relay (or at a deliberately broken one). */
    serve(relayFetch: typeof fetch) {
      serving = relayFetch;
    },
    /**
     * Boot a second engine over the same database, declaring a payload version
     * this build did not support before — the app upgrade that makes the
     * engine reconsider its opaquely-deferred events at boot.
     */
    async reboot(schemaVersion: number) {
      const next = boot(schemaVersion);
      await next.ready;
      return next;
    },
  };
}

// Serves the SAME page on every pull behind a cursor that never moves, so a
// test can drive repeated pulls without a real Relay's sequence.
function servingPage(envelopes: readonly SyncEnvelope[]): typeof fetch {
  const relay = fakeRelay({ resend: true });
  relay.events.push(...envelopes);
  return relay.fetch;
}

// A Relay holding nothing, parked at a fixed cursor.
const idleAt = (nextCursor: string): typeof fetch =>
  (async (_input: RequestInfo | URL, init?: RequestInit) =>
    init?.method === "POST"
      ? new Response(JSON.stringify({ accepted: 0 }), { status: 200 })
      : new Response(JSON.stringify({ events: [], nextCursor }), {
          status: 200,
        })) as typeof fetch;

async function makeEnvelope(
  identity: LocalFirstIdentity,
  opts: { eventId: string; rowId: string; body: string },
): Promise<SyncEnvelope> {
  return encryptPayload(
    identity,
    { eventId: opts.eventId, deviceId: "peer-device" },
    {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId: opts.rowId,
      hlc: opts.eventId,
      value: {
        body: opts.body,
        updatedAt: opts.eventId,
        createdAt: opts.eventId,
        isDeleted: 0,
      },
    },
  );
}

function corruptCiphertext(envelope: SyncEnvelope): SyncEnvelope {
  // Flip the first character so AES-GCM auth-tag verification fails —
  // decryptEnvelope throws, exercising the decrypt-failure path.
  const flipped = envelope.ciphertext[0] === "A" ? "B" : "A";
  return { ...envelope, ciphertext: flipped + envelope.ciphertext.slice(1) };
}

const notesFrom = (db: Database) =>
  db
    .prepare(`select id, body, updatedAt from "note" order by id`)
    .all() as { id: string; body: string; updatedAt: string }[];

const pullCursor = (db: Database): string | null =>
  (
    db
      .prepare(`select value from "_sync_meta" where key = ?`)
      .get(`cursor:${RELAY}`) as { value: string } | undefined
  )?.value ?? null;

// The engine defers events for itself; a test that needs one already queued
// writes the row the same way the Store does.
const defer = (
  db: Database,
  eventId: string,
  payloadJson: string,
  retryAfterMs: number | null,
): void => {
  db.prepare(
    `insert or replace into "_sync_deferred" ` +
      `(event_id, payload_json, retry_after_ms) values (?, ?, ?)`,
  ).run(eventId, payloadJson, retryAfterMs);
};
describe("pullAndApply: transactional page apply (plan 008, step 1)", () => {
  test("applies a full page of many events (several rows + an update) in ONE transaction", async () => {
    const h = await makeHarness();
    const hlc = (n: number) => createHlc("peer-device", 1_700_000_000_000 + n, 0);

    const events = await Promise.all([
      makeEnvelope(h.identity, { eventId: hlc(0), rowId: "n1", body: "one" }),
      makeEnvelope(h.identity, { eventId: hlc(1), rowId: "n2", body: "two" }),
      makeEnvelope(h.identity, { eventId: hlc(2), rowId: "n3", body: "three" }),
      makeEnvelope(h.identity, { eventId: hlc(3), rowId: "n4", body: "four" }),
      makeEnvelope(h.identity, { eventId: hlc(4), rowId: "n5", body: "five" }),
      // n1 gets a second, later event in the SAME page — last-writer-wins
      // should land "one-updated", not "one".
      makeEnvelope(h.identity, { eventId: hlc(5), rowId: "n1", body: "one-updated" }),
    ]);

    h.serve(servingPage(events));
    await h.engine.sync();

    // The whole page's applies + seen-inserts happened in exactly one
    // transaction (pushOutbox opens none here — the outbox is empty).
    expect(h.transactionCalls()).toBe(1);

    const rows = notesFrom(h.db);
    expect(rows.map((r) => r.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.body]));
    expect(byId.n1).toBe("one-updated"); // later HLC in the same page wins
    expect(byId.n2).toBe("two");
    expect(byId.n3).toBe("three");
    expect(byId.n4).toBe("four");
    expect(byId.n5).toBe("five");

    const log = h.engine.getSyncLog(5);
    const syncEntry = log.find((l) => l.phase === "sync");
    expect(syncEntry?.result).toBe("ok");
    expect(syncEntry?.pulled).toBe(6);
    expect(syncEntry?.applied).toBe(6);
  });

  test("a duplicate eventId within the same page is applied exactly once", async () => {
    const h = await makeHarness();
    const hlc = createHlc("peer-device", 1_700_000_100_000, 0);
    const envelope = await makeEnvelope(h.identity, {
      eventId: hlc,
      rowId: "dup-row",
      body: "only-value",
    });

    // The exact same envelope appears twice in one page — a relay shouldn't
    // do this, but the in-transaction re-check must stay defensive.
    h.serve(servingPage([envelope, envelope]));
    await h.engine.sync();

    expect(h.transactionCalls()).toBe(1);
    const rows = notesFrom(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("only-value");

    const seenCount = h.db
      .prepare(`select count(*) as c from "_sync_seen"`)
      .get() as { c: number };
    expect(seenCount.c).toBe(1);

    const syncEntry = h.engine.getSyncLog(5).find((l) => l.phase === "sync");
    // Applied once, not twice, despite the event appearing twice in the page.
    expect(syncEntry?.applied).toBe(1);
  });

  test("idempotency: re-pulling an already-applied page (relay resend) is a no-op", async () => {
    const h = await makeHarness();
    const hlc = (n: number) => createHlc("peer-device", 1_700_000_200_000 + n, 0);
    const events = await Promise.all([
      makeEnvelope(h.identity, { eventId: hlc(0), rowId: "r1", body: "a" }),
      makeEnvelope(h.identity, { eventId: hlc(1), rowId: "r2", body: "b" }),
    ]);

    h.serve(servingPage(events));
    await h.engine.sync();
    const afterFirst = notesFrom(h.db);
    expect(afterFirst).toHaveLength(2);

    // Same page served again (e.g. relay resent an overlapping window). The
    // async pre-check finds both eventIds already in _sync_seen, so nothing
    // gets decrypted/applied a second time.
    await h.engine.sync();
    const afterSecond = notesFrom(h.db);
    expect(afterSecond).toEqual(afterFirst); // identical state, no duplicates

    const seenCount = h.db
      .prepare(`select count(*) as c from "_sync_seen"`)
      .get() as { c: number };
    expect(seenCount.c).toBe(2); // still exactly one seen-row per eventId

    const log = h.engine.getSyncLog(5);
    const secondSyncEntry = log.find(
      (l) => l.phase === "sync" && l.pulled === 2,
    );
    expect(secondSyncEntry?.applied).toBe(0);
  });

  test("a decrypt failure in the middle of a page doesn't abort the rest of the page", async () => {
    const h = await makeHarness();
    const hlc = (n: number) => createHlc("peer-device", 1_700_000_300_000 + n, 0);
    const good1 = await makeEnvelope(h.identity, {
      eventId: hlc(0),
      rowId: "g1",
      body: "good-one",
    });
    const bad = corruptCiphertext(
      await makeEnvelope(h.identity, {
        eventId: hlc(1),
        rowId: "bad-row",
        body: "never-applied",
      }),
    );
    const good2 = await makeEnvelope(h.identity, {
      eventId: hlc(2),
      rowId: "g2",
      body: "good-two",
    });

    h.serve(servingPage([good1, bad, good2]));
    await h.engine.sync();

    const rows = notesFrom(h.db);
    expect(rows.map((r) => r.id)).toEqual(["g1", "g2"]); // bad-row never written
    expect(rows[0]!.body).toBe("good-one");
    expect(rows[1]!.body).toBe("good-two");

    const log = h.engine.getSyncLog(5);
    const syncEntry = log.find((l) => l.phase === "sync");
    expect(syncEntry?.applied).toBe(2);
    const failEntry = log.find(
      (l) => l.phase === "pull" && l.result === "fail",
    );
    expect(failEntry?.kind).toBe("decryptFailed");
    expect(failEntry?.message).toContain("decrypt: 1");
  });
});

describe("pull drain: forward progress within one sync", () => {
  test("a multi-page backlog drains inside a single sync, not one page per poll", async () => {
    // A device coming back from a long offline stretch (or a freshly attached
    // relay) has more events waiting than fit in one page. If each sync took
    // only one page, the engine would flash "synced" between pages while
    // thousands of events were still missing, and a poller at 60s would need
    // hours to catch up.
    const h = await makeHarness();
    const pages: SyncEnvelope[][] = [];
    for (let page = 0; page < 3; page++) {
      const envelopes: SyncEnvelope[] = [];
      for (let i = 0; i < 2; i++) {
        const n = page * 2 + i;
        envelopes.push(
          await makeEnvelope(h.identity, {
            eventId: createHlc("peer-device", 1_700_000_000_000 + n, 0),
            rowId: `note-${n}`,
            body: `body ${n}`,
          }),
        );
      }
      pages.push(envelopes);
    }

    let gets = 0;
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ accepted: 0 }), { status: 200 });
      }
      gets += 1;
      const after = Number(new URL(String(input)).searchParams.get("after") || "0");
      const events = pages[after] ?? [];
      return new Response(
        JSON.stringify({
          events,
          nextCursor: String(events.length > 0 ? after + 1 : after),
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    h.serve(fetchStub);
    await h.engine.sync();

    expect(notesFrom(h.db).map((r) => r.id)).toEqual([
      "note-0",
      "note-1",
      "note-2",
      "note-3",
      "note-4",
      "note-5",
    ]);
    // Three content pages plus the empty page that ends the drain.
    expect(gets).toBe(4);
    expect(pullCursor(h.db)).toBe("3");
  });

  test("a relay re-serving the same page with an unchanged cursor stops instead of spinning", async () => {
    // A relay whose cursor doesn't move (a bug, a stale replica, a proxy
    // serving a cached page) would otherwise keep the drain loop going for as
    // long as the process lives. Stop, count the resend once, and let the next
    // poll retry from the stored cursor.
    const h = await makeHarness();
    const envelope = await makeEnvelope(h.identity, {
      eventId: createHlc("peer-device", 1_700_000_000_000, 0),
      rowId: "stuck",
      body: "hello",
    });

    let gets = 0;
    const fetchStub = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ accepted: 0 }), { status: 200 });
      }
      gets += 1;
      if (gets > 50) throw new Error("drain loop did not terminate");
      // Always the same page, always the same cursor.
      return new Response(
        JSON.stringify({ events: [envelope], nextCursor: "7" }),
        { status: 200 },
      );
    }) as typeof fetch;

    h.serve(fetchStub);
    await h.engine.sync();

    expect(notesFrom(h.db).map((r) => r.id)).toEqual(["stuck"]);
    // First page advanced "" -> "7" and applied; the second saw an unchanged
    // cursor and broke out.
    expect(gets).toBe(2);
    expect(pullCursor(h.db)).toBe("7");

    // The resend is counted once, not once per loop iteration.
    const [entry] = h.engine.getSyncLog(1);
    expect(entry?.pulled).toBe(1);
    expect(entry?.applied).toBe(1);
  });
});

describe("deferred replay: rows that can never be applied as-is", () => {
  const OPAQUE = null; // retry_after_ms NULL — waiting on a schema, not a clock
  // Opaque rows are reconsidered only when the build's supported payload
  // version changes, so a reboot has to declare one.
  const UPGRADED = 2;

  const deferredRows = (db: Database) =>
    db
      .prepare(
        `select event_id, retry_after_ms from "_sync_deferred" order by event_id`,
      )
      .all() as { event_id: string; retry_after_ms: number | null }[];

  test("a deferred row whose stored JSON no longer parses is dropped", async () => {
    // A deferred row is retained because a *future* app version might
    // understand it. Bytes that are not JSON never will, so keeping them only
    // grows the table and slows every rescan.
    const h = await makeHarness();
    defer(h.db, "0000000001-0000-peer", "{not json", OPAQUE);
    await h.reboot(UPGRADED);
    expect(deferredRows(h.db)).toEqual([]);
  });

  test("a deferred row whose payload HLC disagrees with its event id is dropped", async () => {
    // The event id is the authenticated one. The replay path has to reject the
    // mismatch for the same reason the pull path does, or a payload could
    // claim an ordering its envelope was never sealed with.
    const h = await makeHarness();
    const eventId = createHlc("peer-device", 1_700_000_000_000, 0);
    defer(
      h.db,
      eventId,
      JSON.stringify({
        schemaVersion: 1,
        table: "note",
        op: "upsert",
        rowId: "n1",
        hlc: createHlc("peer-device", 1_700_000_000_001, 0), // not the event id
        value: { body: "x", updatedAt: eventId, createdAt: eventId, isDeleted: 0 },
      }),
      OPAQUE,
    );
    await h.reboot(UPGRADED);
    expect(deferredRows(h.db)).toEqual([]);
  });

  test("a due row that still fails to apply becomes opaque instead of blocking the queue", async () => {
    // Due rows are selected oldest-retry-first. A row that is structurally
    // valid but that this schema cannot store would otherwise sit at the front
    // of every due page forever and starve the future-clock rows behind it.
    const h = await makeHarness();
    const stuck = createHlc("peer-device", 1_700_000_000_000, 0);
    const later = createHlc("peer-device", 1_700_000_000_001, 0);
    const payload = (eventId: string, body: unknown) =>
      JSON.stringify({
        schemaVersion: 1,
        table: "note",
        op: "upsert",
        rowId: eventId,
        hlc: eventId,
        value: { body, updatedAt: eventId, createdAt: eventId, isDeleted: 0 },
      });

    // body must be a non-empty string; a number fails projection and throws.
    defer(h.db, stuck, payload(stuck, 42), 1);
    defer(h.db, later, payload(later, "fine"), 2);

    // Every sync replays the due page before it talks to a Relay.
    await h.engine.sync();

    // The healthy row applied and left the queue…
    expect(notesFrom(h.db).map((r) => r.id)).toEqual([later]);
    // …and the stuck one is now opaque, so the next due page starts clean.
    expect(deferredRows(h.db)).toEqual([
      { event_id: stuck, retry_after_ms: null },
    ]);
  });

  test("a row the ladder defers is re-deferred, never dropped", async () => {
    // The last gate before apply can still refuse a row that got this far: a
    // stamp beyond the drift window is authenticated data this Device cannot
    // order yet. Retry it, do not discard it — the pull path used to drop it.
    // (The clock's own refusal branch is unreachable from here, since the
    // ladder screens the stamp first; admission.test.ts covers that one.)
    const h = await makeHarness();
    const eventId = createHlc("peer-device", Date.now() + 10 * 60_000, 0);
    defer(
      h.db,
      eventId,
      JSON.stringify({
        schemaVersion: 1,
        table: "note",
        op: "upsert",
        rowId: "n1",
        hlc: eventId,
        value: { body: "x", updatedAt: eventId, createdAt: eventId, isDeleted: 0 },
      }),
      1,
    );

    await h.engine.sync();

    expect(notesFrom(h.db)).toEqual([]);
    const [row] = deferredRows(h.db);
    expect(row?.event_id).toBe(eventId);
    // Still queued, and pushed at least a second out so it cannot spin.
    expect(row?.retry_after_ms).toBeGreaterThan(Date.now());
  });
});

describe("pull housekeeping", () => {
  test("an idle poll that returns the same cursor writes nothing", async () => {
    // Most polls find nothing. On browser drivers every write triggers a
    // whole-database snapshot, so re-storing an unchanged cursor once a minute
    // is periodic main-thread jank for no information gained.
    let writes = 0;
    const h = await makeHarness({
      decorate: (base) => ({
        exec(sql, params) {
          if (/_sync_meta/.test(sql)) writes += 1;
          return base.exec(sql, params);
        },
        select: base.select.bind(base),
        transaction: base.transaction.bind(base),
      }),
    });

    h.serve(idleAt("7"));
    await h.engine.sync(); // first contact: "" -> "7" is a real change
    expect(writes).toBeGreaterThan(0);
    expect(pullCursor(h.db)).toBe("7");

    writes = 0;
    await h.engine.sync();
    await h.engine.sync();
    expect(writes).toBe(0);
  });

  test("the dedup set is capped, keeping the newest event ids", async () => {
    // Unbounded, _sync_seen grows with every event this device ever pulled.
    // Pruning the oldest is safe: the cursor only moves forward, so a pruned
    // id is not re-served, and apply is idempotent under LWW even if it were.
    const h = await makeHarness();
    const CAP = 50_000;
    const db = h.db;
    db.transaction(() => {
      const insert = db.prepare(`insert into "_sync_seen" (event_id) values (?)`);
      for (let i = 0; i < CAP + 500; i++) {
        insert.run(createHlc("peer-device", 1_700_000_000_000 + i, 0));
      }
    })();
    expect(
      (db.prepare(`select count(*) as c from "_sync_seen"`).get() as { c: number }).c,
    ).toBe(CAP + 500);

    await h.engine.sync();

    const rows = db
      .prepare(`select count(*) as c, min(event_id) as lo, max(event_id) as hi from "_sync_seen"`)
      .get() as { c: number; lo: string; hi: string };
    expect(rows.c).toBe(CAP);
    // The newest survived and the oldest went, not the other way round.
    expect(rows.hi).toBe(createHlc("peer-device", 1_700_000_000_000 + CAP + 499, 0));
    expect(rows.lo).toBe(createHlc("peer-device", 1_700_000_000_000 + 500, 0));
  });
});

describe("crash safety on the pull path", () => {
  test("a failed apply leaves the cursor where it was, so the page is re-pulled", async () => {
    // The cursor is written after the apply transaction commits, never before.
    // Advancing first would be faster and would silently skip a whole page the
    // moment a write failed — a hole in the history that no later sync closes,
    // because the relay only serves events *after* the cursor.
    // Off during boot, which needs its own transactions; armed once the page
    // under test is being applied.
    let failApply = false;
    const h = await makeHarness({
      decorate: (base) => ({
        exec: base.exec.bind(base),
        select: base.select.bind(base),
        transaction(fn) {
          if (failApply) throw new Error("simulated crash mid-apply");
          return base.transaction(fn);
        },
      }),
    });
    const envelope = await makeEnvelope(h.identity, {
      eventId: createHlc("peer-device", 1_700_000_000_000, 0),
      rowId: "n1",
      body: "must not be skipped",
    });

    h.serve(servingPage([envelope]));
    failApply = true;
    await h.engine.sync();

    // Nothing applied, and — crucially — the cursor never moved.
    expect(notesFrom(h.db)).toEqual([]);
    expect(pullCursor(h.db)).toBeNull();

    // The next sync re-pulls the same page and applies it.
    failApply = false;
    await h.engine.sync();
    expect(notesFrom(h.db).map((r) => r.body)).toEqual(["must not be skipped"]);
    expect(pullCursor(h.db)).toBe("1");
  });
});
