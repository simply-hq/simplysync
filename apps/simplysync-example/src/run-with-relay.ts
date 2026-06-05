import { unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(exampleRoot, "../..");
const relayRoot = resolve(repoRoot, "apps/simplysync-relay");
const relayUrl = process.env.RELAY_URL ?? "http://localhost:4100";
const keepOpen = Bun.argv.includes("--keep-open");

async function main(): Promise<void> {
  cleanExampleData();

  let relayProcess: Bun.Subprocess | null = null;
  const relayWasAlreadyRunning = await isRelayHealthy();

  if (relayWasAlreadyRunning) {
    console.log(`Using existing relay at ${relayUrl}`);
  } else {
    cleanRelayData();
    relayProcess = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: relayRoot,
      stdout: "inherit",
      stderr: "inherit",
    });
    await waitForRelay();
  }

  try {
    const demoProcess = Bun.spawn(["bun", "run", "src/index.ts", "demo"], {
      cwd: exampleRoot,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        RELAY_URL: relayUrl,
      },
    });
    const code = await demoProcess.exited;
    if (code !== 0) {
      throw new Error(`Demo exited with code ${code}.`);
    }

    if (keepOpen) {
      console.log(`\nDemo finished. Relay is still running at ${relayUrl}.`);
      console.log("Press Ctrl-C to stop it.");
      await waitForShutdown();
    }
  } finally {
    if (relayProcess && !relayWasAlreadyRunning) {
      relayProcess.kill();
      await relayProcess.exited.catch(() => undefined);
    }
  }
}

async function waitForRelay(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await isRelayHealthy()) {
      return;
    }
    await sleep(100);
  }

  throw new Error(`Relay did not become healthy at ${relayUrl}.`);
}

async function isRelayHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${relayUrl}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function cleanExampleData(): void {
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

function waitForShutdown(): Promise<void> {
  return new Promise((resolveShutdown) => {
    process.once("SIGINT", resolveShutdown);
    process.once("SIGTERM", resolveShutdown);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
