import { openSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Mailbox } from "../mailbox.ts";
import { kotlinRoot } from "../roots.ts";
import type { Runner } from "./runner.ts";

/**
 * Drives the TodoList Kotlin engine through a long-lived JUnit host. Gradle
 * compiles the local port and the E2E-owned host source in one test task.
 */
export class KotlinRunner implements Runner {
  readonly mailbox: Mailbox;
  private proc: Subprocess | null = null;
  private root: string;

  constructor(mailboxDir: string, private logPath: string) {
    this.mailbox = new Mailbox(mailboxDir);
    this.root = kotlinRoot();
  }

  async start(): Promise<void> {
    const fd = openSync(this.logPath, "w");
    // --rerun-tasks: the mailbox path is a tracked system-property input, but
    // force the test task to run so a cached UP-TO-DATE never leaves the host
    // unstarted (which would hang the first request).
    this.proc = Bun.spawn(
      [
        join(this.root, "gradlew"),
        "test",
        "--tests",
        "com.simplysync.kotlin.e2e.TodoE2eRunnerHost",
        `-PtodoE2eMailbox=${this.mailbox.dir}`,
        "-PtodoE2eIdleTimeoutMs=600000",
        "--rerun-tasks",
        "--console=plain",
      ],
      { cwd: this.root, env: { ...process.env }, stdout: fd, stderr: fd },
    );

    // Gradle compiles and launches the mailbox host in this one long-lived
    // command, so wait for a ping before returning.
    const ready = this.mailbox.request(
      { cmd: "ping", device: "__runner_ready__" },
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
        throw new Error(`Kotlin TodoList runner exited before becoming ready (exit ${outcome.code})`);
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
