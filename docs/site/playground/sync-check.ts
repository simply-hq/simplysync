// End-to-end check of the playground's headline feature: two engines (devices)
// sharing one owner, syncing through a real relay, converging — and resolving a
// conflicting edit last-writer-wins. Spawns the Go relay, so it is NOT part of
// the hermetic `bun test` suite. Run with:
//   bun run docs/site/playground/sync-check.ts
import { resolve } from "node:path";
import { createMnemonic, deriveIdentity } from "@simplysync/protocol";
import {
  createSync,
  type AppOwner,
  type SyncEngine,
} from "@simplysync/engine";
import { schema, type PlaygroundSchema } from "./schema";
import { createSqlJsDriverFactory, type SnapshotStore } from "./sql-driver";

const RELAY_URL = "http://localhost:4100";
const relayRoot = resolve(import.meta.dir, "../../../relays/go");
const WASM_PATH = Bun.resolveSync("sql.js/dist/sql-wasm.wasm", import.meta.dir);

type Engine = SyncEngine<PlaygroundSchema>;

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
  return { id: id.ownerId, mnemonic, writeKey: id.relayAuth };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForRelay(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
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
  const watchdog = setTimeout(() => {
    console.error("WATCHDOG: timed out after 25s");
    process.exit(2);
  }, 25_000);

  console.log("spawning relay…");
  const relay = Bun.spawn(["go", "run", "."], {
    cwd: relayRoot,
    stdout: "ignore",
    stderr: "inherit",
  });

  try {
    await waitForRelay();
    console.log("relay healthy; creating engines…");

    const owner = await deriveOwner(createMnemonic());
    const shared = secureStorage();
    const createSqliteDriver = createSqlJsDriverFactory({
      store: memStore(),
      locateFile: () => WASM_PATH,
    });
    const make = (name: string): Engine =>
      createSync({ createSqliteDriver, secureStorage: shared, reloadApp: () => undefined })(
        schema,
        { name, externalAppOwner: owner, transports: [{ type: "Http", url: RELAY_URL }], syncIntervalMs: 600_000 },
      );

    const alice = make("sync-check-alice");
    const bob = make("sync-check-bob");
    await Promise.all([alice.ready, bob.ready]);
    console.log("engines ready; inserting on Alice…");

    const q = alice.createQuery((db) =>
      db.selectFrom("entry").select(["id", "description", "amountCents"]).where("isDeleted", "=", 0),
    );
    const amountOf = async (e: Engine, id: string) =>
      (await e.loadQuery(q)).find((r) => r.id === id)?.amountCents;

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
    const inserted = alice.insert("entry", { description: "Coffee", amountCents: -450 });
    assert(inserted.ok, "insert ok");
    if (!inserted.ok) return;
    const id = inserted.value.id;

    await syncAll();
    assert((await amountOf(bob, id)) === -450, "Bob received Alice's entry (-450)");
    console.log("✓ two-device sync: Bob converged on Alice's write");

    // 2) Conflict: both edit the same row; the later HLC wins on both devices.
    alice.update("entry", { id, amountCents: -999 });
    await sleep(20); // ensure Bob's HLC is strictly later
    bob.update("entry", { id, amountCents: -111 });
    await syncAll();

    const a = await amountOf(alice, id);
    const b = await amountOf(bob, id);
    assert(a === b, `convergence: alice(${a}) === bob(${b})`);
    assert(b === -111, `last-writer-wins: later edit (-111) won, got ${b}`);
    console.log(`✓ last-writer-wins: both devices converged on ${b}`);

    console.log("\nsync-check OK ✅");
    clearTimeout(watchdog);
  } finally {
    relay.kill();
    await relay.exited.catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
