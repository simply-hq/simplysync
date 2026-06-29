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
import { SYNC_OUTBOX_TABLE } from "../src/engine/constants";

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
