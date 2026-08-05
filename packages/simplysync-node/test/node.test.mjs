import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSync, id, NonEmptyString, SqliteBoolean } from "@simplysync/engine";
import {
  createKeyValueSecureStorage,
  createNodeSqliteDriver,
  createNodeSyncDeps,
} from "../dist/index.js";

test("node:sqlite driver commits and rolls back nested transactions", () => {
  const driver = createNodeSqliteDriver(":memory:");
  driver.exec("create table item (id text primary key, value integer not null)");
  driver.transaction(() => {
    driver.exec("insert into item values (?, ?)", ["one", 1]);
    assert.throws(() =>
      driver.transaction(() => {
        driver.exec("insert into item values (?, ?)", ["two", 2]);
        throw new Error("rollback");
      }),
    );
  });
  assert.deepEqual(driver.select("select * from item order by id"), [
    { id: "one", value: 1 },
  ]);
  driver.close();
});

test("complete Node deps run the canonical todo engine", async () => {
  const directory = mkdtempSync(join(tmpdir(), "simplysync-node-"));
  const values = new Map();
  const secureStorage = createKeyValueSecureStorage({
    getItem: (key) => values.get(key),
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  });
  const deps = createNodeSyncDeps({ directory, secureStorage });
  const schema = {
    todo: { id: id("todo"), title: NonEmptyString, done: SqliteBoolean },
  };
  const engine = createSync(deps)(schema, { name: "todos" });

  try {
    await engine.ready;
    const inserted = engine.insert("todo", { title: "Buy milk", done: 0 });
    assert.equal(inserted.ok, true);
    const query = engine.createQuery((db) =>
      db
        .selectFrom("todo")
        .select(["title", "done"])
        .where("isDeleted", "=", 0),
    );
    assert.deepEqual(await engine.loadQuery(query), [
      { title: "Buy milk", done: 0 },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    deps.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
