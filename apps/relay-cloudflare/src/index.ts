/**
 * Cloudflare Workers relay for the local-first sync protocol.
 *
 * Wire-compatible with `apps/simplysync-relay` (the Bun reference relay):
 * same endpoints, same request/response shapes, same end-to-end-encrypted
 * threat model (the relay only ever sees ciphertext + an owner id + an auth
 * hash). The difference is the substrate and the cost model:
 *
 *   - Events + owner metadata  -> D1   (small rows, keyset-paginated)
 *   - Encrypted blob chunks    -> R2   (cheap storage, *free* egress, cached)
 *
 * Because Workers / D1 / R2 are billed per use, this relay is built so a
 * stranger who knows the URL cannot run up the bill ("wallet DDoS"). See the
 * defense ordering in `fetch()` and the layered design in README.md.
 */

import type { SyncEnvelope } from "@simplysync/protocol";

interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  API_LIMITER: RateLimiter;
  CREATE_LIMITER: RateLimiter;
  WRITE_LIMITER: RateLimiter;
  MAX_EVENT_BYTES: string;
  MAX_OWNER_BYTES: string;
  MAX_EVENTS_PER_PUSH: string;
  MAX_EVENTS_PER_PULL: string;
  DEFAULT_EVENTS_PER_PULL: string;
  MAX_BLOB_BYTES: string;
  MAX_OWNERS: string;
  RELAY_DISABLED: string;
}

const BLOB_PATH_PREFIX = "/v1/blobs/";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // --- Layer 1: cheapest possible rejections, before any binding I/O. ------
    // Every branch above the rate-limit check costs only Worker CPU, never a
    // D1 read or R2 op, so malformed/oversized junk is the cheapest to shed.

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      // Intentionally does NOT touch D1 — health checks must stay free so they
      // can't be turned into a metered-read amplifier.
      return json({ ok: true, service: "simplysync-relay" });
    }

    const cfg = readConfig(env);

    // --- Layer 2: per-IP edge-of-Worker rate limit (in-colo, ~free). ---------
    // The zone-level WAF rate-limit rule (README) sheds floods *before* the
    // Worker is billed at all; this is defense-in-depth for what slips past it.
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await env.API_LIMITER.limit({ key: ip })).success) {
      return json({ error: "Rate limited" }, 429);
    }

    try {
      if (request.method === "POST" && url.pathname === "/v1/events") {
        return await handlePush(request, env, cfg, ip);
      }
      if (request.method === "GET" && url.pathname === "/v1/events") {
        return await handlePull(request, env, cfg, url);
      }
      if (request.method === "GET" && url.pathname === "/v1/usage") {
        return await handleUsage(request, env, cfg, url);
      }
      if (url.pathname.startsWith(BLOB_PATH_PREFIX)) {
        const hash = decodeURIComponent(
          url.pathname.slice(BLOB_PATH_PREFIX.length),
        );
        if (!hash) return json({ error: "Missing blob hash" }, 400);
        if (request.method === "PUT")
          return await handleBlobPut(request, env, cfg, url, hash, ip);
        if (request.method === "GET")
          return await handleBlobGet(request, env, cfg, url, hash);
        if (request.method === "HEAD")
          return await handleBlobHead(request, env, cfg, url, hash);
        return json({ error: "Method not allowed" }, 405);
      }
    } catch (error) {
      console.error(error);
      return json({ error: "Internal error" }, 500);
    }

    return json({ error: "Not found" }, 404);
  },

  // Cron Trigger (see wrangler.toml [triggers]): compact the append-only event
  // log. Same invariant as the Bun relay — eventId === HLC, and event_id order
  // is the client's LWW order, so keeping the max event_id per (owner, streamId)
  // is exactly the last-writer value. A fresh device pulling only survivors
  // reconstructs identical state. Events without a streamId are never touched.
  //
  // Running this from the Cron-triggered Worker (next to D1 via its binding) is
  // the correct way to maintain D1 — a low-latency, in-network job, not an
  // external box reaching in over the HTTP API.
  async scheduled(_event, env: Env, ctx): Promise<void> {
    ctx.waitUntil(compactLog(env));
  },
} satisfies ExportedHandler<Env>;

