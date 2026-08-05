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

import { id, NonEmptyString, type SqliteDriver } from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createClock, createStore } from "../src/engine/store";
import { createQueryCache } from "../src/engine/query-cache";
import { createRelaySync } from "../src/engine/relay";
import { createTabBridge } from "../src/engine/tab-sync";

// Plan 008: pullAndApply decrypts a page into memory, then applies every row +
// _sync_seen insert inside ONE driver.transaction instead of one auto-commit
// per event. These tests exercise that behaviour through the public sync()
// entry point (using a synthetic identity + hand-built envelopes, since the
// engine's outward API has no way to inject "remote" events other than
// through a relay), plus a driver.transaction call counter to prove the
// batching actually happened rather than merely leaving the outward behaviour
// unchanged.
//
// Note: Step 2 of plan 008 (draining multiple pages within a single sync())
// was deferred — see the executor's report — so these tests cover Step 1
// (transactional apply) only: one page in, one transaction, correct/idempotent
// state out.

const schema = { note: { id: id("Note"), body: NonEmptyString } };

function makeDriver(): {
  driver: SqliteDriver;
  db: Database;
  transactionCalls: () => number;
} {
  const db = new Database(":memory:");
  let calls = 0;
  return {
    db,
    transactionCalls: () => calls,
    driver: {
      exec(sql, params) {
        db.prepare(sql).run(...((params ?? []) as never[]));
      },
      select(sql, params) {
        return db.prepare(sql).all(...((params ?? []) as never[])) as never;
      },
      transaction(fn) {
        calls += 1;
        return db.transaction(fn)();
      },
    },
  };
}

async function makeHarness() {
  const { driver, db, transactionCalls } = makeDriver();
  const state = createEngineState({ name: "pull-batching" });
  state.driver = driver;
  state.deviceId = "device-local";
  state.identity = await deriveIdentity(createMnemonic());
  // Set directly (bypassing setTransports) so no opportunistic sync/poll timer
  // starts — the test drives relay.sync() explicitly.
  state.transports = [{ type: "Http", url: "http://relay.test" }];
  const store = createStore(state, schema, { name: "pull-batching" });
  store.ensureSchema();
  const clock = createClock(state, store);
  const queryCache = createQueryCache(state, schema);
  return {
    state,
    store,
    clock,
    queryCache,
    db,
    transactionCalls,
    identity: state.identity,
  };
}

function makeRelay(
  harness: Awaited<ReturnType<typeof makeHarness>>,
  fetchStub: typeof fetch,
) {
  return createRelaySync(
    harness.state,
    harness.store,
    harness.clock,
    harness.queryCache,
    createTabBridge(
      harness.state,
      harness.store,
      harness.clock,
      harness.queryCache,
      schema,
      undefined, // no tab coordination in this harness
    ),
    schema,
    {
      createSqliteDriver: () => {
        throw new Error("unused in this harness");
      },
      secureStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    },
    { name: "pull-batching" },
    fetchStub,
  );
}

// Serves the SAME page of envelopes on every GET (call-count independent), so
// tests can drive repeated pulls without needing a real relay cursor.
function fetchStubForPage(events: SyncEnvelope[], nextCursor = "1"): typeof fetch {
  return (async (_input, init) => {
    if (init?.method === "POST") {
      return new Response(JSON.stringify({ accepted: 0, duplicate: 0 }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ events, nextCursor }), {
      status: 200,
    });
  }) as typeof fetch;
}

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

    const relay = makeRelay(h, fetchStubForPage(events));
    await relay.sync();

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

    const log = h.store.recentSyncLog(5);
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
    const relay = makeRelay(h, fetchStubForPage([envelope, envelope]));
    await relay.sync();

    expect(h.transactionCalls()).toBe(1);
    const rows = notesFrom(h.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe("only-value");

    const seenCount = h.db
      .prepare(`select count(*) as c from "_sync_seen"`)
      .get() as { c: number };
    expect(seenCount.c).toBe(1);

    const syncEntry = h.store.recentSyncLog(5).find((l) => l.phase === "sync");
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

    const relay = makeRelay(h, fetchStubForPage(events));
    await relay.sync();
    const afterFirst = notesFrom(h.db);
    expect(afterFirst).toHaveLength(2);

    // Same page served again (e.g. relay resent an overlapping window). The
    // async pre-check finds both eventIds already in _sync_seen, so nothing
    // gets decrypted/applied a second time.
    await relay.sync();
    const afterSecond = notesFrom(h.db);
    expect(afterSecond).toEqual(afterFirst); // identical state, no duplicates

    const seenCount = h.db
      .prepare(`select count(*) as c from "_sync_seen"`)
      .get() as { c: number };
    expect(seenCount.c).toBe(2); // still exactly one seen-row per eventId

    const log = h.store.recentSyncLog(5);
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

    const relay = makeRelay(h, fetchStubForPage([good1, bad, good2]));
    await relay.sync();

    const rows = notesFrom(h.db);
    expect(rows.map((r) => r.id)).toEqual(["g1", "g2"]); // bad-row never written
    expect(rows[0]!.body).toBe("good-one");
    expect(rows[1]!.body).toBe("good-two");

    const log = h.store.recentSyncLog(5);
    const syncEntry = log.find((l) => l.phase === "sync");
    expect(syncEntry?.applied).toBe(2);
    const failEntry = log.find(
      (l) => l.phase === "pull" && l.result === "fail",
    );
    expect(failEntry?.kind).toBe("decryptFailed");
    expect(failEntry?.message).toContain("decrypt: 1");
  });
});
