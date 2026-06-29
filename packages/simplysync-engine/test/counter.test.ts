import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  counterColumns,
  counterTotalQuery,
  createSync,
  decrementCounter,
  id,
  incrementCounter,
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
  counter: counterColumns(),
  message: { id: id("Message"), body: NonEmptyString },
};

function makeEngine() {
  return createSync({
    createSqliteDriver: () => makeDriver(),
    secureStorage: memoryStorage(),
  })(schema, { name: "counter-test" });
}

const totalOf = async (
  engine: ReturnType<typeof makeEngine>,
  key: string,
): Promise<number> => {
  const rows = await engine.loadQuery(
    counterTotalQuery(engine, "counter", key),
  );
  return rows[0]?.total ?? 0;
};

describe("conflict-free counter", () => {
  test("empty counter reads 0", async () => {
    const engine = makeEngine();
    await engine.ready;
    expect(await totalOf(engine, "m1:like")).toBe(0);
  });

  test("increments and decrements sum correctly", async () => {
    const engine = makeEngine();
    await engine.ready;
    incrementCounter(engine, "counter", "m1:like");
    incrementCounter(engine, "counter", "m1:like");
    incrementCounter(engine, "counter", "m1:like");
    decrementCounter(engine, "counter", "m1:like"); // someone un-liked
    expect(await totalOf(engine, "m1:like")).toBe(2);
  });

  test("counters with different keys are independent", async () => {
    const engine = makeEngine();
    await engine.ready;
    incrementCounter(engine, "counter", "m1:like", 3);
    incrementCounter(engine, "counter", "m1:thumbsdown", 5);
    expect(await totalOf(engine, "m1:like")).toBe(3);
    expect(await totalOf(engine, "m1:thumbsdown")).toBe(5);
  });

  test("rapid concurrent-style increments never lose an update", async () => {
    const engine = makeEngine();
    await engine.ready;
    // 100 increments fired without awaiting between them — the very pattern a
    // single-integer LWW column would collapse to 1. As distinct delta rows,
    // all 100 survive.
    for (let i = 0; i < 100; i++) incrementCounter(engine, "counter", "burst");
    expect(await totalOf(engine, "burst")).toBe(100);
  });

  test("supports arbitrary amounts (e.g. unread badge math)", async () => {
    const engine = makeEngine();
    await engine.ready;
    incrementCounter(engine, "counter", "inbox:unread", 4); // 4 new messages
    incrementCounter(engine, "counter", "inbox:unread", 2); // 2 more
    decrementCounter(engine, "counter", "inbox:unread", 5); // read 5
    expect(await totalOf(engine, "inbox:unread")).toBe(1);
  });

  test("integrates with batch for many counters at once", async () => {
    const engine = makeEngine();
    await engine.ready;
    const result = engine.batch([
      { table: "counter", values: { counterKey: "a", delta: 2 } },
      { table: "counter", values: { counterKey: "b", delta: 3 } },
      { table: "counter", values: { counterKey: "a", delta: 5 } },
    ]);
    expect(result.ok).toBe(true);
    expect(await totalOf(engine, "a")).toBe(7);
    expect(await totalOf(engine, "b")).toBe(3);
  });
});
