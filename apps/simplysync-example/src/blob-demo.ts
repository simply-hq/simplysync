import { unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Base64UrlBytes } from "@simplysync/core";
import { LocalFirstClient } from "./client";

// End-to-end demo of lazy, encrypted image sync:
//   1. Alice encrypts + chunks an image, uploads the chunk bytes, syncs only a
//      tiny manifest.
//   2. Bob (same recovery key, different device) syncs and learns the image
//      exists WITHOUT downloading any pixels.
//   3. Bob reads the image, which lazily fetches + verifies + decrypts chunks.

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(exampleRoot, "../..");
const relayRoot = resolve(repoRoot, "apps/simplysync-relay");
const relayUrl = process.env.RELAY_URL ?? "http://localhost:4100";

const IMAGE_BYTES = 600_000; // ~3 chunks at the 256 KiB default

async function main(): Promise<void> {
  cleanData();

  let relayProcess: Bun.Subprocess | null = null;
  if (!(await isRelayHealthy())) {
    cleanRelayData();
    relayProcess = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: relayRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    await waitForRelay();
  }

  try {
    const image = makeImage(IMAGE_BYTES);
    const imageHash = await sha256Base64UrlBytes(image);

    const alice = await LocalFirstClient.open({ name: "alice", relayUrl });
    const manifest = await alice.putBlob(image, "image/png");
    await alice.sync();

    console.log("Alice uploaded an image:");
    console.log(`  blobId:     ${manifest.blobId}`);
    console.log(`  mimeType:   ${manifest.mimeType}`);
    console.log(`  bytes:      ${manifest.byteSize}`);
    console.log(`  chunks:     ${manifest.chunks.length}`);
    console.log(`  manifest sync payload: ~${manifestSize(manifest)} bytes\n`);

    const bob = await LocalFirstClient.open({
      name: "bob",
      relayUrl,
      recoveryKey: alice.recoveryKey,
    });
    await bob.sync();

    const cachedBefore = countCachedChunks(bob);
    console.log("Bob synced (manifest only — no pixels yet):");
    console.log(`  knows about blob: ${bob.getBlobManifest(manifest.blobId) !== null}`);
    console.log(`  chunk bytes cached locally: ${cachedBefore}\n`);

    const { data, mimeType } = await bob.getBlob(manifest.blobId);
    const restoredHash = await sha256Base64UrlBytes(data);

    console.log("Bob read the image (lazily downloaded + decrypted):");
    console.log(`  mimeType:   ${mimeType}`);
    console.log(`  bytes:      ${data.length}`);
    console.log(`  chunk bytes cached after read: ${countCachedChunks(bob)}`);
    console.log(`  matches original: ${restoredHash === imageHash}\n`);

    if (restoredHash !== imageHash || data.length !== image.length) {
      throw new Error("Round-trip mismatch: decrypted image differs from original.");
    }

    const usage = await fetchUsage(alice);
    console.log(
      `Relay stored ${usage} encrypted bytes for this owner (binary BLOBs + manifest event).`,
    );
    console.log("\nBlob demo OK ✅");
  } finally {
    if (relayProcess) {
      relayProcess.kill();
      await relayProcess.exited.catch(() => undefined);
    }
  }
}

function makeImage(size: number): Uint8Array {
  // Deterministic pseudo-random bytes with a PNG magic header, so it looks like
  // a real file and compresses poorly (representative of an actual image).
  const bytes = new Uint8Array(size);
  let state = 0x12345678;
  for (let i = 0; i < size; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

function manifestSize(manifest: unknown): number {
  return new TextEncoder().encode(JSON.stringify(manifest)).length;
}

function countCachedChunks(client: LocalFirstClient): number {
  return (
    client.db
      .query<{ n: number }, []>(`select count(*) as n from blob_chunk`)
      .get()?.n ?? 0
  );
}

async function fetchUsage(client: LocalFirstClient): Promise<number> {
  const url = new URL(`${relayUrl}/v1/usage`);
  url.searchParams.set("ownerId", client.ownerId);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${client.relayAuth}` },
  });
  const body = (await response.json()) as { storedBytes: number };
  return body.storedBytes;
}

async function waitForRelay(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isRelayHealthy()) return;
    await sleep(100);
  }
  throw new Error(`Relay did not become healthy at ${relayUrl}.`);
}

async function isRelayHealthy(): Promise<boolean> {
  try {
    return (await fetch(`${relayUrl}/health`)).ok;
  } catch {
    return false;
  }
}

function cleanData(): void {
  for (const client of ["alice", "bob"]) {
    removeSqliteFiles(resolve(exampleRoot, "data", client));
  }
}

function cleanRelayData(): void {
  removeSqliteFiles(resolve(relayRoot, "data", "relay"));
}

function removeSqliteFiles(basePath: string): void {
  for (const suffix of [".db", ".db-shm", ".db-wal"]) {
    try {
      unlinkSync(`${basePath}${suffix}`);
    } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
