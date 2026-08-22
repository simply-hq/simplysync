// Boots the Cloudflare relay under `wrangler dev --local` (miniflare: local D1
// + R2 + rate-limit bindings, no network, no account) on a free port with a
// throwaway persist dir, and hands back the same { baseUrl, kill() } shape as
// the Go launcher.
//
// Two adapters at one seam make it a real seam: the relay HTTP contract can
// now be asserted against both implementations instead of being asserted
// against Go and merely claimed of Cloudflare.
//
// Like the Go launcher, this imports no relay internals — everything goes over
// HTTP exactly as a client would send it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getFreePort,
  tailCollector,
  waitForHealth,
  type LaunchedRelay,
} from "./launch-relay";

const testDir = dirname(fileURLToPath(import.meta.url));
const cloudflareRoot = resolve(testDir, "../../../relay-cloudflare");

/** Whether the Cloudflare relay's wrangler binary is installed. Cached. */
let wranglerCache: string | null | undefined;
export function wranglerBin(): string | null {
  if (wranglerCache === undefined) {
    const local = join(cloudflareRoot, "node_modules/.bin/wrangler");
    wranglerCache = Bun.file(local).size > 0 ? local : Bun.which("wrangler");
  }
  return wranglerCache;
}

export function isWranglerAvailable(): boolean {
  return wranglerBin() !== null;
}

// wrangler phones home for metrics and update checks by default; a hermetic
// test run must neither block on nor report to the network.
const HERMETIC_ENV = {
  WRANGLER_SEND_METRICS: "false",
  CLOUDFLARE_API_TOKEN: "",
  NO_UPDATE_NOTIFIER: "1",
} as const;

/**
 * D1 starts empty in a fresh persist dir, so the migrations in
 * `apps/relay-cloudflare/migrations` have to be applied before the Worker can
 * serve anything. Runs to completion before the dev server is spawned.
 */
async function applyMigrations(persistDir: string): Promise<void> {
  const bin = wranglerBin();
  if (!bin) throw new Error("wrangler is not installed");
  const proc = Bun.spawn(
    [
      bin,
      "d1",
      "migrations",
      "apply",
      "sbt-relay",
      "--local",
      "--persist-to",
      persistDir,
    ],
    {
      cwd: cloudflareRoot,
      env: { ...(process.env as Record<string, string>), ...HERMETIC_ENV },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`d1 migrations apply failed (exit ${code}):\n${stderr}`);
  }
}

/**
 * One Cloudflare relay instance. `varOverrides` sets the same `[vars]` tunables
 * the Go launcher takes as env (MAX_OWNER_BYTES, RELAY_DISABLED, …), so a test
 * can configure either implementation the same way.
 */
export async function launchCloudflareRelay(
  varOverrides: Record<string, string> = {},
): Promise<LaunchedRelay> {
  const bin = wranglerBin();
  if (!bin) throw new Error("wrangler is not installed");

  const port = await getFreePort();
  const persistDir = mkdtempSync(join(tmpdir(), "simplysync-relay-cf-"));
  const baseUrl = `http://localhost:${port}`;

  await applyMigrations(persistDir);

  const args = [
    bin,
    "dev",
    "--local",
    "--port",
    String(port),
    // 0 = pick a free one; several instances must not fight over 9229.
    "--inspector-port",
    "0",
    "--persist-to",
    persistDir,
    // Exposes /__scheduled so a test can run the 6-hourly compaction cron on
    // demand. Without it, the only server-side decision that DELETES an
    // owner's events is unreachable from a test.
    "--test-scheduled",
  ];
  for (const [name, value] of Object.entries(varOverrides)) {
    args.push("--var", `${name}:${value}`);
  }

  const proc = Bun.spawn(args, {
    cwd: cloudflareRoot,
    env: { ...(process.env as Record<string, string>), ...HERMETIC_ENV },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const stdoutTail = tailCollector(proc.stdout as ReadableStream<Uint8Array>);
  const stderrTail = tailCollector(proc.stderr as ReadableStream<Uint8Array>);
  const describeProcess = () =>
    `--- stdout ---\n${stdoutTail.tail()}\n--- stderr ---\n${stderrTail.tail()}`;

  try {
    // Warm, this boots in ~2s. The first run on a machine also has to fetch
    // and unpack workerd, which is far slower — hence the generous ceiling.
    await waitForHealth(baseUrl, describeProcess, 180_000);
  } catch (error) {
    proc.kill();
    await proc.exited.catch(() => undefined);
    rmSync(persistDir, { recursive: true, force: true });
    throw error;
  }

  let killed = false;
  return {
    baseUrl,
    async kill(): Promise<void> {
      if (killed) return;
      killed = true;
      proc.kill();
      await proc.exited.catch(() => undefined);
      rmSync(persistDir, { recursive: true, force: true });
    },
  };
}