async function compactLog(env: Env): Promise<void> {
  const winnerSubquery = `(select max(e2.event_id) from events e2
       where e2.owner_id = events.owner_id and e2.stream_id = events.stream_id)`;
  // Charge back reclaimed bytes per owner, then delete the superseded rows.
  // Ordered (reclaim reads the rows the delete removes) and atomic via batch().
  const reclaim = env.DB.prepare(
    `update owners set stored_bytes = max(0, stored_bytes - coalesce((
       select sum(e.stored_bytes) from events e
       where e.owner_id = owners.owner_id and e.stream_id is not null
         and e.event_id < (select max(e2.event_id) from events e2
                           where e2.owner_id = e.owner_id and e2.stream_id = e.stream_id)
     ), 0))`,
  );
  const del = env.DB.prepare(
    `delete from events where stream_id is not null
       and event_id < ${winnerSubquery}`,
  );
  const [, delResult] = await env.DB.batch([reclaim, del]);
  console.log(`compaction: removed ${delResult.meta?.changes ?? 0} events`);
}

// -----------------------------------------------------------------------------
// Push (write events)
// -----------------------------------------------------------------------------

async function handlePush(
  request: Request,
  env: Env,
  cfg: Config,
  ip: string,
): Promise<Response> {
  if (cfg.relayDisabled) return json({ error: "Relay is read-only" }, 503);

  const relayAuth = getBearerToken(request);
  if (!relayAuth) return json({ error: "Missing bearer token" }, 401);

  // Reject obviously-oversized payloads by Content-Length before reading the
  // body, so a giant POST never gets buffered into Worker memory.
  if (exceedsContentLength(request, cfg.maxEventBytes * cfg.maxEventsPerPush)) {
    return json({ error: "Payload too large" }, 413);
  }

  const body = (await request.json().catch(() => null)) as {
    ownerId?: unknown;
    events?: unknown;
  } | null;

  if (!body || typeof body.ownerId !== "string" || !Array.isArray(body.events)) {
    return json({ error: "Invalid push body" }, 400);
  }
  if (body.events.length > cfg.maxEventsPerPush) {
    return json({ error: "Too many events in one push" }, 413);
  }

  const ownerId = body.ownerId;
  const events = body.events as SyncEnvelope[];

  // Validate + size every event up front (pure CPU, no DB).
  let batchBytes = 0;
  const prepared: { event: SyncEnvelope; json: string; bytes: number }[] = [];
  for (const event of events) {
    const validationError = validateEnvelope(ownerId, event);
    if (validationError) return json({ error: validationError }, 400);
    const envelopeJson = JSON.stringify(event);
    const bytes = new TextEncoder().encode(envelopeJson).length;
    if (bytes > cfg.maxEventBytes) return json({ error: "Event is too large" }, 413);
    batchBytes += bytes;
    prepared.push({ event, json: envelopeJson, bytes });
  }

  // Auth + quota (this is where we first touch D1).
  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: true,
    ip,
  });
  if (!auth.ok) return auth.response;

  // Per-owner write rate limit (one key can't hammer writes).
  if (!(await env.WRITE_LIMITER.limit({ key: ownerId })).success) {
    return json({ error: "Rate limited" }, 429);
  }

  // Pre-check quota against current usage. Accepted bytes are charged exactly
  // after the insert (duplicates cost nothing); overshoot under concurrent
  // pushes is bounded by one batch.
  if (auth.storedBytes + batchBytes > cfg.maxOwnerBytes) {
    return json({ error: "Owner quota exceeded" }, 413);
  }

  // Atomically reserve a contiguous seq range for this batch (RETURNING gives
  // the new counter value, so concurrent pushes never collide). Assign by
  // position; duplicates just leave a harmless gap. The counter only increases.
  const seqRow = await env.DB.prepare(
    `update relay_meta set value = value + ? where key = 'event_seq' returning value`,
  )
    .bind(prepared.length)
    .first<{ value: number }>();
  const seqBase = (seqRow?.value ?? prepared.length) - prepared.length;

  // Atomic batch insert-or-ignore; per-statement `changes` tells us which were
  // genuinely new so we charge usage precisely.
  const stmt = env.DB.prepare(
    `insert or ignore into events
       (owner_id, event_id, device_id, envelope_json, stored_bytes, created_at, stream_id, seq)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const results = await env.DB.batch(
    prepared.map((p, i) =>
      stmt.bind(
        p.event.ownerId,
        p.event.eventId,
        p.event.deviceId,
        p.json,
        p.bytes,
        p.event.createdAt,
        p.event.streamId ?? null,
        seqBase + i + 1,
      ),
    ),
  );

  let accepted = 0;
  let acceptedBytes = 0;
  results.forEach((res, i) => {
    if ((res.meta?.changes ?? 0) > 0) {
      accepted += 1;
      acceptedBytes += prepared[i]!.bytes;
    }
  });
  const duplicate = events.length - accepted;

  if (acceptedBytes > 0) {
    await env.DB.prepare(
      `update owners
         set stored_bytes = stored_bytes + ?, event_count = event_count + ?
       where owner_id = ?`,
    )
      .bind(acceptedBytes, accepted, ownerId)
      .run();
  }

  return json({ accepted, duplicate });
}

// -----------------------------------------------------------------------------
// Pull (read events)
// -----------------------------------------------------------------------------

async function handlePull(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
): Promise<Response> {
  const ownerId = url.searchParams.get("ownerId");
  const after = url.searchParams.get("after") ?? "";
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return json({ error: "Missing ownerId or bearer token" }, 401);
  }

  const limit = clampPositiveInteger(
    Number(url.searchParams.get("limit") ?? cfg.defaultEventsPerPull),
    cfg.defaultEventsPerPull,
    cfg.maxEventsPerPull,
  );

  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: false,
  });
  if (!auth.ok) return auth.response;

  // Cursor is a monotonic seq. A legacy HLC-string cursor parses to 0 -> the
  // client re-pulls once (deduped client-side) then advances on seq.
  const afterSeq = Number.isFinite(Number(after)) ? Number(after) : 0;
  const { results } = await env.DB.prepare(
    `select seq, envelope_json from events
       where owner_id = ? and seq > ?
       order by seq asc limit ?`,
  )
    .bind(ownerId, afterSeq, limit)
    .all<{ seq: number; envelope_json: string }>();

  const rows = results ?? [];
  const events = rows.map(
    (row) => JSON.parse(row.envelope_json) as SyncEnvelope,
  );
  const nextCursor = String(rows.at(-1)?.seq ?? afterSeq);
  return json({ events, nextCursor });
}

async function handleUsage(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
): Promise<Response> {
  const ownerId = url.searchParams.get("ownerId");
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return json({ error: "Missing ownerId or bearer token" }, 401);
  }

  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: false,
  });
  if (!auth.ok) return auth.response;

  return json({ ownerId, storedBytes: auth.storedBytes });
}

// -----------------------------------------------------------------------------
// Blobs (R2)
// -----------------------------------------------------------------------------

async function handleBlobPut(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
  hash: string,
  ip: string,
): Promise<Response> {
  if (cfg.relayDisabled) return json({ error: "Relay is read-only" }, 503);

  const ownerId = url.searchParams.get("ownerId");
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return json({ error: "Missing ownerId or bearer token" }, 401);
  }

  // Reject oversized chunks by Content-Length before buffering anything.
  if (exceedsContentLength(request, cfg.maxBlobBytes)) {
    return json({ error: "Blob chunk is too large" }, 413);
  }

  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: true,
    ip,
  });
  if (!auth.ok) return auth.response;

  if (!(await env.WRITE_LIMITER.limit({ key: ownerId })).success) {
    return json({ error: "Rate limited" }, 429);
  }

  // Dedupe by content hash before reading the body (metadata lives in D1, so
  // this is one indexed read, no R2 round-trip).
  const existing = await env.DB.prepare(
    `select 1 from blobs where owner_id = ? and hash = ?`,
  )
    .bind(ownerId, hash)
    .first();
  if (existing) return json({ stored: false, duplicate: true });

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return json({ error: "Empty blob" }, 400);
  if (bytes.length > cfg.maxBlobBytes) {
    return json({ error: "Blob chunk is too large" }, 413);
  }

  // The path hash must equal the content hash — clients can't choose keys, and
  // can't poison another owner's namespace (keys are owner-scoped in R2 too).
  if ((await sha256Base64UrlBytes(bytes)) !== hash) {
    return json({ error: "Blob hash mismatch" }, 400);
  }

  if (auth.storedBytes + bytes.length > cfg.maxOwnerBytes) {
    return json({ error: "Owner quota exceeded" }, 413);
  }

  await env.BLOBS.put(blobKey(ownerId, hash), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  // Record metadata + charge usage. `insert or ignore` makes a racing double
  // PUT idempotent; only charge when the row is genuinely new.
  const meta = await env.DB.prepare(
    `insert or ignore into blobs (owner_id, hash, size, created_at)
     values (?, ?, ?, ?)`,
  )
    .bind(ownerId, hash, bytes.length, new Date().toISOString())
    .run();

  const stored = (meta.meta?.changes ?? 0) > 0;
  if (stored) {
    await env.DB.prepare(
      `update owners set stored_bytes = stored_bytes + ? where owner_id = ?`,
    )
      .bind(bytes.length, ownerId)
      .run();
  }

  return json({ stored, duplicate: !stored });
}

async function handleBlobGet(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
  hash: string,
): Promise<Response> {
  const ownerId = url.searchParams.get("ownerId");
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return json({ error: "Missing ownerId or bearer token" }, 401);
  }

  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: false,
  });
  if (!auth.ok) return auth.response;

  const object = await env.BLOBS.get(blobKey(ownerId, hash));
  if (!object) return json({ error: "Unknown blob" }, 404);

  return new Response(object.body, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/octet-stream",
      // Encrypted + content-addressed => safe to cache immutably. Pair with a
      // zone cache rule on /v1/blobs/* so repeat reads are served from cache
      // (no R2 Class-B op, no Worker compute) and R2's free egress applies.
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: hash,
    },
  });
}

async function handleBlobHead(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
  hash: string,
): Promise<Response> {
  const ownerId = url.searchParams.get("ownerId");
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return new Response(null, { status: 401, headers: corsHeaders() });
  }

  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: false,
  });
  if (!auth.ok) {
    return new Response(null, {
      status: auth.response.status,
      headers: corsHeaders(),
    });
  }

  const exists = await env.DB.prepare(
    `select 1 from blobs where owner_id = ? and hash = ?`,
  )
    .bind(ownerId, hash)
    .first();
  return new Response(null, {
    status: exists ? 200 : 404,
    headers: corsHeaders(),
  });
}

// -----------------------------------------------------------------------------
// Auth + owner lifecycle
// -----------------------------------------------------------------------------

type AuthResult =
  | { ok: true; storedBytes: number }
  | { ok: false; response: Response };

async function ensureOwnerAuth(
  env: Env,
  cfg: Config,
  ownerId: string,
  relayAuth: string,
  opts: { createIfMissing: boolean; ip?: string },
): Promise<AuthResult> {
  const relayAuthHash = await sha256Base64Url(relayAuth);
  const owner = await env.DB.prepare(
    `select relay_auth_hash, stored_bytes from owners where owner_id = ?`,
  )
    .bind(ownerId)
    .first<{ relay_auth_hash: string; stored_bytes: number }>();

  if (!owner) {
    if (!opts.createIfMissing) {
      return { ok: false, response: json({ error: "Unknown owner" }, 404) };
    }

    // --- Anti row-spam gate: creating a *new* owner is the only way to grow
    // the fleet, so it's the costliest thing to leave open. Two cheap checks
    // bound it without any account registration (keys-only product promise):
    //   1. per-IP creation rate limit (in-colo)
    //   2. global owner cap (single counter row, no count(*) scan)
    if (opts.ip && !(await env.CREATE_LIMITER.limit({ key: opts.ip })).success) {
      return { ok: false, response: json({ error: "Rate limited" }, 429) };
    }

    const capped = await env.DB.prepare(
      `update relay_meta set value = value + 1
         where key = 'owner_count' and value < ?`,
    )
      .bind(cfg.maxOwners)
      .run();
    if ((capped.meta?.changes ?? 0) === 0) {
      return {
        ok: false,
        response: json({ error: "Relay is at capacity" }, 503),
      };
    }

    const inserted = await env.DB.prepare(
      `insert or ignore into owners
         (owner_id, relay_auth_hash, stored_bytes, event_count, created_at)
       values (?, ?, 0, 0, ?)`,
    )
      .bind(ownerId, relayAuthHash, new Date().toISOString())
      .run();

    // Lost a creation race: roll the counter back so it stays accurate.
    if ((inserted.meta?.changes ?? 0) === 0) {
      await env.DB.prepare(
        `update relay_meta set value = value - 1 where key = 'owner_count'`,
      ).run();
      // Re-read the row the winner created and fall through to auth-check it.
      const racedOwner = await env.DB.prepare(
        `select relay_auth_hash, stored_bytes from owners where owner_id = ?`,
      )
        .bind(ownerId)
        .first<{ relay_auth_hash: string; stored_bytes: number }>();
      if (racedOwner && racedOwner.relay_auth_hash === relayAuthHash) {
        return { ok: true, storedBytes: racedOwner.stored_bytes };
      }
      return {
        ok: false,
        response: json({ error: "Invalid bearer token" }, 401),
      };
    }

    return { ok: true, storedBytes: 0 };
  }

  if (owner.relay_auth_hash !== relayAuthHash) {
    return { ok: false, response: json({ error: "Invalid bearer token" }, 401) };
  }
  return { ok: true, storedBytes: owner.stored_bytes };
}

// -----------------------------------------------------------------------------
// Validation + helpers
// -----------------------------------------------------------------------------

function validateEnvelope(ownerId: string, event: SyncEnvelope): string | null {
  if (!event || typeof event !== "object") return "Invalid event";
  if (event.version !== 1) return "Unsupported event version";
  if (event.ownerId !== ownerId) return "Event owner mismatch";
  if (!isNonEmptyString(event.eventId)) return "Missing eventId";
  if (!isNonEmptyString(event.deviceId)) return "Missing deviceId";
  if (!isNonEmptyString(event.nonce)) return "Missing nonce";
  if (!isNonEmptyString(event.ciphertext)) return "Missing ciphertext";
  if (!isNonEmptyString(event.createdAt)) return "Missing createdAt";
  if (event.streamId !== undefined && typeof event.streamId !== "string") {
    return "Invalid streamId";
  }
  return null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function getBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim() || null;
}

function exceedsContentLength(request: Request, max: number): boolean {
  const header = request.headers.get("content-length");
  if (!header) return false;
  const length = Number(header);
  return Number.isFinite(length) && length > max;
}

function blobKey(ownerId: string, hash: string): string {
  return `${ownerId}/${hash}`;
}

interface Config {
  maxEventBytes: number;
  maxOwnerBytes: number;
  maxEventsPerPush: number;
  maxEventsPerPull: number;
  defaultEventsPerPull: number;
  maxBlobBytes: number;
  maxOwners: number;
  relayDisabled: boolean;
}

function readConfig(env: Env): Config {
  return {
    maxEventBytes: readPositiveInt(env.MAX_EVENT_BYTES, 256 * 1024),
    maxOwnerBytes: readPositiveInt(env.MAX_OWNER_BYTES, 1024 * 1024 * 1024),
    maxEventsPerPush: readPositiveInt(env.MAX_EVENTS_PER_PUSH, 1000),
    maxEventsPerPull: readPositiveInt(env.MAX_EVENTS_PER_PULL, 5000),
    defaultEventsPerPull: readPositiveInt(env.DEFAULT_EVENTS_PER_PULL, 1000),
    maxBlobBytes: readPositiveInt(env.MAX_BLOB_BYTES, 8 * 1024 * 1024),
    maxOwners: readPositiveInt(env.MAX_OWNERS, 100000),
    relayDisabled: env.RELAY_DISABLED === "true",
  };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function clampPositiveInteger(
  value: number,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, HEAD, OPTIONS",
  };
}

// SHA-256 -> base64url (no padding). Matches `@simplysync/protocol` so blob
// content-hash verification agrees with the client. Inlined (rather than
// importing the core helper) to keep the Worker bundle dependency-free.
async function sha256Base64Url(value: string): Promise<string> {
  return sha256Base64UrlBytes(new TextEncoder().encode(value));
}

async function sha256Base64UrlBytes(bytes: Uint8Array): Promise<string> {
  // Slice to a guaranteed ArrayBuffer — WebCrypto's lib types reject the
  // ArrayBufferLike union (it could be a SharedArrayBuffer).
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return base64UrlEncode(new Uint8Array(digest));
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
