// End-to-end check of the TodoList web client's headline feature: two engines
// sharing one owner, syncing through a real relay, converging — and resolving a
// conflicting edit last-writer-wins. Spawns the Go relay, so it is NOT part of
// the hermetic `bun test` suite. Run with:
//   bun run apps/todolist/web/sync-check.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createMnemonic, deriveIdentity } from "@simplysync/protocol";
import {
  createSync,
  type AppOwner,
  type SyncEngine,
} from "@simplysync/engine";
import {
  createSqlJsDriverFactory,
  type SnapshotStore,
} from "@simplysync/browser";
import { schema, type TodoSchema } from "./schema";

const RELAY_URL = "http://localhost:4100";
const relayRoot = resolve(import.meta.dir, "../../relay-go");
const WASM_PATH = Bun.resolveSync("sql.js/dist/sql-wasm.wasm", import.meta.dir);

type Engine = SyncEngine<TodoSchema>;

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${message}`);
}

function memStore(): SnapshotStore {
  const m = new Map<string, Uint8Array>();
  return {
    async load(n) {
      return m.get(n) ?? null;
    },
    async save(n, b) {
      m.set(n, b);
    },
  };
}

function secureStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

async function deriveOwner(mnemonic: string): Promise<AppOwner> {
  const id = await deriveIdentity(mnemonic);
  return {
    id: id.ownerId,
    recoveryKey: id.recoveryKey,
    mnemonic: id.mnemonic,
    writeKey: id.relayAuth,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRelay(): Promise<void> {
  for (let i = 0; i < 600; i += 1) {
    try {
      if ((await fetch(`${RELAY_URL}/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("Relay did not become healthy.");
}

async function main(): Promise<void> {
  const relayDirectory = mkdtempSync(
    resolve(tmpdir(), "simplysync-web-relay-"),
  );
  const relayBinary = resolve(relayDirectory, "simplysync-relay");
  let relay: ReturnType<typeof Bun.spawn> | undefined;
  const engines: Engine[] = [];
  const watchdog = setTimeout(() => {
    console.error("WATCHDOG: timed out after 90s");
    relay?.kill();
    rmSync(relayDirectory, { recursive: true, force: true });
    process.exit(2);
  }, 90_000);

  try {
    console.log("building relay…");
    const build = Bun.spawn(["go", "build", "-o", relayBinary, "."], {
      cwd: relayRoot,
      stdout: "ignore",
      stderr: "inherit",
    });
    if ((await build.exited) !== 0) {
      throw new Error("Could not build the Go relay.");
    }

    console.log("spawning relay…");
    relay = Bun.spawn([relayBinary], {
      cwd: relayRoot,
      env: {
        ...process.env,
        RELAY_DATA_DIR: resolve(relayDirectory, "data"),
      },
      stdout: "ignore",
      stderr: "inherit",
    });
    await waitForRelay();
    console.log("relay healthy; creating engines…");

    const owner = await deriveOwner(createMnemonic());
    const shared = secureStorage();
    const createSqliteDriver = createSqlJsDriverFactory({
      store: memStore(),
      locateFile: () => WASM_PATH,
      writerLock: "disabled",
    });
    const make = (name: string): Engine =>
      createSync({ createSqliteDriver, secureStorage: shared, reloadApp: () => undefined })(
        schema,
        { name, externalAppOwner: owner, transports: [{ type: "Http", url: RELAY_URL }], syncIntervalMs: 600_000 },
      );

    const alice = make("sync-check-alice");
    const bob = make("sync-check-bob");
    engines.push(alice, bob);
    await Promise.all([alice.ready, bob.ready]);
    console.log("engines ready; inserting on Alice…");

    const query = alice.createQuery((db) =>
      db
        .selectFrom("todo")
        .select(["id", "title", "done"])
        .where("isDeleted", "=", 0),
    );
    const titleOf = async (engine: Engine, id: string) =>
      (await engine.loadQuery(query)).find((row) => row.id === id)?.title;

    // Writes enqueue their envelope asynchronously (after AES-GCM encryption),
    // so settle briefly, then run two full bidirectional rounds so each device
    // both pushes its own events and pulls the other's.
    const syncAll = async () => {
      await sleep(200);
      for (let i = 0; i < 2; i += 1) {
        await alice.sync();
        await bob.sync();
      }
      await sleep(50);
    };

    // 1) Alice writes; Bob converges.
    const inserted = alice.insert("todo", { title: "Buy milk", done: 0 });
    assert(inserted.ok, "insert ok");
    if (!inserted.ok) return;
    const id = inserted.value.id;

    await syncAll();
    assert((await titleOf(bob, id)) === "Buy milk", "Bob received Alice's todo");
    console.log("✓ two-device sync: Bob converged on Alice's write");

    // 2) Conflict: both edit the same row; the later HLC wins on both devices.
    alice.update("todo", { id, title: "Alice edit" });
    await sleep(20); // ensure Bob's HLC is strictly later
    bob.update("todo", { id, title: "Bob edit" });
    await syncAll();

    const a = await titleOf(alice, id);
    const b = await titleOf(bob, id);
    assert(a === b, `convergence: alice(${a}) === bob(${b})`);
    assert(b === "Bob edit", `last-writer-wins: later edit won, got ${b}`);
    console.log(`✓ last-writer-wins: both devices converged on ${b}`);

    console.log("\nsync-check OK ✅");
  } finally {
    clearTimeout(watchdog);
    for (const engine of engines) engine.setTransports([]);
    relay?.kill();
    await relay?.exited.catch(() => undefined);
    rmSync(relayDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
