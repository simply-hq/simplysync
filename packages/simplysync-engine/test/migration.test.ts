import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  FiniteNumber,
  id,
  NonEmptyString,
  nullOr,
  SqliteBoolean,
  withDefault,
  type SchemaDefinition,
  type SqliteDriver,
} from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createStore } from "../src/engine/store";
import { memoryDriver } from "./support";

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
    const { driver, db } = memoryDriver();

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
    const { driver, db } = memoryDriver();
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
    const { driver, db } = memoryDriver();
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

describe("defaults and legacy columns", () => {
  test("a column that gains a default backfills the NULLs it already has", () => {
    // Rows written before the default existed hold NULL. Left alone, this
    // device's merged sync payloads would carry NULL where every other
    // platform sends the default — the same row would differ by which device
    // happened to write it last.
    const { driver, db } = memoryDriver();

    const v1: SchemaDefinition = {
      todo: { id: id("Todo"), title: NonEmptyString, done: SqliteBoolean },
    };
    const s1 = storeFor(v1, driver);
    s1.writeRow("todo", {
      id: "t1",
      title: "no default yet",
      done: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "aaa",
      isDeleted: 0,
    });
    expect(
      (db.prepare(`select done from todo where id = 't1'`).get() as { done: unknown }).done,
    ).toBeNull();

    // v2 declares a default for the same column.
    const v2: SchemaDefinition = {
      todo: {
        id: id("Todo"),
        title: NonEmptyString,
        done: withDefault(0 as never)(SqliteBoolean),
      },
    };
    storeFor(v2, driver);

    expect(
      (db.prepare(`select done from todo where id = 't1'`).get() as { done: unknown }).done,
    ).toBe(0);
  });

  test("a default the schema cannot express as SQL is refused at boot", () => {
    // The default is interpolated into the CREATE TABLE / ALTER statement, so
    // anything that is not a finite number or a string has no representation.
    // Failing at schema construction beats emitting DDL that silently means
    // something else.
    const { driver } = memoryDriver();
    const bad: SchemaDefinition = {
      todo: {
        id: id("Todo"),
        title: { ...NonEmptyString, defaultValue: Number.POSITIVE_INFINITY as never },
      },
    };
    expect(() => storeFor(bad, driver)).toThrow(/finite numbers or strings/i);
  });

  test("a database written before payload_json existed still reads as sealed", () => {
    // Older outbox rows carry a real envelope and no payload column at all.
    // After the additive migration they must read as "already sealed" — a row
    // the seal step re-encrypts would get a second nonce, and one it dropped
    // would be an event lost between app versions.
    const { driver, db } = memoryDriver();
    const schema: SchemaDefinition = { todo: { id: id("Todo"), title: NonEmptyString } };

    // Stand in for the pre-migration shape: no payload_json, no retry_after_ms.
    db.exec(
      `create table "_sync_outbox" (event_id text primary key, envelope_json text not null default '', pushed_at text);`,
    );
    db.exec(
      `create table "_sync_deferred" (event_id text primary key, payload_json text not null);`,
    );
    db.prepare(
      `insert into "_sync_outbox" (event_id, envelope_json, pushed_at) values (?, ?, null)`,
    ).run("0000000001-0000-devA", '{"ciphertext":"legacy"}');
    db.prepare(
      `insert into "_sync_deferred" (event_id, payload_json) values (?, ?)`,
    ).run("0000000002-0000-devA", "{}");

    const store = storeFor(schema, driver);

    // Both columns exist now…
    const outboxCols = columnsOf(db, "_sync_outbox");
    expect(outboxCols.has("payload_json")).toBe(true);
    expect(columnsOf(db, "_sync_deferred").has("retry_after_ms")).toBe(true);

    // …the legacy row is not offered to the seal step (payload_json is NULL)…
    expect(store.listUnsealedOutbox()).toEqual([]);
    // …but it is still pushable, with its original envelope intact.
    expect(store.claimPushBatch("http://a")).toEqual([
      { eventId: "0000000001-0000-devA", envelopeJson: '{"ciphertext":"legacy"}' },
    ]);
    // A legacy deferred row starts opaque, so the bounded boot scan classifies it.
    expect(store.listOpaqueDeferredEvents(null, 10).map((r) => r.eventId)).toEqual([
      "0000000002-0000-devA",
    ]);
  });
});
