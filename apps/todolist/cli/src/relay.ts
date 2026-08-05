// Start the Go relay for a local run, reusing one that's already up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  isRelayHealthy,
  relayRoot,
  relayUrl,
  waitForRelay,
} from "./support";

export interface StartedRelay {
  readonly url: string;
  /** No-op when we attached to a relay someone else started. */
  stop(): Promise<void>;
}

export async function startRelay(): Promise<StartedRelay> {
  if (await isRelayHealthy()) {
    console.log(`Using the relay already running at ${relayUrl}`);
    return { url: relayUrl, stop: async () => {} };
  }

  const relayDirectory = mkdtempSync(
    resolve(tmpdir(), "simplysync-cli-relay-"),
  );
  const relayBinary = resolve(relayDirectory, "simplysync-relay");
  const build = Bun.spawn(["go", "build", "-o", relayBinary, "."], {
    cwd: relayRoot,
    stdout: "ignore",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) {
    rmSync(relayDirectory, { recursive: true, force: true });
    throw new Error("Could not build the Go relay. Is Go on your PATH?");
  }

  const child = Bun.spawn([relayBinary], {
    cwd: relayRoot,
    env: {
      ...process.env,
      RELAY_DATA_DIR: resolve(relayDirectory, "data"),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    await waitForRelay();
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    rmSync(relayDirectory, { recursive: true, force: true });
    throw new Error(
      `Could not start the relay. Is Go on your PATH? (${
        error instanceof Error ? error.message : error
      })`,
    );
  }
  console.log(`Relay listening on ${relayUrl}`);
  return {
    url: relayUrl,
    async stop() {
      child.kill();
      await child.exited.catch(() => undefined);
      rmSync(relayDirectory, { recursive: true, force: true });
    },
  };
}
