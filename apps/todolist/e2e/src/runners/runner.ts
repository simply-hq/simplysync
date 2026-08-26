import type { Subprocess } from "bun";
import type { Mailbox } from "../mailbox.ts";

/**
 * A long-lived TodoList host process for one implementation, serving many
 * devices over its mailbox. It is started once and reused across scenarios.
 */
export interface Runner {
  readonly mailbox: Mailbox;
  /** Build (if needed) and spawn the host; resolves once it can accept commands. */
  start(): Promise<void>;
  /** Send `shutdown` and wait for the process to exit. Idempotent. */
  stop(): Promise<void>;
}

/** Ask the host to shut down, then hard-kill after a grace period. */
export async function stopRunner(
  proc: Subprocess,
  mailbox: Mailbox,
  graceMs: number,
): Promise<void> {
  try {
    await mailbox.request({ cmd: "shutdown", device: "_" }, 10_000);
  } catch {
    // fall through to hard kill
  }
  await Promise.race([proc.exited, new Promise((r) => setTimeout(r, graceMs))]);
  proc.kill();
}
