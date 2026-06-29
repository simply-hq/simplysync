import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  FiniteNumber,
  id,
  keysBetween,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

function makeDriver(): SqliteDriver {
  const db = new Database(":memory:");
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

const schema = {
  todo: { id: id("Todo"), title: NonEmptyString, order: NonEmptyString },
  list: { id: id("List"), name: NonEmptyString, count: FiniteNumber },
};

function makeEngine() {
  return createSync({
    createSqliteDriver: () => makeDriver(),
    secureStorage: memoryStorage(),
  })(schema, { name: "batch-test" });
}

const settle = () => new Promise((r) => setTimeout(r, 25));

describe("batch", () => {
  test("seeds many rows in one shot, one sync event per row", async () => {
    const engine = makeEngine();
    await engine.ready;

    // A freshly-ordered todo list, keys spread by the fractional indexer.
    const titles = ["a", "b", "c", "d", "e"];
    const orders = keysBetween(null, null, titles.length);
    const result = engine.batch(
      titles.map((title, i) => ({
        table: "todo" as const,
        values: { title, order: orders[i]! },
      })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ids.length).toBe(5);

    const rows = await engine.loadQuery(
      engine.createQuery((db) =>
        db.selectFrom("todo").select(["title", "order"]).orderBy("order"),
      ),
    );
    expect(rows.map((r) => r.title)).toEqual(["a", "b", "c", "d", "e"]);

    await settle();
    // One outbox event per row — the rows still replicate individually (per-row
    // LWW), but they were written in a single transaction + refresh + sync.
    expect(engine.getPendingOutboxCount()).toBe(5);
  });

  test("is atomic: an invalid op writes nothing", async () => {
    const engine = makeEngine();
    await engine.ready;

    const result = engine.batch([
      { table: "todo", values: { title: "ok", order: "V" } },
      // Empty title violates NonEmptyString -> whole batch aborts.
      { table: "todo", values: { title: "", order: "W" } as never },
      { table: "todo", values: { title: "also ok", order: "X" } },
    ]);
    expect(result.ok).toBe(false);

    const count = await engine.loadQuery(
      engine.createQuery((db) =>
        db.selectFrom("todo").select((eb) => eb.fn.countAll().as("c")),
      ),
    );
    expect(Number((count[0] as { c: number }).c)).toBe(0);
  });

  test("spans multiple tables and refreshes each", async () => {
    const engine = makeEngine();
    await engine.ready;

    const result = engine.batch([
      { table: "list", values: { name: "Groceries", count: 2 } },
      { table: "todo", values: { title: "milk", order: "V" } },
      { table: "todo", values: { title: "eggs", order: "W" } },
    ]);
    expect(result.ok).toBe(true);

    const lists = await engine.loadQuery(
      engine.createQuery((db) => db.selectFrom("list").select(["name"])),
    );
    const todos = await engine.loadQuery(
      engine.createQuery((db) => db.selectFrom("todo").select(["title"])),
    );
    expect(lists.length).toBe(1);
    expect(todos.length).toBe(2);
  });

  test("local batch writes don't enqueue", async () => {
    const engine = makeEngine();
    await engine.ready;
    const result = engine.batch(
      [
        { table: "todo", values: { title: "x", order: "V" } },
        { table: "todo", values: { title: "y", order: "W" } },
      ],
      { local: true },
    );
    expect(result.ok).toBe(true);
    await settle();
    expect(engine.getPendingOutboxCount()).toBe(0);
  });
});
