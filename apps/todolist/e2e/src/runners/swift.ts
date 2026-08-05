import { openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { Mailbox } from "../mailbox.ts";
import { swiftRoot } from "../roots.ts";
import type { Runner } from "./runner.ts";

/** Compiles and drives the repository's TodoList Swift engine. */
export class SwiftRunner implements Runner {
  readonly mailbox: Mailbox;
  private proc: Subprocess | null = null;
  private readonly root: string;
  private readonly binary: string;

  constructor(mailboxDir: string, private logPath: string) {
    this.mailbox = new Mailbox(mailboxDir);
    this.root = swiftRoot();
    this.binary = join(dirname(mailboxDir), "todolist-swift-runner");
  }

  async start(): Promise<void> {
    const sources = [
      ...new Bun.Glob("../../../Sources/SimplySync/Kit/*.swift").scanSync(this.root),
      ...new Bun.Glob("../../../Sources/SimplySync/Engine/*.swift").scanSync(this.root),
      "SimplySyncDemo/AppSchema.swift",
      resolve(import.meta.dir, "../../native/swift/main.swift"),
    ];
    await this.run(["swiftc", ...sources, "-O", "-o", this.binary], "build");
    const fd = openSync(this.logPath, "w");
    this.proc = Bun.spawn([this.binary], {
      cwd: this.root,
      env: {
        ...process.env,
        SIMPLYSYNC_TODO_E2E_MAILBOX: this.mailbox.dir,
        SIMPLYSYNC_TODO_E2E_IDLE_TIMEOUT_MS: "600000",
      },
      stdout: fd,
      stderr: fd,
    });
    await this.waitUntilReady();
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.mailbox.request({ cmd: "shutdown", device: "_" }, 10_000);
    } catch {
      // fall through to hard kill
    }
    await Promise.race([this.proc.exited, timeout(5_000)]);
    this.proc.kill();
    this.proc = null;
  }

  private async run(cmd: string[], label: string): Promise<void> {
    const proc = Bun.spawn(cmd, { cwd: this.root, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`swift ${label} failed (exit ${code}):\n${stderr}`);
  }

  private async waitUntilReady(): Promise<void> {
    if (!this.proc) throw new Error("Swift TodoList runner was not started");
    const ready = this.mailbox.request({ cmd: "ping", device: "__runner_ready__" }, 120_000);
    const exited = this.proc.exited.then((code) => {
      throw new Error(`Swift TodoList runner exited before becoming ready (exit ${code})`);
    });
    await Promise.race([ready, exited]);
  }
}

const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));
