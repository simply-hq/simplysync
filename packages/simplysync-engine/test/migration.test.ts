import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  FiniteNumber,
  id,
  NonEmptyString,
  nullOr,
  SqliteBoolean,
  type SchemaDefinition,
  type SqliteDriver,
} from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createStore } from "../src/engine/store";

// One shared physical database across multiple "app versions", so a store built
// from an evolved schema sees the tables an earlier version created.
function makeSharedDriver(): { driver: SqliteDriver; db: Database } {
  const db = new Database(":memory:");
  const driver: SqliteDriver = {
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
  return { driver, db };
}

function storeFor(schema: SchemaDefinition, driver: SqliteDriver) {
  const state = createEngineState({ name: "migrate-test" });
  state.driver = driver;
  const store = createStore(state, schema, { name: "migrate-test" });
  store.ensureSchema();
  return store;
}

function columnsOf(db: Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`pragma table_info("${table}")`).all() as { name: string }[]).map(
      (c) => c.name,
    ),
  );
}

describe("additive schema migration", () => {
  test("adds a new column to an existing table and preserves old rows", () => {
    const { driver, db } = makeSharedDriver();

    // v1: a todo with just a title.
    const v1: SchemaDefinition = {
      todo: { id: id("Todo"), title: NonEmptyString },
    };
    const s1 = storeFor(v1, driver);
    s1.writeRow("todo", {
      id: "t1",
      title: "buy milk",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "aaa",
      isDeleted: 0,
    });

    // v2: the app grows — todos now have a priority and a due date.
    const v2: SchemaDefinition = {
      todo: {
        id: id("Todo"),
        title: NonEmptyString,
        priority: FiniteNumber,
        dueDate: nullOr(NonEmptyString),
      },
    };
    storeFor(v2, driver);

    const cols = columnsOf(db, "todo");
    expect(cols.has("priority")).toBe(true);
    expect(cols.has("dueDate")).toBe(true);

    // The pre-migration row survives, reading NULL for the new columns.
    const row = db.prepare(`select * from "todo" where id = ?`).get("t1") as {
      title: string;
      priority: number | null;
      dueDate: string | null;
    };
    expect(row.title).toBe("buy milk");
    expect(row.priority).toBeNull();
    expect(row.dueDate).toBeNull();

    // And the new column is writable on a fresh row.
    s1; // (v1 store reference retained only to show both versions coexist)
    const s2 = storeFor(v2, driver);
    s2.writeRow("todo", {
      id: "t2",
      title: "ship release",
      priority: 1,
      dueDate: "2026-07-01",
      createdAt: "2026-06-29T00:00:00.000Z",
      updatedAt: "bbb",
      isDeleted: 0,
    });
    const t2 = db.prepare(`select priority from "todo" where id = ?`).get("t2") as {
      priority: number;
    };
    expect(t2.priority).toBe(1);
  });

  test("creates a brand-new table added in a later schema version", () => {
    const { driver, db } = makeSharedDriver();
    storeFor({ message: { id: id("Message"), body: NonEmptyString } }, driver);

    // v2 adds a `reaction` table alongside the existing `message` table.
    storeFor(
      {
        message: { id: id("Message"), body: NonEmptyString },
        reaction: {
          id: id("Reaction"),
          messageId: id("Message"),
          emoji: NonEmptyString,
        },
      },
      driver,
    );

    const tables = new Set(
      (
        db
          .prepare(`select name from sqlite_master where type = 'table'`)
          .all() as { name: string }[]
      ).map((t) => t.name),
    );
    expect(tables.has("reaction")).toBe(true);
    expect(columnsOf(db, "reaction").has("emoji")).toBe(true);
  });

  test("is idempotent — re-running ensureSchema does not error or duplicate", () => {
    const { driver, db } = makeSharedDriver();
    const schema: SchemaDefinition = {
      note: { id: id("Note"), text: NonEmptyString, pinned: SqliteBoolean },
    };
    storeFor(schema, driver);
    storeFor(schema, driver);
    storeFor(schema, driver);
    const cols = columnsOf(db, "note");
    // id, text, pinned, createdAt, updatedAt, isDeleted — no dupes.
    expect(cols.size).toBe(6);
    expect(cols.has("pinned")).toBe(true);
  });
});
