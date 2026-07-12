// Regression tests for Plan 004: a remote row that carries a column unknown
// to the pulling device's schema must be applied (with the unknown column
// dropped), not thrown away wholesale. These drive the real pull/apply path
// (src/engine/relay.ts) end to end against a minimal in-memory stand-in for a
// relay's `/v1/events` HTTP API — no real network or relay process needed.
// Synthetic envelopes are crafted directly with the protocol's own
// `encryptPayload`/`deriveIdentity` so each test controls the exact HLC and
// row payload a "remote device" would have sent, including payloads an older
// local schema could never have produced itself (the whole point of the bug).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createHlc,
  deriveIdentity,
  encryptPayload,
  type LocalFirstIdentity,
  type SyncEnvelope,
  type SyncPayload,
} from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
  type SyncEngine,
  type Transport,
} from "../src/index";

// A fixed, valid BIP39 mnemonic so every "device" in a test derives the same
// identity (ownerId + encryption keys) without round-tripping through the
// engine's own random mnemonic generation.
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

const RELAY_URL = "http://relay.test";

// The schema the *receiving* device (the one under test) runs. Deliberately
// narrower than what a newer app version might write — it only knows `title`.
// That gap is what the "unknown column" tests exploit.
const schema = { note: { id: id("Note"), title: NonEmptyString } };

