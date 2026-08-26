// The reactive query cache's stability contract (query-cache.ts:14-19): a
// cached query's `rows` array reference must only change when the data does.
// `refreshQueries` re-runs every query touched by a mutation's tables, but
// must diff the result against the cached one — unchanged results keep the
// old reference and fire no listeners; changed results swap the reference and
// notify. This file proves both halves, plus the two ways it could go wrong:
// under-notifying (stale UI) and over-notifying (lost optimization only, but
// checked here too since it's cheap to assert).

import { describe, expect, test } from "bun:test";

import {
  createSync,
  id,
  NonEmptyString,
  SqliteBoolean,
  sqliteFalse,
  sqliteTrue,
} from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

const schema = {
  task: {
    id: id("Task"),
    title: NonEmptyString,
    done: SqliteBoolean,
  },
};

function makeApp() {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "query-cache-app" });
}

describe("query-cache result diffing (stable rows reference)", () => {
  test("unchanged result: listener not fired, same array reference returned", async () => {
    const engine = makeApp();
    await engine.ready;

    engine.insert("task", { title: "Done task", done: sqliteTrue });

    const doneQuery = engine.createQuery(
      (db) =>
        db.selectFrom("task").select(["id", "title"]).where("done", "=", sqliteTrue),
      { includeDeleted: true },
    );
    const before = engine.getQueryRows(doneQuery);
    expect(before).toHaveLength(1);

    let fired = 0;
    const unsubscribe = engine.subscribeQuery(doneQuery)(() => {
      fired += 1;
    });

    // Same table, but this insert doesn't belong to doneQuery's result set.
    engine.insert("task", { title: "Not done task", done: sqliteFalse });

    const after = engine.getQueryRows(doneQuery);
    expect(fired).toBe(0);
    expect(after).toBe(before);

    unsubscribe();
  });

  test("real change: listener fires and a new reference with updated data is returned", async () => {
    const engine = makeApp();
    await engine.ready;

    const created = engine.insert("task", { title: "Task", done: sqliteFalse });
    if (!created.ok) throw new Error("insert failed");

    const doneQuery = engine.createQuery(
      (db) =>
        db.selectFrom("task").select(["id", "title"]).where("done", "=", sqliteTrue),
      { includeDeleted: true },
    );
    const before = engine.getQueryRows(doneQuery);
    expect(before).toHaveLength(0);

    let fired = 0;
    const unsubscribe = engine.subscribeQuery(doneQuery)(() => {
      fired += 1;
    });

    engine.update("task", { id: created.value.id, done: sqliteTrue });

    const after = engine.getQueryRows(doneQuery);
    expect(fired).toBeGreaterThan(0);
    expect(after).not.toBe(before);
    expect(after).toHaveLength(1);
    expect(after[0]?.title).toBe("Task");

    unsubscribe();
  });

  test("two queries on one table: a change affecting only one fires only that one's listeners", async () => {
    const engine = makeApp();
    await engine.ready;

    const a = engine.insert("task", { title: "A", done: sqliteFalse });
    const b = engine.insert("task", { title: "B", done: sqliteFalse });
    if (!a.ok || !b.ok) throw new Error("insert failed");

    const doneQuery = engine.createQuery(
      (db) => db.selectFrom("task").select(["id"]).where("done", "=", sqliteTrue),
      { includeDeleted: true },
    );
    // Selects only `id`, so toggling `done` on an existing row doesn't change
    // this query's result set (same ids, same order).
    const allIdsQuery = engine.createQuery(
      (db) => db.selectFrom("task").select(["id"]).orderBy("id"),
      { includeDeleted: true },
    );

    void engine.getQueryRows(doneQuery);
    const allBefore = engine.getQueryRows(allIdsQuery);

    let doneFired = 0;
    let allFired = 0;
    const unsubDone = engine.subscribeQuery(doneQuery)(() => (doneFired += 1));
    const unsubAll = engine.subscribeQuery(allIdsQuery)(() => (allFired += 1));

    engine.update("task", { id: a.value.id, done: sqliteTrue });

    expect(doneFired).toBeGreaterThan(0);
    expect(allFired).toBe(0);
    expect(engine.getQueryRows(allIdsQuery)).toBe(allBefore);

    unsubDone();
    unsubAll();
  });

  test("same row count, different values still fires (anti-regression for a too-loose equality)", async () => {
    const engine = makeApp();
    await engine.ready;

    const created = engine.insert("task", {
      title: "Original",
      done: sqliteFalse,
    });
    if (!created.ok) throw new Error("insert failed");

    const query = engine.createQuery(
      (db) => db.selectFrom("task").select(["id", "title"]),
      { includeDeleted: true },
    );
    const before = engine.getQueryRows(query);
    expect(before).toHaveLength(1);

    let fired = 0;
    const unsubscribe = engine.subscribeQuery(query)(() => {
      fired += 1;
    });

    // Row count is unchanged (still 1 row) but the title value did change —
    // a length-only or count-only comparison would wrongly treat this as
    // unchanged and produce a stale read.
    engine.update("task", { id: created.value.id, title: "Renamed" });

    const after = engine.getQueryRows(query);
    expect(fired).toBeGreaterThan(0);
    expect(after).not.toBe(before);
    expect(after[0]?.title).toBe("Renamed");

    unsubscribe();
  });

  test("a re-subscribe after eviction still receives updates", async () => {
    // The last unsubscribe evicts the cache entry. A re-subscribe (e.g. a
    // memoized subscribe closure re-invoked on remount) must attach to a live
    // entry, not an orphan refreshQueries never iterates — otherwise the query
    // silently stops updating.
    const engine = makeApp();
    await engine.ready;
    engine.insert("task", { title: "First", done: sqliteFalse });

    const query = engine.createQuery(
      (db) => db.selectFrom("task").select(["id", "title"]),
      { includeDeleted: true },
    );

    // Subscribe then fully unsubscribe → entry evicted.
    const subscribe = engine.subscribeQuery(query);
    subscribe(() => {})();

    // Re-subscribe against the same query and confirm a later mutation fires.
    let fired = 0;
    const unsubscribe = subscribe(() => {
      fired += 1;
    });
    engine.insert("task", { title: "Second", done: sqliteFalse });
    expect(fired).toBeGreaterThan(0);
    unsubscribe();
  });
});
