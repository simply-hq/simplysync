// `bun run todo:interop` — the same todo app on every platform, one account,
// one relay, and a check that they all agree.
//
// This is the claim SimplySync rests on ("four implementations, all
// wire-compatible") turned into something you can run from a fresh clone. The
// The full TodoList e2e harness proves more scenarios across long-lived
// platform runners; this one-shot check stays useful as a quick local smoke
// test and skips loudly when a toolchain is missing rather than quietly passing.
//
//   TypeScript  @simplysync/engine            (always runs)
//   Kotlin      apps/todolist/kotlin     (needs a JDK)
//   Swift       apps/todolist/swift      (needs swiftc / macOS)

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "./support";
import {
  closeDevice,
  listTodos,
  openDevice,
  syncUntil,
  type TodoEngine,
} from "./device";
import { startRelay, type StartedRelay } from "./relay";

const kotlinRoot = resolve(repoRoot, "apps/todolist/kotlin");
const swiftRoot = resolve(repoRoot, "apps/todolist/swift");

type PlatformStatus = "passed" | "skipped" | "failed";

interface PlatformResult {
  readonly platform: string;
  readonly status: PlatformStatus;
  readonly detail: string;
}

async function canRun(cmd: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

async function run(
  cmd: string[],
  cwd: string,
  label: string,
  env: Record<string, string> = {},
): Promise<{ ok: boolean; output: string }> {
  console.log(`  $ ${cmd.join(" ")}`);
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const output = `${stdout}\n${stderr}`;
  if (code !== 0) {
    console.log(`  ${label} exited ${code}`);
    const diagnostic = output.trim();
    if (diagnostic) console.log(diagnostic);
  }
  return { ok: code === 0, output };
}

/** Kotlin's live test joins our owner and does its own A/B round-trip on it. */
async function runKotlin(
  relayUrl: string,
  recoveryKey: string,
): Promise<PlatformResult> {
  if (!existsSync(resolve(kotlinRoot, "gradlew"))) {
    return {
      platform: "Kotlin",
      status: "failed",
      detail: "gradlew not found",
    };
  }
  if (!(await canRun(["java", "-version"]))) {
    return {
      platform: "Kotlin",
      status: "skipped",
      detail: "no JDK on PATH",
    };
  }
  const result = await run(
    [
      "./gradlew",
      "--quiet",
      "--rerun-tasks",
      "test",
      "--tests",
      "com.simplysync.kotlin.EngineTest.liveTwoDeviceRoundTrip",
      `-PrelayUrl=${relayUrl}`,
    ],
    kotlinRoot,
    "Kotlin",
    { SIMPLYSYNC_RECOVERY_KEY: recoveryKey },
  );
  return {
    platform: "Kotlin",
    status: result.ok ? "passed" : "failed",
    detail: result.ok ? "live round-trip passed" : "gradle test failed",
  };
}

/**
 * Swift's full engine verifier joins the shared owner, then writes, pulls,
 * applies, edits, and converges one canonical todo through two Swift engines.
 */
async function runSwift(
  workDir: string,
  relayUrl: string,
  recoveryKey: string,
  title: string,
): Promise<PlatformResult> {
  if (!(await canRun(["swiftc", "--version"]))) {
    return {
      platform: "Swift",
      status: "skipped",
      detail: "no swiftc (needs macOS)",
    };
  }
  // Same command the Swift README documents, with the glob expanded here since
  // there's no shell to do it.
  const binary = resolve(workDir, "ssengine");
  const sources = [
    ...new Bun.Glob("../../../Sources/SimplySync/Kit/*.swift").scanSync(swiftRoot),
    ...new Bun.Glob("../../../Sources/SimplySync/Engine/*.swift").scanSync(swiftRoot),
    "SimplySyncDemo/AppSchema.swift",
    "verify/engine/main.swift",
  ];
  const compile = await run(
    ["swiftc", ...sources, "-o", binary],
    swiftRoot,
    "swiftc",
  );
  if (!compile.ok) {
    return {
      platform: "Swift",
      status: "failed",
      detail: "swiftc build failed",
    };
  }
  const result = await run(
    [binary, relayUrl],
    swiftRoot,
    "Swift",
    {
      SIMPLYSYNC_RECOVERY_KEY: recoveryKey,
      SIMPLYSYNC_TODO_TITLE: title,
    },
  );
  return {
    platform: "Swift",
    status: result.ok ? "passed" : "failed",
    detail: result.ok ? "engine round-trip passed" : "engine test failed",
  };
}

async function main(): Promise<void> {
  const workDir = mkdtempSync(join(tmpdir(), "simplysync-interop-"));
  let relay: StartedRelay | undefined;
  let ts: TodoEngine | undefined;
  const swiftTitle = "from-swift";

  try {
    relay = await startRelay();

    // TypeScript mints the owner every other platform will join.
    ts = await openDevice({
      name: "interop-ts",
      dataDir: workDir,
      relayUrl: relay.url,
    });
    const owner = await ts.appOwner;
    if (!owner) throw new Error("no owner");
    console.log(`\nOwner ${owner.id} — every platform below joins this account.`);

    console.log("\n[Swift]");
    const swift = await runSwift(
      workDir,
      relay.url,
      owner.recoveryKey,
      swiftTitle,
    );
    console.log(`  ${swift.status} — ${swift.detail}`);

    console.log("\n[TypeScript] insert + push");
    const inserted = ts.insert("todo", {
      title: "from-typescript",
      done: 0,
    });
    if (!inserted.ok) throw new Error(inserted.error.message);
    await ts.sync();
    console.log(`  pushed (outbox ${ts.getPendingOutboxCount()})`);

    console.log("\n[Kotlin]");
    const kotlin = await runKotlin(relay.url, owner.recoveryKey);
    console.log(`  ${kotlin.status} — ${kotlin.detail}`);

    // Everything the other platforms wrote must now decrypt and apply here.
    console.log("\n[TypeScript] pull everything back");
    const expectTitles = ["from-typescript"];
    if (kotlin.status === "passed") expectTitles.push("Edited by B");
    if (swift.status === "passed") expectTitles.push(swiftTitle);
    const rows = await syncUntil(ts, (current) =>
      expectTitles.every((title) => current.some((row) => row.title === title)),
    );
    for (const row of rows) console.log(`  [${row.done ? "x" : " "}] ${row.title}`);

    const missing = expectTitles.filter(
      (title) => !rows.some((row) => row.title === title),
    );

    console.log("\n──── interop summary ────");
    console.log(`  TypeScript  ran      (wrote "from-typescript")`);
    for (const platform of [kotlin, swift]) {
      const statusLabel = {
        passed: "ran     ",
        skipped: "SKIPPED ",
        failed: "FAILED  ",
      }[platform.status];
      console.log(
        `  ${platform.platform.padEnd(11)} ${statusLabel} ${platform.detail}`,
      );
    }
    const nativeResults = [kotlin, swift];
    if (nativeResults.some((result) => result.status === "skipped")) {
      console.log(
        "\n  A skipped platform is NOT a pass — install the toolchain to check it.",
      );
    }
    const failures = nativeResults.filter(
      (result) => result.status === "failed",
    );
    if (failures.length > 0) {
      throw new Error(
        `native interop failed: ${failures.map((result) => result.platform).join(", ")}`,
      );
    }
    if (missing.length > 0) {
      throw new Error(`rows never converged: ${missing.join(", ")}`);
    }
    console.log(
      `\n  ${expectTitles.length} row(s) written on ${
        1 +
        nativeResults.filter((result) => result.status === "passed").length
      } platform(s) all converged in the TypeScript engine.`,
    );
  } finally {
    if (ts) closeDevice(ts);
    await relay?.stop();
    rmSync(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
