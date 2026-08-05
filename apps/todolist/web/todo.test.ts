// Headless contract test for the canonical cross-platform todo schema. It
// exercises insert, update, and replicated soft-delete semantics without a
// relay. Run with:
//   bun test apps/todolist/web/todo.test.ts
import { expect, test } from "bun:test";
import { createSync, type SyncEngine } from "@simplysync/engine";
import {
  closeSqlJsDatabases,
  createSqlJsDriverFactory,
  type SnapshotStore,
} from "@simplysync/browser";
import { schema, type TodoSchema } from "./schema";

const WASM_PATH = Bun.resolveSync("sql.js/dist/sql-wasm.wasm", import.meta.dir);

function makeStore(): SnapshotStore {
  const snapshots = new Map<string, Uint8Array>();
  return {
    async load(name) {
      return snapshots.get(name) ?? null;
    },
    async save(name, bytes) {
      snapshots.set(name, bytes);
    },
  };
}

function makeSecureStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function makeEngine(): SyncEngine<TodoSchema> {
  return createSync({
    createSqliteDriver: createSqlJsDriverFactory({
      store: makeStore(),
      locateFile: () => WASM_PATH,
      writerLock: "disabled",
    }),
    secureStorage: makeSecureStorage(),
    reloadApp: () => undefined,
  })(schema, { name: "todolist-web-contract" });
}

const todoQuery = (engine: SyncEngine<TodoSchema>) =>
  engine.createQuery((db) =>
    db
      .selectFrom("todo")
      .select(["id", "title", "done"])
      .where("isDeleted", "=", 0)
      .orderBy("updatedAt", "desc"),
  );

test("todo insert, toggle, and soft delete use the canonical schema", async () => {
  const engine = makeEngine();
  await engine.ready;

  const inserted = engine.insert("todo", { title: "Buy milk", done: 0 });
  expect(inserted.ok).toBe(true);
  if (!inserted.ok) return;

  expect(engine.getQueryRows(todoQuery(engine))).toEqual([
    { id: inserted.value.id, title: "Buy milk", done: 0 },
  ]);

  const toggled = engine.update("todo", { id: inserted.value.id, done: 1 });
  expect(toggled.ok).toBe(true);
  expect(engine.getQueryRows(todoQuery(engine))[0]?.done).toBe(1);

  const removed = engine.delete("todo", inserted.value.id);
  expect(removed.ok).toBe(true);
  expect(engine.getQueryRows(todoQuery(engine))).toEqual([]);

  await closeSqlJsDatabases("todolist-web-contract");
});
