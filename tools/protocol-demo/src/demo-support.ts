// Shared harness for the runnable demos (run-with-relay.ts, blob-demo.ts) and
// the CLI (index.ts): repo paths, the relay URL, a health probe, and SQLite
// file cleanup. Kept in one place so each demo entrypoint doesn't re-roll the
// same boilerplate.

import { unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const exampleRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const relayRoot = resolve(exampleRoot, "../../apps/relay-go");
export const relayUrl = process.env.RELAY_URL ?? "http://localhost:4100";

/**
 * Deletes the SQLite main/-wal/-shm files for a database at `basePath` (a path
 * without the `.db` extension). Missing files are ignored.
 */
export function removeSqliteFiles(basePath: string): void {
  for (const suffix of [".db", ".db-shm", ".db-wal"]) {
    try {
      unlinkSync(`${basePath}${suffix}`);
    } catch {}
  }
}

export async function isRelayHealthy(): Promise<boolean> {
  try {
    return (await fetch(`${relayUrl}/health`)).ok;
  } catch {
    return false;
  }
}

export async function waitForRelay(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isRelayHealthy()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Relay did not become healthy at ${relayUrl}.`);
}

export function cleanExampleData(): void {
  for (const client of ["alice", "bob"]) {
    removeSqliteFiles(resolve(exampleRoot, "data", client));
  }
}

export function cleanRelayData(): void {
  removeSqliteFiles(resolve(relayRoot, "data", "relay"));
}
