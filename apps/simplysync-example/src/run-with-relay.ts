import {
  cleanExampleData,
  cleanRelayData,
  exampleRoot,
  isRelayHealthy,
  relayRoot,
  relayUrl,
  waitForRelay,
} from "./demo-support";

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
