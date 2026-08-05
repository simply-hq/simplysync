import { openSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Mailbox } from "../mailbox.ts";
import type { Runner } from "./runner.ts";

/** Drives the TodoList browser schema through the production TypeScript engine. */
export class WebRunner implements Runner {
  readonly mailbox: Mailbox;
  private proc: Subprocess | null = null;

  constructor(mailboxDir: string, private logPath: string) {
    this.mailbox = new Mailbox(mailboxDir);
  }

  async start(): Promise<void> {
    const fd = openSync(this.logPath, "w");
    this.proc = Bun.spawn(["bun", "run", join(import.meta.dir, "web-host.ts")], {
      cwd: join(import.meta.dir, "../.."),
      env: { ...process.env, SIMPLYSYNC_TODO_E2E_MAILBOX: this.mailbox.dir },
      stdout: fd,
      stderr: fd,
    });
    const ready = this.mailbox.request({
      cmd: "ping",
      device: "__runner_ready__",
    }, 30_000);
    const exited = this.proc.exited.then((code) => {
      throw new Error(`web e2e runner exited before becoming ready (exit ${code})`);
    });
    await Promise.race([ready, exited]);
  }

  async stop(): Promise<void> {
    if (!this.proc) return;
    try {
      await this.mailbox.request({ cmd: "shutdown", device: "_" }, 10_000);
    } catch {
      // fall through to hard kill
    }
    await Promise.race([this.proc.exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    this.proc.kill();
    this.proc = null;
  }
}
