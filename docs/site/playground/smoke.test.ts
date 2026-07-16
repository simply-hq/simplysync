// Headless integration test for the playground's hard part: the sql.js
// SqliteDriver + the engine + encryption + the snapshot/reload path. sql.js runs
// under Bun, so this exercises everything except the React/DOM layer without a
// browser. Run with: bun test docs/site/playground/smoke.test.ts
import { afterAll, expect, test } from "bun:test";
import { createSync, type SyncEngine } from "@simplysync/engine";
import { schema, type PlaygroundSchema } from "./schema";
import {
  createSqlJsDriverFactory,
  getActiveDb,
  persistNow,
  type SnapshotStore,
} from "./sql-driver";

const WASM_PATH = Bun.resolveSync("sql.js/dist/sql-wasm.wasm", import.meta.dir);

// In-memory stand-ins for the browser's IndexedDB + localStorage.
function makeStore(): SnapshotStore & { snapshots: Map<string, Uint8Array> } {
  const snapshots = new Map<string, Uint8Array>();
  return {
    snapshots,
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

function makeEngine(
  store: SnapshotStore,
  secureStorage: ReturnType<typeof makeSecureStorage>,
): SyncEngine<PlaygroundSchema> {
  return createSync({
    createSqliteDriver: createSqlJsDriverFactory({
      store,
      locateFile: () => WASM_PATH,
    }),
    secureStorage,
    reloadApp: () => undefined,
  })(schema, { name: "playground-smoke" });
}

const entriesQuery = (engine: SyncEngine<PlaygroundSchema>) =>
  engine.createQuery((db) =>
    db
      .selectFrom("entry")
      .select(["id", "description", "amountCents"])
      .where("isDeleted", "=", 0)
      .orderBy("createdAt", "desc"),
  );

function readOutbox(): string[] {
  const db = getActiveDb();
  if (!db) return [];
  // Only SEALED rows: an outbox row now appears synchronously with the write,
  // holding a plaintext-pending marker (envelope_json = '') until the async
  // seal step encrypts it (see the engine's sealPendingOutbox). Filtering out
  // unsealed rows makes `waitFor` block until a real envelope exists, so the
  // JSON.parse below always gets ciphertext rather than an empty placeholder.
  const stmt = db.prepare(
    `select envelope_json from "_sync_outbox" where envelope_json != ''`,
  );
  try {
    const rows: string[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject().envelope_json as string);
    return rows;
  } finally {
    stmt.free();
  }
}

async function waitFor<T>(fn: () => T | null | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const value = fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("waitFor timed out");
}

const store = makeStore();
const secureStorage = makeSecureStorage();

afterAll(async () => {
  await persistNow();
});

test("insert is reactive, encrypted, and persists across a reload", async () => {
  const engine = makeEngine(store, secureStorage);
  await engine.ready;

  const result = engine.insert("entry", {
    description: "Coffee",
    amountCents: -450,
  });
  expect(result.ok).toBe(true);

  // Reactive read reflects the write.
  const rows = engine.getQueryRows(entriesQuery(engine));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.description).toBe("Coffee");
  expect(rows[0]?.amountCents).toBe(-450);

  // The outbox holds the exact envelope a relay would receive — and it's opaque.
  const envelopes = await waitFor(() => {
    const e = readOutbox();
    return e.length > 0 ? e : null;
  });
  const envelope = JSON.parse(envelopes[0]) as {
    nonce: string;
    ciphertext: string;
    ownerId: string;
  };
  expect(envelope.nonce.length).toBeGreaterThan(0);
  expect(envelope.ciphertext.length).toBeGreaterThan(0);
  // The plaintext must NOT appear anywhere in what the relay stores.
  expect(envelopes[0]).not.toContain("Coffee");
  expect(envelopes[0]).not.toContain("amountCents");

  // Snapshot, then "reload" into a fresh engine sharing the same stores.
  await persistNow();
  expect(store.snapshots.get("playground-smoke")?.length ?? 0).toBeGreaterThan(0);

  const reloaded = makeEngine(store, secureStorage);
  await reloaded.ready;
  const afterReload = reloaded.getQueryRows(entriesQuery(reloaded));
  expect(afterReload).toHaveLength(1);
  expect(afterReload[0]?.description).toBe("Coffee");
});
