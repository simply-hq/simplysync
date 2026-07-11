import { openSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Mailbox } from "../mailbox.ts";
import { androidRoot } from "../roots.ts";
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
