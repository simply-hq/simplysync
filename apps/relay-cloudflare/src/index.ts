/**
 * Cloudflare Workers relay for the local-first sync protocol.
 *
 * Wire-compatible with `apps/relay-go` (the canonical self-hosted relay):
 * same endpoints, same request/response shapes, same end-to-end-encrypted
 * threat model (the relay only ever sees ciphertext + an owner id + an auth
 * hash). The difference is the substrate and the cost model:
 *
 *   - Events + owner metadata  -> D1   (small rows, keyset-paginated)
 *   - Encrypted blob chunks    -> R2   (cheap storage, *free* egress, cached)
 *
 * Because Workers / D1 / R2 can be billed per use, this relay bounds public
 * URL abuse with early rejection, rate limits, and storage caps. See the
 * defense ordering in `src/handlers.ts` and the layered design in README.md.
 *
 * The same division as the Go relay, two files instead of two packages:
 *
 *   - `src/handlers.ts` — routing, validation, status codes, headers, CORS.
 *   - `src/store.ts`    — every D1 and R2 decision: quota accounting, sequence
 *                         reservation, Compaction, trust-on-first-use auth.
 *
 * This file is only the Worker's entry points.
 */

import { handleRequest } from "./handlers";
import { compactLog, type Env } from "./store";

export default {
  fetch: handleRequest,

  // Cron Trigger (see wrangler.toml [triggers]): compact the append-only event
  // log. Running it from the Cron-triggered Worker (next to D1 via its binding)
  // is the correct way to maintain D1 — a low-latency, in-network job, not an
  // external box reaching in over the HTTP API.
  async scheduled(_event, env: Env, ctx): Promise<void> {
    ctx.waitUntil(compactLog(env));
  },
} satisfies ExportedHandler<Env>;
