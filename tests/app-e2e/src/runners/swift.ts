import { openSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { Mailbox } from "../mailbox.ts";
import { iosRoot } from "../roots.ts";
import type { Runner } from "./runner.ts";

const PACKAGE = "Packages/SimplyFinanceCore";

/** Drives the real iOS `SyncEngine` via the `sf-e2e-runner` executable. */
export class SwiftRunner implements Runner {
  readonly platform = "ios" as const;
  readonly mailbox: Mailbox;
  private proc: Subprocess | null = null;
  private packageDir: string;

  constructor(mailboxDir: string, private logPath: string) {
    this.mailbox = new Mailbox(mailboxDir);
    this.packageDir = join(iosRoot(), PACKAGE);
  }

  async start(): Promise<void> {
    await this.run(["swift", "build", "-c", "release", "--product", "sf-e2e-runner"], "build");
    const binDir = (
      await this.capture(["swift", "build", "-c", "release", "--show-bin-path"])
    ).trim();
    const bin = join(binDir, "sf-e2e-runner");
    const fd = openSync(this.logPath, "w");
    this.proc = Bun.spawn([bin], {
      cwd: this.packageDir,
      env: { ...process.env, SF_E2E_MAILBOX: this.mailbox.dir, SF_E2E_IDLE_TIMEOUT_MS: "600000" },
      stdout: fd,
      stderr: fd,
    });
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
    const proc = Bun.spawn(cmd, { cwd: this.packageDir, stdout: "pipe", stderr: "pipe" });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`swift ${label} failed (exit ${code}):\n${stderr}`);
  }

  private async capture(cmd: string[]): Promise<string> {
    const proc = Bun.spawn(cmd, { cwd: this.packageDir, stdout: "pipe", stderr: "pipe" });
    const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return out;
  }
}

const timeout = (ms: number) => new Promise((r) => setTimeout(r, ms));