function wrapDriver(db: Database): SqliteDriver {
  return {
    exec(sql, params) {
      db.prepare(sql).run(...((params ?? []) as never[]));
    },
    select(sql, params) {
      return db.prepare(sql).all(...((params ?? []) as never[])) as never;
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}

function memoryStorage(): SecureStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

/**
 * A minimal in-memory stand-in for a relay's `/v1/events` push+pull HTTP API.
 * `after` is a numeric offset into the event log; `nextCursor` is the offset
 * after everything returned by this page — just enough to drive the client's
 * cursor bookkeeping in relay.ts without a real relay process.
 */
function createFakeRelay() {
  const events: SyncEnvelope[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.pathname !== "/v1/events") {
      return new Response("not found", { status: 404 });
    }
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        events: SyncEnvelope[];
      };
      events.push(...body.events);
      return new Response(JSON.stringify({ accepted: body.events.length }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const after = Number(url.searchParams.get("after") ?? "0") || 0;
    const slice = events.slice(after);
    const nextCursor = String(after + slice.length);
    return new Response(JSON.stringify({ events: slice, nextCursor }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { events, fetchImpl };
}

function makeDevice(fetchImpl: typeof fetch, name: string) {
  const db = new Database(":memory:");
  const engine = createSync({
    createSqliteDriver: () => wrapDriver(db),
    secureStorage: memoryStorage(),
    fetch: fetchImpl,
  })(schema, {
    name,
    externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
    // Effectively disable the periodic poller so only explicit sync() calls
    // (and the one setTransports auto-triggers) touch the fake relay.
    syncIntervalMs: 3_600_000,
  });
  return { engine, db };
}

/** Wait for an in-flight sync (e.g. one auto-triggered by setTransports) to
 * finish, so the caller observes fully settled state. */
async function settle(engine: SyncEngine<typeof schema>): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (engine.getSyncState().type !== "SyncStateIsSyncing") return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("sync never settled");
}

/** Attach the fake relay and wait for the connect-time sync it triggers. */
async function connect(engine: SyncEngine<typeof schema>): Promise<void> {
  const transports: Transport[] = [{ type: "Http", url: RELAY_URL }];
  engine.setTransports(transports);
  await settle(engine);
}

let cachedIdentity: LocalFirstIdentity | undefined;
async function getIdentity(): Promise<LocalFirstIdentity> {
  cachedIdentity ??= await deriveIdentity(MNEMONIC);
  return cachedIdentity;
}

/** Encrypt a synthetic payload (as if some other device had written and
 * pushed it) directly into the fake relay's event log. */
async function pushSynthetic(
  relay: ReturnType<typeof createFakeRelay>,
  payload: SyncPayload<Record<string, unknown>>,
  deviceId = "device-remote",
): Promise<void> {
  const identity = await getIdentity();
  const envelope = await encryptPayload(
    identity,
    { eventId: payload.hlc, deviceId },
    payload,
  );
  relay.events.push(envelope);
}

function isSeen(db: Database, eventId: string): boolean {
  return (
    db.prepare(`select 1 from _sync_seen where event_id = ?`).get(eventId) !=
    null
  );
}

describe("relay pull/apply — Plan 004 (schema projection on remote apply)", () => {
  test("a remote row carrying a column unknown to the local schema is applied, not dropped", async () => {
    const relay = createFakeRelay();
    const { engine, db } = makeDevice(relay.fetchImpl, "unknown-column");
    await engine.ready;

    const rowId = "row-1";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        title: "Written on a newer app version",
        // A column this (older) schema has never heard of. Pre-fix this made
        // the whole insert throw ("no column named futureColumn") — dropping
        // the row entirely and, since the event was still marked seen, for
        // good.
        futureColumn: "some value from the future",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db
      .prepare(`select id, title from note where id = ?`)
      .get(rowId) as { id: string; title: string } | null;
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Written on a newer app version");

    // Applied successfully, so it's correctly recorded seen (not lost).
    expect(isSeen(db, hlc)).toBe(true);

    const log = engine.getSyncLog(5);
    expect(log[0]?.applied).toBe(1);
    expect(log[0]?.kind).toBeUndefined(); // no failure surfaced
  });

  test("re-pulling the same page (cursor rewound) is idempotent", async () => {
    const relay = createFakeRelay();
    const { engine, db } = makeDevice(relay.fetchImpl, "idempotency");
    await engine.ready;

    const rowId = "row-2";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        title: "Once",
        futureColumn: "ignored",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);
    const before = db.prepare(`select * from note where id = ?`).get(rowId);
    expect(before).not.toBeNull();

    // Rewind the pull cursor and re-sync: the relay re-serves the same
    // envelope, but `_sync_seen` must dedupe it before it ever reaches
    // applyRemoteRow again.
    db.prepare(`update _sync_meta set value = '0' where key = ?`).run(
      `cursor:${RELAY_URL}`,
    );
    await engine.sync();

    const after = db.prepare(`select * from note where id = ?`).get(rowId);
    expect(after).toEqual(before);

    // The re-pulled page contributed 0 new applies (already seen).
    const log = engine.getSyncLog(5);
    expect(log[0]?.applied).toBe(0);
    expect(log[0]?.pulled).toBe(1);
  });

  test("a stale (older-HLC) remote edit that arrives after a newer one is skipped, not applied — and still marked seen", async () => {
    const relay = createFakeRelay();
    const { engine, db } = makeDevice(relay.fetchImpl, "lww-lost");
    await engine.ready;

    const rowId = "row-3";
    const t0 = Date.now();
    const hlcOld = createHlc("device-remote", t0, 0);
    const hlcNew = createHlc("device-remote", t0 + 10_000, 0);

    // Arrival order: the newer edit first, then a straggler older edit for
    // the same row (out-of-order delivery, e.g. a slow/offline device).
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc: hlcNew,
      value: {
        title: "new",
        createdAt: new Date(t0 + 10_000).toISOString(),
        updatedAt: hlcNew,
        isDeleted: 0,
      },
    });
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc: hlcOld,
      value: {
        title: "old",
        createdAt: new Date(t0).toISOString(),
        updatedAt: hlcOld,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db.prepare(`select title from note where id = ?`).get(rowId) as {
      title: string;
    };
    expect(row.title).toBe("new"); // the stale edit did not win

    // Both events were pulled; only the newer one was actually applied. The
    // stale one is still marked seen (an intentional, terminal skip) so it
    // isn't retried forever.
    const log = engine.getSyncLog(5);
    expect(log[0]?.pulled).toBe(2);
    expect(log[0]?.applied).toBe(1);
    expect(isSeen(db, hlcNew)).toBe(true);
    expect(isSeen(db, hlcOld)).toBe(true);
  });

  test("a genuinely invalid value for a known column fails apply but is still marked seen (terminal, not retried forever)", async () => {
    const relay = createFakeRelay();
    const { engine, db } = makeDevice(relay.fetchImpl, "terminal-failure");
    await engine.ready;

    const rowId = "row-4";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        // `title` is a known column (NonEmptyString) but this value fails its
        // own validation — a genuine data problem, not a schema-version gap.
        // Projection can't rescue this; it must surface as an apply failure.
        title: "",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db.prepare(`select 1 from note where id = ?`).get(rowId);
    expect(row).toBeNull(); // never written

    expect(isSeen(db, hlc)).toBe(true); // terminal: marked seen anyway

    let log = engine.getSyncLog(5);
    expect(log[0]?.kind).toBe("applyFailed");

    // Re-syncing must NOT retry it (already seen) or log another failure.
    await engine.sync();
    log = engine.getSyncLog(5);
    expect(log[0]?.result).toBe("ok");
    expect(log[0]?.kind).toBeUndefined();
  });

  test("normal apply (no schema gap) still works end to end", async () => {
    const relay = createFakeRelay();
    const { engine, db } = makeDevice(relay.fetchImpl, "normal-apply");
    await engine.ready;

    const rowId = "row-5";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        title: "Plain row",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db
      .prepare(`select id, title, isDeleted from note where id = ?`)
      .get(rowId) as { id: string; title: string; isDeleted: number };
    expect(row).toEqual({ id: rowId, title: "Plain row", isDeleted: 0 });
  });

  test("an unknown-table event is staged and replayed after schema upgrade", async () => {
    const relay = createFakeRelay();
    const db = new Database(":memory:");
    const storage = memoryStorage();
    const makeWithSchema = <S extends Parameters<ReturnType<typeof createSync>>[0]>(
      nextSchema: S,
      name: string,
    ) =>
      createSync({
        createSqliteDriver: () => wrapDriver(db),
        secureStorage: storage,
        fetch: relay.fetchImpl,
      })(nextSchema, {
        name,
        externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
        syncIntervalMs: 3_600_000,
      });

    const oldEngine = makeWithSchema(schema, "unknown-table-upgrade");
    await oldEngine.ready;
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 2,
      table: "task",
      op: "upsert",
      rowId: "task-1",
      hlc,
      value: {
        title: "Arrived before this table existed",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });
    oldEngine.setTransports([{ type: "Http", url: RELAY_URL }]);
    await settle(oldEngine as SyncEngine<typeof schema>);
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 1 });
    oldEngine.setTransports([]);

    const upgradedSchema = {
      ...schema,
      task: { id: id("Task"), title: NonEmptyString },
    };
    const upgraded = makeWithSchema(upgradedSchema, "unknown-table-upgrade");
    await upgraded.ready;
    expect(
      db.prepare(`select title from task where id = ?`).get("task-1"),
    ).toEqual({ title: "Arrived before this table existed" });
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 0 });
  });

  test("an absurd future HLC is rejected before last-write-wins apply", async () => {
    const relay = createFakeRelay();
    const { engine, db } = makeDevice(relay.fetchImpl, "future-hlc-apply");
    await engine.ready;
    const hlc = createHlc("device-remote", Date.now() + 10 * 60_000, 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId: "future-row",
      hlc,
      value: {
        title: "must not win",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);
    expect(db.prepare(`select 1 from note where id = ?`).get("future-row")).toBeNull();
    expect(isSeen(db, hlc)).toBe(true);
    expect(engine.getSyncLog(5)[0]?.kind).toBe("applyFailed");
  });
});
