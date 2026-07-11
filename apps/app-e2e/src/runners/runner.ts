import type { Mailbox } from "../mailbox.ts";
import type { Platform } from "../roots.ts";

/**
 * A long-lived host process for one platform, serving many devices over its
 * mailbox. Started lazily and reused across every scenario in a run.
 */
export interface Runner {
  readonly platform: Platform;
  readonly mailbox: Mailbox;
  /** Build (if needed) and spawn the host; resolves once it's spawned. */
  start(): Promise<void>;
  /** Send `shutdown` and wait for the process to exit. Idempotent. */
  stop(): Promise<void>;
}
