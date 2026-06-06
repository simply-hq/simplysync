// Headless test for the relational schema: a category + an entry referencing it,
// read back through the leftJoin query the UI uses (category name as a flat
// column), plus soft-delete hiding. No relay needed. Run with:
//   bun test apps/simplysync-docs/playground/relational.test.ts
import { expect, test } from "bun:test";
import { createSync, sqliteTrue, type SyncEngine } from "@simplysync/engine";
import { schema, type PlaygroundSchema } from "./schema";
import { createSqlJsDriverFactory, type SnapshotStore } from "./sql-driver";

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
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

function makeEngine(): SyncEngine<PlaygroundSchema> {
  return createSync({
    createSqliteDriver: createSqlJsDriverFactory({
      store: makeStore(),
      locateFile: () => WASM_PATH,
    }),
    secureStorage: makeSecureStorage(),
    reloadApp: () => undefined,
  })(schema, { name: "playground-relational" });
}

const joinQuery = (engine: SyncEngine<PlaygroundSchema>) =>
  engine.createQuery((db) =>
    db
      .selectFrom("entry")
      .leftJoin("category", "category.id", "entry.categoryId")
      .select([
        "entry.id as id",
        "entry.description as description",
        "category.name as categoryName",
      ])
      .where("entry.isDeleted", "=", 0)
      .orderBy("entry.createdAt", "desc"),
  );

test("leftJoin resolves the category name, soft-delete hides the row", async () => {
  const engine = makeEngine();
  await engine.ready;

  const category = engine.insert("category", { name: "Food" });
  expect(category.ok).toBe(true);
  if (!category.ok) return;

  const entry = engine.insert("entry", {
    description: "Coffee",
    amountCents: -450,
    categoryId: category.value.id,
  });
  expect(entry.ok).toBe(true);
  if (!entry.ok) return;

  const rows = engine.getQueryRows(joinQuery(engine));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.description).toBe("Coffee");
  expect(rows[0]?.categoryName).toBe("Food");

  // An entry with no category still appears, with a null category name.
  engine.insert("entry", { description: "Uncategorized", amountCents: 100 });
  const withUncategorized = engine.getQueryRows(joinQuery(engine));
  expect(withUncategorized).toHaveLength(2);
  expect(
    withUncategorized.find((r) => r.description === "Uncategorized")?.categoryName,
  ).toBeNull();

  // Soft delete removes the entry from the query.
  engine.update("entry", { id: entry.value.id, isDeleted: sqliteTrue });
  const afterDelete = engine.getQueryRows(joinQuery(engine));
  expect(afterDelete.find((r) => r.id === entry.value.id)).toBeUndefined();
});
