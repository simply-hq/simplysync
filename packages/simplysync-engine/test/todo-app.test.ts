// Reference scenario: a local-first TODO app built end-to-end on the engine.
// Exercises the primitives the way a real app would compose them — fractional
// ordering (drag to reorder), JSON tags, toggling done, search, bulk seed, and
// soft-delete / clear-completed — so this doubles as living documentation that
// the API is ergonomic for this use case.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  decodeJsonOr,
  encodeJson,
  FractionalIndex,
  id,
  JsonText,
  keyBetween,
  keysBetween,
  NonEmptyString,
  nullOr,
  searchFilter,
  SqliteBoolean,
  sqliteFalse,
  sqliteTrue,
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
  todo: {
    id: id("Todo"),
    title: NonEmptyString,
    order: FractionalIndex,
    done: SqliteBoolean,
    tags: nullOr(JsonText),
  },
};

function makeApp() {
  return createSync({
    createSqliteDriver: () => makeDriver(),
    secureStorage: memoryStorage(),
  })(schema, { name: "todo-app" });
}

type Engine = ReturnType<typeof makeApp>;

// The app's "ordered, not-deleted todos" view.
const listTodos = (engine: Engine) =>
  engine.loadQuery(
    engine.createQuery((db) =>
      db
        .selectFrom("todo")
        .select(["id", "title", "order", "done", "tags"])
        .where("isDeleted", "=", 0)
        .orderBy("order")
        .orderBy("id"), // tie-break, mirrors compareOrderKeys
    ),
  );

describe("todo app", () => {
  test("seed, reorder, tag, complete, search, and clear-completed", async () => {
    const engine = makeApp();
    await engine.ready;

    // Seed three todos in order with spread keys, in one atomic batch.
    const titles = ["Buy milk", "Walk dog", "Write report"];
    const orders = keysBetween(null, null, titles.length);
    const seed = engine.batch(
      titles.map((title, i) => ({
        table: "todo" as const,
        values: { title, order: orders[i]!, done: sqliteFalse },
      })),
    );
    expect(seed.ok).toBe(true);
    expect((await listTodos(engine)).map((t) => t.title)).toEqual(titles);

    // Drag "Write report" to the top: only its order changes.
    const before = await listTodos(engine);
    const top = before[0]!;
    const report = before.find((t) => t.title === "Write report")!;
    engine.update("todo", {
      id: report.id,
      order: keyBetween(null, top.order as string),
    });
    expect((await listTodos(engine)).map((t) => t.title)).toEqual([
      "Write report",
      "Buy milk",
      "Walk dog",
    ]);

    // Add a todo between the first two (insert-between, no renumber).
    const cur = await listTodos(engine);
    engine.insert("todo", {
      title: "Email boss",
      order: keyBetween(cur[0]!.order as string, cur[1]!.order as string),
      done: sqliteFalse,
    });
    expect((await listTodos(engine)).map((t) => t.title)).toEqual([
      "Write report",
      "Email boss",
      "Buy milk",
      "Walk dog",
    ]);

    // Tag a todo with structured data, then read it back.
    engine.update("todo", {
      id: report.id,
      tags: encodeJson(["work", "urgent"]),
    });
    const tagged = (await listTodos(engine)).find((t) => t.id === report.id)!;
    expect(decodeJsonOr<string[]>(tagged.tags, [])).toEqual(["work", "urgent"]);

    // Complete two todos.
    engine.update("todo", { id: report.id, done: sqliteTrue });
    const milk = (await listTodos(engine)).find((t) => t.title === "Buy milk")!;
    engine.update("todo", { id: milk.id, done: sqliteTrue });

    // Search by title.
    const hits = await engine.loadQuery(
      engine.createQuery((db) =>
        db
          .selectFrom("todo")
          .select(["title"])
          .where("isDeleted", "=", 0)
          .where(searchFilter(["title"], "report")),
      ),
    );
    expect(hits.map((h) => h.title)).toEqual(["Write report"]);

    // Clear completed: collect done ids and soft-delete them in one batch.
    const doneIds = (await listTodos(engine))
      .filter((t) => t.done === sqliteTrue)
      .map((t) => t.id);
    expect(doneIds.length).toBe(2);
    const cleared = engine.deleteMany("todo", doneIds);
    expect(cleared.ok).toBe(true);

    const remaining = (await listTodos(engine)).map((t) => t.title);
    expect(remaining).toEqual(["Email boss", "Walk dog"]);
  });
});
