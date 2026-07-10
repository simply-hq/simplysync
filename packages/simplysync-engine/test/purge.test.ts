import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createHlc } from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createStore } from "../src/engine/store";
import { SYNC_OUTBOX_TABLE, SYNC_PURGE_TABLE } from "../src/engine/constants";

function makeDriver(): { driver: SqliteDriver; db: Database } {
  const db = new Database(":memory:");
  return {
    db,
    driver: {
      exec(sql, params) {
        db.prepare(sql).run(...((params ?? []) as never[]));
      },
      select(sql, params) {
        return db.prepare(sql).all(...((params ?? []) as never[])) as never;
      },
      transaction(fn) {
        return db.transaction(fn)();
      },
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

const schema = { todo: { id: id("Todo"), title: NonEmptyString } };

function rowCount(db: Database): number {
  return (db.prepare(`select count(*) as c from "todo"`).get() as { c: number })
    .c;
}

describe("purgeDeleted (engine, no relays)", () => {
  function makeEngine() {
    let handle!: { db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        const made = makeDriver();
        handle = made;
        return made.driver;
      },
      secureStorage: memoryStorage(),
    })(schema, { name: "purge-test" });
    return { engine, getDb: () => handle.db };
  }

  test("purges old tombstones, keeps live rows and recent tombstones", async () => {
    const { engine, getDb } = makeEngine();
    await engine.ready;

    const a = engine.insert("todo", { title: "keep me" });
    const b = engine.insert("todo", { title: "delete me" });
    if (!a.ok || !b.ok) return;
    engine.delete("todo", b.value.id);
    expect(rowCount(getDb())).toBe(2); // tombstone still physically present

    // A 30-year window keeps everything (nothing is that old).
    expect(engine.purgeDeleted({ olderThanMs: 1_000 * 3600 * 24 * 365 * 30 })
      .purged).toBe(0);
    expect(rowCount(getDb())).toBe(2);

    // olderThanMs:0 means "older than right now" -> the tombstone qualifies, the
    // live row does not.
    expect(engine.purgeDeleted({ olderThanMs: 0 }).purged).toBe(1);
    expect(rowCount(getDb())).toBe(1);
    const left = getDb().prepare(`select title from "todo"`).get() as {
      title: string;
    };
    expect(left.title).toBe("keep me");
  });
});

describe("purge queue (_sync_purge)", () => {
  function purgeQueueRows(db: Database) {
    return db
      .prepare(`select table_name, row_id, acked_bases from "${SYNC_PURGE_TABLE}"`)
      .all() as { table_name: string; row_id: string; acked_bases: string }[];
  }

  test("a hard delete enqueues (table, rowId); ack/drop round-trips", async () => {
    const { engine, getDb } = (() => {
      let handle!: { db: Database };
      const engine = createSync({
        createSqliteDriver: () => {
          const made = makeDriver();
          handle = made;
          return made.driver;
        },
        secureStorage: memoryStorage(),
      })(schema, { name: "purge-queue-test" });
      return { engine, getDb: () => handle.db };
    })();
    await engine.ready;

    const a = engine.insert("todo", { title: "goner" });
    if (!a.ok) throw new Error("insert failed");
    engine.delete("todo", a.value.id);
    engine.purgeDeleted({ olderThanMs: 0 });

    const rows = purgeQueueRows(getDb());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.table_name).toBe("todo");
    expect(rows[0]!.row_id).toBe(a.value.id);
    expect(rows[0]!.acked_bases).toBe("[]");
  });

  test("store ackPurgeBase accumulates bases; dropPurgeEntry removes the row", () => {
    const { driver, db } = makeDriver();
    const state = createEngineState({ name: "queue" });
    state.driver = driver;
    const store = createStore(state, schema, { name: "queue" });
    store.ensureSchema();

    driver.exec(
      `insert into "${SYNC_PURGE_TABLE}" (table_name, row_id) values (?, ?)`,
      ["todo", "t9"],
    );
    store.ackPurgeBase("todo", "t9", "https://a.example");
    store.ackPurgeBase("todo", "t9", "https://b.example");
    store.ackPurgeBase("todo", "t9", "https://a.example"); // dedup

    expect(store.listPurgeQueue()).toEqual([
      {
        table: "todo",
        rowId: "t9",
        ackedBases: ["https://a.example", "https://b.example"],
      },
    ]);

    store.dropPurgeEntry("todo", "t9");
    expect(store.listPurgeQueue()).toEqual([]);
  });
});

describe("purgeRows (manual permanent delete)", () => {
  test("hard-deletes only pushed tombstones; live rows and unpushed deletes are skipped", () => {
    const { driver, db } = makeDriver();
    const state = createEngineState({ name: "manual" });
    state.driver = driver;
    state.transports = [{ url: "http://relay.example" }];
    const store = createStore(state, schema, { name: "manual" });
    store.ensureSchema();

    const pushedHlc = createHlc("devA", 1000, 0);
    const unpushedHlc = createHlc("devA", 1000, 1);
    // Live row — must never be purged even if named explicitly.
    store.writeRow("todo", {
      id: "live",
      title: "alive",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: createHlc("devA", 1000, 2),
      isDeleted: 0,
    });
    // Tombstone whose delete reached a relay.
    store.writeRow("todo", {
      id: "pushed",
      title: "x",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: pushedHlc,
      isDeleted: 1,
    });
    db.prepare(
      `insert into "${SYNC_OUTBOX_TABLE}" (event_id, envelope_json, pushed_at) values (?, ?, ?)`,
    ).run(pushedHlc, "{}", "2020-01-01T00:00:01.000Z");
    // Tombstone whose delete is still pending.
    store.writeRow("todo", {
      id: "unpushed",
      title: "y",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: unpushedHlc,
      isDeleted: 1,
    });
    db.prepare(
      `insert into "${SYNC_OUTBOX_TABLE}" (event_id, envelope_json, pushed_at) values (?, ?, NULL)`,
    ).run(unpushedHlc, "{}");

    const purged = store.purgeRows([
      { table: "todo", id: "live" },
      { table: "todo", id: "pushed" },
      { table: "todo", id: "unpushed" },
      { table: "todo", id: "missing" },
    ]);
    expect(purged).toBe(1);
    const ids = db
      .prepare(`select id from "todo" order by id`)
      .all() as { id: string }[];
    expect(ids.map((r) => r.id)).toEqual(["live", "unpushed"]);
    // The purge queue holds exactly the purged row.
    expect(store.listPurgeQueue()).toEqual([
      { table: "todo", rowId: "pushed", ackedBases: [] },
    ]);
  });
});

