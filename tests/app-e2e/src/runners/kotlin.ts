import { openSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Mailbox } from "../mailbox.ts";
import { androidRoot } from "../roots.ts";
import { TEST_MNEMONIC } from "../scenario.ts";
import type { Runner } from "./runner.ts";

/**
 * Drives the real Android `SyncEngine` via the `E2eRunnerHost` JUnit class. One
 * Gradle invocation runs the host for the whole session; the mailbox loop keeps
 * the test alive until `shutdown`, then the task completes and Gradle exits.
 */
export class KotlinRunner implements Runner {
  readonly platform = "android" as const;
  readonly mailbox: Mailbox;
  private proc: Subprocess | null = null;
  private root: string;

  constructor(mailboxDir: string, private logPath: string) {
    this.mailbox = new Mailbox(mailboxDir);
    this.root = androidRoot();
  }

  async start(): Promise<void> {
    const fd = openSync(this.logPath, "w");
    // --rerun-tasks: the mailbox path is a tracked system-property input, but
    // force the test task to run so a cached UP-TO-DATE never leaves the host
    // unstarted (which would hang the first request).
    this.proc = Bun.spawn(
      [
        join(this.root, "gradlew"),
        ":app:testDebugUnitTest",
        "--tests",
        "app.simplyfinance.e2e.E2eRunnerHost",
        `-DsfE2eMailbox=${this.mailbox.dir}`,
        "-DsfE2eIdleTimeoutMs=600000",
        "--rerun-tasks",
        "--console=plain",
      ],
      { cwd: this.root, env: { ...process.env }, stdout: fd, stderr: fd },
    );

    // Unlike SwiftRunner, Gradle compiles and launches the host in one long-
    // lived command. On a cold CI runner that build can exceed the normal
    // two-minute per-command timeout. Complete one harmless initialization
    // here so start() does not return until the mailbox host is actually ready.
    const ready = this.mailbox.request(
      {
        cmd: "init",
        device: "__runner_ready__",
        mnemonic: TEST_MNEMONIC,
        deviceId: "__runner_ready__",
        dbPath: join(this.mailbox.dir, "runner-ready.db"),
      },
      600_000,
    ).then(
      () => ({ kind: "ready" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    const exited = this.proc.exited.then((code) => ({ kind: "exit" as const, code }));
    try {
      const outcome = await Promise.race([ready, exited]);
      if (outcome.kind === "error") throw outcome.error;
      if (outcome.kind === "exit") {
        throw new Error(`Android e2e runner exited before becoming ready (exit ${outcome.code})`);
      }
    } catch (error) {
      this.proc.kill();
      this.proc = null;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.mailbox.request({ cmd: "shutdown", device: "_" }, 10_000);
    } catch {
      // fall through to hard kill
    }
    await Promise.race([this.proc.exited, timeout(15_000)]);
    this.proc.kill();
    this.proc = null;
  }
}

const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));
