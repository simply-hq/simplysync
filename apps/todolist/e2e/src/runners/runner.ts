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
