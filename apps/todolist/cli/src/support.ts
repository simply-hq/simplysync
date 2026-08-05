import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(cliRoot, "../../..");
export const relayRoot = resolve(repoRoot, "apps/relay-go");
export const relayUrl = process.env.RELAY_URL ?? "http://localhost:4100";

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export async function isRelayHealthy(): Promise<boolean> {
  try {
    return (await fetch(`${relayUrl}/health`)).ok;
  } catch {
    return false;
  }
}

export async function waitForRelay(): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (await isRelayHealthy()) return;
    await sleep(100);
  }
  throw new Error(`Relay did not become healthy at ${relayUrl}.`);
}
