// Boots the real Go relay as a subprocess on a free port with a
// throwaway data dir, and hands back { baseUrl, kill() } so black-box HTTP
// tests can drive it exactly like a client would. No relay internals are
// imported — this only ever talks to the process over HTTP.

import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RelayKind = "go";

export interface LaunchedRelay {
  readonly kind: RelayKind;
  readonly baseUrl: string;
  readonly dataDir: string;
  /** Terminates the subprocess and removes its temp data dir. Idempotent. */
  kill(): Promise<void>;
}

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../../../..");
const goRelayRoot = resolve(repoRoot, "relays/go");

/** Whether `go` is on PATH. Cached — checked once per test run. */
let goAvailableCache: boolean | null = null;
export function isGoAvailable(): boolean {
  goAvailableCache ??= Bun.which("go") !== null;
  return goAvailableCache;
}

// Building the Go relay once into a real binary (instead of spawning
// `go run .` per instance) means kill() targets the actual listening process
// directly — `go run` execs a child under a wrapper, and killing the wrapper
// doesn't reliably kill the child on every platform, which would leak a
// process bound to the port. Shared across every Go relay instance in the
// suite; cleaned up by cleanupGoBinary() in a top-level afterAll.
let goBinaryPromise: Promise<string> | null = null;
let goBinaryDir: string | null = null;

async function goBinary(): Promise<string> {
  goBinaryPromise ??= buildGoBinary();
  return goBinaryPromise;
}

async function buildGoBinary(): Promise<string> {
  goBinaryDir = mkdtempSync(join(tmpdir(), "simplysync-relay-go-bin-"));
  const outPath = join(goBinaryDir, "relay-go");
  const proc = Bun.spawn(["go", "build", "-o", outPath, "."], {
    cwd: goRelayRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`go build failed (exit ${code}):\n${stderr}`);
  }
  return outPath;
}

/** Removes the compiled Go binary's temp dir. Call once after all tests. */
export function cleanupGoBinary(): void {
  if (goBinaryDir) {
    rmSync(goBinaryDir, { recursive: true, force: true });
    goBinaryDir = null;
    goBinaryPromise = null;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const port = address.port;
        srv.close(() => resolvePort(port));
      } else {
        srv.close();
        reject(new Error("Could not determine a free port"));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Keeps only the tail of a stream so a hung boot's error message is useful
// without buffering unbounded output.
function tailCollector(stream: ReadableStream<Uint8Array> | null): {
  tail(): string;
} {
  const lines: string[] = [];
  const maxLines = 200;
  if (stream) {
    void (async () => {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          // eslint-disable-next-line no-cond-assign
          while ((idx = buffer.indexOf("\n")) >= 0) {
            lines.push(buffer.slice(0, idx));
            if (lines.length > maxLines) lines.shift();
            buffer = buffer.slice(idx + 1);
          }
        }
      } catch {
        // stream closed/killed — nothing more to collect
      }
    })();
  }
  return { tail: () => lines.join("\n") };
}

async function waitForHealth(
  baseUrl: string,
  describeProcess: () => string,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `Relay at ${baseUrl} did not become healthy within ${timeoutMs}ms.\n` +
      `Last error: ${String(lastError)}\nProcess output tail:\n${describeProcess()}`,
  );
}

/**
 * Boots one Go relay instance as a subprocess: a free port, a fresh
 * temp RELAY_DATA_DIR, optional extra env (e.g. ADMIN_TOKEN, MAX_OWNER_BYTES),
 * and waits for GET /health to return 200 before resolving.
 */
export async function launchRelay(
  kind: RelayKind,
  envOverrides: Record<string, string> = {},
): Promise<LaunchedRelay> {
  const port = await getFreePort();
  const dataDir = mkdtempSync(join(tmpdir(), `simplysync-relay-${kind}-`));
  const baseUrl = `http://localhost:${port}`;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    RELAY_DATA_DIR: dataDir,
    ...envOverrides,
  };

  let proc: import("bun").Subprocess;
  // Go's first build can take a little while; the boot poll timeout accounts
  // for that even though we pre-build the binary before spawning it.
  const bootTimeoutMs = 30_000;

  if (!isGoAvailable()) {
    throw new Error("go is not on PATH — cannot launch the Go relay");
  }
  const bin = await goBinary();
  proc = Bun.spawn([bin], {
    cwd: goRelayRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutTail = tailCollector(proc.stdout as ReadableStream<Uint8Array>);
  const stderrTail = tailCollector(proc.stderr as ReadableStream<Uint8Array>);
  const describeProcess = () =>
    `--- stdout ---\n${stdoutTail.tail()}\n--- stderr ---\n${stderrTail.tail()}`;

  try {
    await waitForHealth(baseUrl, describeProcess, bootTimeoutMs);
  } catch (error) {
    proc.kill();
    await proc.exited.catch(() => undefined);
    rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }

  let killed = false;
  return {
    kind,
    baseUrl,
    dataDir,
    async kill(): Promise<void> {
      if (killed) return;
      killed = true;
      proc.kill();
      await proc.exited.catch(() => undefined);
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
