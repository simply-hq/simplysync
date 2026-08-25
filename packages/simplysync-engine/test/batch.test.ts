import { describe, expect, test } from "bun:test";

import {
  createSync,
  FiniteNumber,
  id,
  keysBetween,
  NonEmptyString,
} from "../src/index";
import { memoryDriver, memoryStorage, settle } from "./support";

const schema = {
  todo: { id: id("Todo"), title: NonEmptyString, order: NonEmptyString },
  list: { id: id("List"), name: NonEmptyString, count: FiniteNumber },
};

function makeEngine() {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "batch-test" });
}


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
      engine.createQuery(
        (db) => db.selectFrom("todo").select(["title", "order"]).orderBy("order"),
        { includeDeleted: true },
      ),
    );
    expect(rows.map((r) => r.title)).toEqual(["a", "b", "c", "d", "e"]);

    await settle(engine);
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
      engine.createQuery(
        (db) => db.selectFrom("todo").select((eb) => eb.fn.countAll().as("c")),
        { includeDeleted: true },
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
      engine.createQuery((db) => db.selectFrom("list").select(["name"]), {
        includeDeleted: true,
      }),
    );
    const todos = await engine.loadQuery(
      engine.createQuery((db) => db.selectFrom("todo").select(["title"]), {
        includeDeleted: true,
      }),
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
    await settle(engine);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });

  test("compare-and-set rejects a stale single-row editor snapshot", async () => {
    const engine = makeEngine();
    await engine.ready;
    const inserted = engine.insert("todo", { title: "original", order: "V" });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const snapshot = await engine.loadQuery(
      engine.createQuery(
        (db) => db.selectFrom("todo").select(["id", "updatedAt"]),
        { includeDeleted: true },
      ),
    );
    const version = snapshot[0]!.updatedAt;
    expect(
      engine.update(
        "todo",
        { id: inserted.value.id, title: "newer" },
        { expectedUpdatedAt: version },
      ).ok,
    ).toBe(true);

    const stale = engine.update(
      "todo",
      { id: inserted.value.id, title: "stale overwrite" },
      { expectedUpdatedAt: version },
    );
    expect(stale.ok).toBe(false);
    if (stale.ok) return;
    expect(stale.error.message).toContain("Write conflict");

    const rows = await engine.loadQuery(
      engine.createQuery((db) => db.selectFrom("todo").select(["title"]), {
        includeDeleted: true,
      }),
    );
    expect(rows[0]!.title).toBe("newer");
  });

  test("restore compare-and-sets the exact tombstone", async () => {
    const engine = makeEngine();
    await engine.ready;
    const inserted = engine.insert("todo", { title: "restore me", order: "V" });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;

    const versions = async () =>
      engine.loadQuery(
        engine.createQuery(
          (db) =>
            db
              .selectFrom("todo")
              .select(["id", "updatedAt", "isDeleted"])
              .where("id", "=", inserted.value.id),
          { includeDeleted: true },
        ),
      );
    const liveVersion = (await versions())[0]!.updatedAt;
    expect(
      engine.delete("todo", inserted.value.id, {
        expectedUpdatedAt: liveVersion,
      }).ok,
    ).toBe(true);
    const tombstoneVersion = (await versions())[0]!.updatedAt;

    expect(
      engine.restore("todo", inserted.value.id, tombstoneVersion).ok,
    ).toBe(true);
    expect((await versions())[0]!.isDeleted).toBe(0);

    const staleRestore = engine.restore(
      "todo",
      inserted.value.id,
      tombstoneVersion,
    );
    expect(staleRestore.ok).toBe(false);
    if (!staleRestore.ok) {
      expect(staleRestore.error.message).toContain("Write conflict");
    }
  });

  test("a stale second compare-and-set rolls back the whole batch", async () => {
    const engine = makeEngine();
    await engine.ready;
    const seeded = engine.batch([
      { table: "todo", values: { id: "first", title: "first", order: "V" } },
      { table: "todo", values: { id: "second", title: "second", order: "W" } },
    ]);
    expect(seeded.ok).toBe(true);

    const snapshot = await engine.loadQuery(
      engine.createQuery(
        (db) => db.selectFrom("todo").select(["id", "updatedAt"]),
        { includeDeleted: true },
      ),
    );
    const versions = new Map(snapshot.map((row) => [row.id, row.updatedAt]));
    expect(
      engine.update("todo", { id: "second", title: "newer second" }).ok,
    ).toBe(true);

    const result = engine.batch([
      {
        table: "todo",
        mode: "update",
        values: { id: "first", title: "must roll back" },
        expectedUpdatedAt: versions.get("first")!,
      },
      {
        table: "todo",
        mode: "update",
        values: { id: "second", title: "stale second" },
        expectedUpdatedAt: versions.get("second")!,
      },
    ]);
    expect(result.ok).toBe(false);

    const rows = await engine.loadQuery(
      engine.createQuery(
        (db) => db.selectFrom("todo").select(["id", "title"]).orderBy("id"),
        { includeDeleted: true },
      ),
    );
    expect(rows.map((row) => row.title)).toEqual(["first", "newer second"]);
  });
});

describe("batch isolation", () => {
  test("an op cannot read a write made earlier in the same batch", async () => {
    // Every op is prepared against the pre-batch state so the whole batch can
    // be validated before anything is written — which is what makes a single
    // invalid op abort the batch cleanly. The cost is no read-your-writes:
    // an update that expects an insert from the same batch sees nothing.
    const engine = makeEngine();
    await engine.ready;

    const result = engine.batch([
      { table: "todo", values: { id: "t1", title: "created here" }, mode: "insert" },
      { table: "todo", values: { id: "t1", title: "renamed here" }, mode: "update" },
    ]);

    // The update was prepared against a database where t1 did not exist yet.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/not found/i);

    // Nothing at all was written — the whole batch aborted before the insert.
    const rows = await engine.loadQuery(
      engine.createQuery((db) =>
        db.selectFrom("todo").select(["id"]).where("isDeleted", "=", 0),
      ),
    );
    expect(rows).toHaveLength(0);

    // Two separate calls are the supported shape for a dependent write.
    expect(engine.insert("todo", { id: "t1", title: "created here" }).ok).toBe(true);
    expect(engine.update("todo", { id: "t1", title: "renamed here" }).ok).toBe(true);
  });
});