describe("purge drain (relay stream compaction)", () => {
  const settle = () => new Promise((r) => setTimeout(r, 25));

  test("purged streams are compacted on every relay; a failing relay is retried and the queue drains only after all ack", async () => {
    // Two stub relays: both accept pushes; relay-b fails its first compact.
    const compacted: Record<string, string[][]> = { a: [], b: [] };
    let bCompactFailures = 1;
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const relay = url.includes("relay-a") ? "a" : "b";
      if (url.endsWith("/v1/streams/compact")) {
        if (relay === "b" && bCompactFailures > 0) {
          bCompactFailures -= 1;
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        const body = JSON.parse(String(init?.body)) as { streamIds: string[] };
        compacted[relay]!.push(body.streamIds);
        return new Response(
          JSON.stringify({ deletedEvents: body.streamIds.length, reclaimedBytes: 1 }),
          { status: 200 },
        );
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { events: unknown[] };
        return new Response(
          JSON.stringify({ accepted: body.events.length, duplicate: 0 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
        status: 200,
      });
    }) as typeof fetch;

    let handle!: { db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        const made = makeDriver();
        handle = made;
        return made.driver;
      },
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, { name: "purge-drain-test" });
    await engine.ready;

    const a = engine.insert("todo", { title: "to be purged" });
    if (!a.ok) throw new Error("insert failed");
    engine.delete("todo", a.value.id);
    for (let i = 0; i < 40 && engine.getPendingOutboxCount() < 2; i++) {
      await settle();
    }

    engine.setTransports([
      { type: "Http", url: "http://relay-a.test" },
      { type: "Http", url: "http://relay-b.test" },
    ]);
    // Deliver the events first so the purge guard sees them pushed. An
    // explicit sync() can no-op while setTransports' own kick-off sync is
    // still in flight, so wait on the observable outcome (drained outbox),
    // not on any single sync() call.
    for (let i = 0; i < 40 && engine.getPendingOutboxCount() > 0; i++) {
      await engine.sync();
      await settle();
    }
    expect(engine.getPendingOutboxCount()).toBe(0);

    engine.purgeDeleted({ olderThanMs: 0 });
    // First sync after the purge: relay-a acks, relay-b's compact fails once —
    // the queue entry must survive with only relay-a recorded.
    for (let i = 0; i < 40 && compacted.a.length === 0; i++) {
      await engine.sync();
      await settle();
    }
    expect(compacted.a.length).toBeGreaterThan(0);

    const queued = handle.db
      .prepare(`select acked_bases from "${SYNC_PURGE_TABLE}"`)
      .all() as { acked_bases: string }[];
    if (queued.length > 0) {
      // Not yet fully acked — b must be absent from the acked list.
      expect(queued[0]!.acked_bases).not.toContain("relay-b");
    }

    // Keep syncing until relay-b acks too; then the queue must be empty.
    for (let i = 0; i < 40 && compacted.b.length === 0; i++) {
      await engine.sync();
      await settle();
    }
    expect(compacted.b.length).toBeGreaterThan(0);
    expect(
      handle.db.prepare(`select count(*) as c from "${SYNC_PURGE_TABLE}"`).get(),
    ).toEqual({ c: 0 });

    // Both relays were told to drop the same single 22-char stream id.
    const aIds = compacted.a.flat();
    const bIds = compacted.b.flat();
    expect(aIds).toHaveLength(1);
    expect(bIds).toEqual(aIds);
    expect(aIds[0]!).toMatch(/^[A-Za-z0-9_-]{22}$/u);
  });
});

describe("purgeDeleted (store, pending-push guard)", () => {
  test("keeps a tombstone whose delete hasn't been pushed when relays are set", () => {
    const { driver, db } = makeDriver();
    const state = createEngineState({ name: "guard" });
    state.driver = driver;
    state.transports = [{ url: "http://relay.example" }];
    const store = createStore(state, schema, { name: "guard" });
    store.ensureSchema();

    const oldHlc = createHlc("devA", 1000, 0); // ancient
    store.writeRow("todo", {
      id: "t1",
      title: "x",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: oldHlc,
      isDeleted: 1,
    });
    // Its delete event is queued but not yet pushed.
    db.prepare(
      `insert into "${SYNC_OUTBOX_TABLE}" (event_id, envelope_json, pushed_at) values (?, ?, NULL)`,
    ).run(oldHlc, "{}");

    // Ancient + relays configured + unpushed -> kept.
    expect(store.purgeDeleted(0, 5_000)).toBe(0);
    expect(rowCount(db)).toBe(1);

    // Once the delete is pushed, it can be reclaimed.
    db.prepare(
      `update "${SYNC_OUTBOX_TABLE}" set pushed_at = ? where event_id = ?`,
    ).run("2020-01-01T00:00:01.000Z", oldHlc);
    expect(store.purgeDeleted(0, 5_000)).toBe(1);
    expect(rowCount(db)).toBe(0);
  });
});
