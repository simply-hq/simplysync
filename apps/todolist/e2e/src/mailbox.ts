import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pad = (n: number) => String(n).padStart(6, "0");

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

/**
 * File-mailbox client to one runner host. Writes `cmd-NNN.json` atomically and
 * polls for the matching `res-NNN.json`. Requests are issued one at a time per
 * mailbox (the scenario awaits each), which also fixes HLC ordering: a mutate
 * sent after another gets a later wall-clock HLC, so "later write wins" is
 * simply "later step wins".
 */
export class Mailbox {
  private seq = 0;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async request(payload: Record<string, unknown>, timeoutMs = 120_000): Promise<any> {
    const seq = ++this.seq;
    const cmdPath = join(this.dir, `cmd-${pad(seq)}.json`);
    const resPath = join(this.dir, `res-${pad(seq)}.json`);
    writeAtomic(cmdPath, JSON.stringify({ seq, ...payload }));

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (existsSync(resPath)) {
        const res = JSON.parse(readFileSync(resPath, "utf8"));
        if (res.ok === false) {
          throw new RunnerError(
            `runner rejected '${payload.cmd}': ${res.error ?? "unknown error"}`,
          );
        }
        return res.result;
      }
      await sleep(20);
    }
    throw new RunnerError(`timeout after ${timeoutMs}ms waiting for '${payload.cmd}' (seq ${seq})`);
  }
}

export function writeAtomic(dest: string, text: string): void {
  const tmp = dest + ".tmp";
  writeFileSync(tmp, text);
  renameSync(tmp, dest);
}
