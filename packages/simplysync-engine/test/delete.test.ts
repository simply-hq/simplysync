import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

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

const schema = {
  todo: { id: id("Todo"), title: NonEmptyString },
};

function makeEngine() {
  let handle!: { db: Database };
  const engine = createSync({
    createSqliteDriver: () => {
      const made = makeDriver();
      handle = made;
      return made.driver;
    },
    secureStorage: memoryStorage(),
  })(schema, { name: "delete-test" });
  return { engine, getDb: () => handle.db };
}

const visibleTitles = async (
  engine: ReturnType<typeof makeEngine>["engine"],
): Promise<string[]> => {
  const rows = await engine.loadQuery(
    engine.createQuery((db) =>
      db.selectFrom("todo").select(["title"]).where("isDeleted", "=", 0),
    ),
  );
  return rows.map((r) => r.title);
};

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("delete", () => {
  test("hides the row from isDeleted-filtered queries but keeps the tombstone", async () => {
    const { engine, getDb } = makeEngine();
    await engine.ready;
    const created = engine.insert("todo", { title: "buy milk" });
    if (!created.ok) return;

    const del = engine.delete("todo", created.value.id);
    expect(del.ok).toBe(true);
    expect(await visibleTitles(engine)).toEqual([]);

    // The row physically remains (a tombstone), so the delete can replicate.
    const all = getDb()
      .prepare(`select isDeleted from "todo" where id = ?`)
      .get(created.value.id) as { isDeleted: number };
    expect(all.isDeleted).toBe(1);
  });

  test("replicates: the tombstone is enqueued for sync", async () => {
    const { engine } = makeEngine();
    await engine.ready;
    const created = engine.insert("todo", { title: "x" });
    if (!created.ok) return;
    await settle();
    const before = engine.getPendingOutboxCount();
    engine.delete("todo", created.value.id);
    await settle();
    // The delete added one more outbox event (the tombstone).
    expect(engine.getPendingOutboxCount()).toBe(before + 1);
  });

  test("is idempotent on a row that isn't present locally", async () => {
    const { engine, getDb } = makeEngine();
    await engine.ready;
    // Deleting an unknown id writes a tombstone (which will supersede the row
    // if it later arrives from a peer) rather than erroring.
    const del = engine.delete("todo", "ghost-id");
    expect(del.ok).toBe(true);
    const row = getDb()
      .prepare(`select isDeleted from "todo" where id = ?`)
      .get("ghost-id") as { isDeleted: number };
    expect(row.isDeleted).toBe(1);
  });

  test("deleteMany clears several rows in one batch", async () => {
    const { engine } = makeEngine();
    await engine.ready;
    const a = engine.insert("todo", { title: "a" });
    const b = engine.insert("todo", { title: "b" });
    const c = engine.insert("todo", { title: "c" });
    if (!a.ok || !b.ok || !c.ok) return;

    const res = engine.deleteMany("todo", [a.value.id, c.value.id]);
    expect(res.ok).toBe(true);
    expect((await visibleTitles(engine)).sort()).toEqual(["b"]);
  });

  test("batch can mix a delete with writes atomically", async () => {
    const { engine } = makeEngine();
    await engine.ready;
    const old = engine.insert("todo", { title: "old" });
    if (!old.ok) return;

    const res = engine.batch([
      { table: "todo", values: { title: "new" } },
      { table: "todo", mode: "delete", values: { id: old.value.id } },
    ]);
    expect(res.ok).toBe(true);
    expect(await visibleTitles(engine)).toEqual(["new"]);
  });
});
