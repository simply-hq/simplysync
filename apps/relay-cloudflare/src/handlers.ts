/**
 * Request handling: routing, request validation, status codes, headers, CORS,
 * and body limits — a thin adapter over `src/store.ts`, which owns every D1 and
 * R2 decision. Mirrors `apps/relay-go/handlers.go`.
 *
 * The rule that keeps the seam honest, in both directions: nothing here issues
 * a query, and nothing in the store names a status code. A refusal crosses the
 * seam as a named reason (`AuthDenial`, `PushRejection`) and becomes a status
 * code in exactly one place per reason, below.
 */

import {
  blobExists,
  compactStreams,
  ensureOwnerAuth,
  type OwnerAuth,
  getBlob,
  listEvents,
  ownerStatus,
  pushEvents,
  putBlob,
  readConfig,
  sha256Base64UrlBytes,
  type AuthDenial,
  type Config,
  type Env,
  type PreparedEvent,
  type SyncEnvelope,
} from "./store";

const BLOB_PATH_PREFIX = "/v1/blobs/";
// Reported by /health and /v1/status so clients can tell which relay build
// they're talking to when diagnosing sync issues. Keep in sync with relay-go.
const RELAY_VERSION = "1.0.0";
const HLC_MAX_FUTURE_DRIFT_MS = 5 * 60_000;
const CANONICAL_HLC =
  /^([0-9a-z]{10})-([0-9a-z]{4})-([A-Za-z0-9_.-]+)$/u;

export async function handleRequest(
  request: Request,
  env: Env,
): Promise<Response> {
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
    return json({
      ok: true,
      service: "sbt-local-first-relay",
      version: RELAY_VERSION,
      serverTime: new Date().toISOString(),
    });
  }

  const cfg = readConfig(env);

  // --- Layer 2: per-IP edge-of-Worker rate limit (in-colo, ~free). ---------
  // These in-Worker limits protect the default workers.dev deployment. A
  // custom-domain WAF rule can shed larger floods before Worker execution.
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  if (!(await env.API_LIMITER.limit({ key: ip })).success) {
    return json({ error: "Rate limited" }, 429);
  }

  try {
    if (request.method === "POST" && url.pathname === "/v1/events") {
      return await handlePush(request, env, cfg, ip);
    }
    if (request.method === "POST" && url.pathname === "/v1/streams/compact") {
      return await handleCompactStreams(request, env, cfg);
    }
    if (request.method === "GET" && url.pathname === "/v1/events") {
      return await handlePull(request, env, cfg, url);
    }
    if (request.method === "GET" && url.pathname === "/v1/usage") {
      return await handleUsage(request, env, cfg, url);
    }
    if (request.method === "GET" && url.pathname === "/v1/status") {
      return await handleStatus(request, env, cfg, url);
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
}

/**
 * The store refuses in its own terms; this is the only place a refusal becomes
 * a status code. Exhaustive on purpose — a new denial has to be answered here
 * rather than defaulting into someone else's 500.
 */
function authDenied(denial: AuthDenial): Response {
  switch (denial) {
    case "unknown-owner":
      return json({ error: "Unknown owner" }, 404);
    case "invalid-token":
      return json({ error: "Invalid bearer token" }, 401);
    case "relay-at-capacity":
      return json({ error: "Relay is at capacity" }, 503);
    case "create-rate-limited":
      return json({ error: "Rate limited" }, 429);
  }
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

  const parsed = await readJsonCapped(
    request,
    cfg.maxEventBytes * cfg.maxEventsPerPush,
  );
  if (parsed === "too-large") return json({ error: "Payload too large" }, 413);
  const body = parsed as { ownerId?: unknown; events?: unknown } | null;

  if (!body || typeof body.ownerId !== "string" || !Array.isArray(body.events)) {
    return json({ error: "Invalid push body" }, 400);
  }
  if (body.events.length > cfg.maxEventsPerPush) {
    return json({ error: "Too many events in one push" }, 413);
  }

  const ownerId = body.ownerId;

  // Validate + size every event up front (pure CPU, no DB).
  const prepared: PreparedEvent[] = [];
  for (const event of body.events as SyncEnvelope[]) {
    const validationError = validateEnvelope(ownerId, event);
    if (validationError) return json({ error: validationError }, 400);
    const envelopeJson = JSON.stringify(event);
    const bytes = new TextEncoder().encode(envelopeJson).length;
    if (bytes > cfg.maxEventBytes) return json({ error: "Event is too large" }, 413);
    prepared.push({ event, json: envelopeJson, bytes });
  }

  // Auth + quota (this is where we first touch D1).
  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: true,
    ip,
  });
  if (!auth.ok) return authDenied(auth.denial);

  // Per-owner write rate limit (one key can't hammer writes).
  if (!(await env.WRITE_LIMITER.limit({ key: ownerId })).success) {
    return json({ error: "Rate limited" }, 429);
  }

  const out = await pushEvents(env, cfg, ownerId, auth.storedBytes, prepared);
  if (!out.ok) {
    return out.rejection === "relay-full"
      ? json({ error: "Relay storage is full" }, 507)
      : json({ error: "Owner quota exceeded" }, 413);
  }
  return json({ accepted: out.accepted, duplicate: out.duplicate });
}

// -----------------------------------------------------------------------------
// Compact streams (client-driven tombstone GC)
// -----------------------------------------------------------------------------

// Base64url, 22 chars — the exact shape sealPayload emits.
const STREAM_ID_SHAPE = /^[A-Za-z0-9_-]{22}$/u;

// The owner names fully-purged streams (opaque HMAC ids — the relay learns
// nothing about tables/rows/contents). Only the key holder can compute a
// streamId and auth proves ownership; clients call this after their retention
// window.
async function handleCompactStreams(
  request: Request,
  env: Env,
  cfg: Config,
): Promise<Response> {
  if (cfg.relayDisabled) return json({ error: "Relay is read-only" }, 503);

  const relayAuth = getBearerToken(request);
  if (!relayAuth) return json({ error: "Missing bearer token" }, 401);

  // 22 chars + JSON quoting/comma overhead — 64 bytes/stream is generous.
  if (exceedsContentLength(request, 64 * cfg.maxStreamsPerCompact + 1024)) {
    return json({ error: "Payload too large" }, 413);
  }

  const parsed = await readJsonCapped(
    request,
    64 * cfg.maxStreamsPerCompact + 1024,
  );
  if (parsed === "too-large") return json({ error: "Payload too large" }, 413);
  const body = parsed as { ownerId?: unknown; streamIds?: unknown } | null;

  if (
    !body ||
    typeof body.ownerId !== "string" ||
    !Array.isArray(body.streamIds)
  ) {
    return json({ error: "Invalid compact body" }, 400);
  }
  if (body.streamIds.length > cfg.maxStreamsPerCompact) {
    return json({ error: "Too many streams in one compact" }, 413);
  }
  for (const id of body.streamIds) {
    if (typeof id !== "string" || !STREAM_ID_SHAPE.test(id)) {
      return json({ error: "Invalid stream id" }, 400);
    }
  }

  // Same gate as push, but never create an owner on a purge call.
  const auth = await ensureOwnerAuth(env, cfg, body.ownerId, relayAuth, {
    createIfMissing: false,
  });
  if (!auth.ok) return authDenied(auth.denial);

  if (!(await env.WRITE_LIMITER.limit({ key: body.ownerId })).success) {
    return json({ error: "Rate limited" }, 429);
  }

  return json(
    await compactStreams(env, body.ownerId, body.streamIds as string[]),
  );
}

// -----------------------------------------------------------------------------
// Pull (read events)
// -----------------------------------------------------------------------------

// Shared read-side preamble: ownerId + bearer token, then owner auth without
// ever creating an owner. A Response result is the error to return as-is.
async function authedOwner(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
): Promise<{ ownerId: string; auth: OwnerAuth & { ok: true } } | Response> {
  const ownerId = url.searchParams.get("ownerId");
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return json({ error: "Missing ownerId or bearer token" }, 401);
  }
  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: false,
  });
  if (!auth.ok) return authDenied(auth.denial);
  return { ownerId, auth };
}

async function handlePull(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
): Promise<Response> {
  const authed = await authedOwner(request, env, cfg, url);
  if (authed instanceof Response) return authed;
  const { ownerId } = authed;
  const after = url.searchParams.get("after") ?? "";

  const limit = clampPositiveInteger(
    Number(url.searchParams.get("limit") ?? cfg.defaultEventsPerPull),
    cfg.defaultEventsPerPull,
    cfg.maxEventsPerPull,
  );

  // Pull is the one large response, but do NOT compress it manually here: on
  // Workers, setting Content-Encoding on a hand-gzipped body without
  // `encodeBody: "manual"` makes the runtime re-encode the stream — clients
  // receive double-compressed bytes and every >1 KiB pull fails to parse
  // (which bricked initial sync against a fresh relay). Cloudflare's edge
  // already gzip/brotli-encodes JSON responses per Accept-Encoding, so plain
  // JSON gets the same wire savings with none of the footguns.
  return json(await listEvents(env, ownerId, after, limit, cfg.maxPullBytes));
}

async function handleUsage(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
): Promise<Response> {
  const authed = await authedOwner(request, env, cfg, url);
  if (authed instanceof Response) return authed;
  return json({ ownerId: authed.ownerId, storedBytes: authed.auth.storedBytes });
}

// Per-owner health + quota surface a client app polls to tell apart "relay
// down" / "network" / "quota" / "auth" / "healthy-but-behind". Mirrors the Go
// relay. A reachable-but-never-synced owner gets 404 from auth, which the
// client reads as "relay up, account empty".
async function handleStatus(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
): Promise<Response> {
  const authed = await authedOwner(request, env, cfg, url);
  if (authed instanceof Response) return authed;
  const { ownerId, auth } = authed;

  const info = await ownerStatus(env, ownerId);
  const usedBytes = auth.storedBytes;
  const usedPct =
    cfg.maxOwnerBytes > 0 ? (usedBytes / cfg.maxOwnerBytes) * 100 : 0;
  return json({
    server: { version: RELAY_VERSION, serverTime: new Date().toISOString() },
    account: {
      ownerId,
      quotaBytes: cfg.maxOwnerBytes,
      usedBytes,
      usedPct,
      headSeq: info.headSeq,
      streams: info.streams,
      events: info.events,
      createdAt: auth.createdAt,
    },
  });
}

// -----------------------------------------------------------------------------
// Blobs
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

  // Reject oversized chunks by Content-Length before buffering anything, and
  // before auth — which is also the trust-on-first-use CREATE path, so a chunk
  // that can only ever be rejected must not mint an owner row.
  if (exceedsContentLength(request, cfg.maxBlobBytes)) {
    return json({ error: "Blob chunk is too large" }, 413);
  }

  const auth = await ensureOwnerAuth(env, cfg, ownerId, relayAuth, {
    createIfMissing: true,
    ip,
  });
  if (!auth.ok) return authDenied(auth.denial);

  if (!(await env.WRITE_LIMITER.limit({ key: ownerId })).success) {
    return json({ error: "Rate limited" }, 429);
  }

  // Dedupe by content hash before reading the body (metadata lives in D1, so
  // this is one indexed read, no R2 round-trip).
  if (await blobExists(env, ownerId, hash)) {
    return json({ stored: false, duplicate: true });
  }

  const raw = await readBodyCapped(request, cfg.maxBlobBytes);
  if (raw === "too-large") {
    return json({ error: "Blob chunk is too large" }, 413);
  }
  const bytes = raw;
  if (bytes.length === 0) return json({ error: "Empty blob" }, 400);

  // The path hash must equal the content hash — clients can't choose keys, and
  // can't poison another owner's namespace (keys are owner-scoped in R2 too).
  if ((await sha256Base64UrlBytes(bytes)) !== hash) {
    return json({ error: "Blob hash mismatch" }, 400);
  }

  const out = await putBlob(env, cfg, ownerId, auth.storedBytes, hash, bytes);
  if (!out.ok) {
    return out.rejection === "relay-full"
      ? json({ error: "Relay storage is full" }, 507)
      : json({ error: "Owner quota exceeded" }, 413);
  }
  return json({ stored: out.stored, duplicate: !out.stored });
}

async function handleBlobGet(
  request: Request,
  env: Env,
  cfg: Config,
  url: URL,
  hash: string,
): Promise<Response> {
  const authed = await authedOwner(request, env, cfg, url);
  if (authed instanceof Response) return authed;
  const { ownerId } = authed;

  const object = await getBlob(env, ownerId, hash);
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
    // Same mapping as every other route; a HEAD just drops the body.
    return new Response(null, {
      status: authDenied(auth.denial).status,
      headers: corsHeaders(),
    });
  }

  return new Response(null, {
    status: (await blobExists(env, ownerId, hash)) ? 200 : 404,
    headers: corsHeaders(),
  });
}

// -----------------------------------------------------------------------------
// Validation + helpers
// -----------------------------------------------------------------------------

function validateEnvelope(ownerId: string, event: SyncEnvelope): string | null {
  if (!event || typeof event !== "object") return "Invalid event";
  if (event.version !== 1) return "Unsupported event version";
  if (event.ownerId !== ownerId) return "Event owner mismatch";
  if (!isNonEmptyString(event.eventId)) return "Missing eventId";
  const hlcMillis = parseHlcMillis(event.eventId);
  if (hlcMillis === null) return "Invalid eventId";
  if (hlcMillis > Date.now() + HLC_MAX_FUTURE_DRIFT_MS) {
    return "Future eventId";
  }
  if (!isNonEmptyString(event.deviceId)) return "Missing deviceId";
  if (!isNonEmptyString(event.nonce)) return "Missing nonce";
  if (!isNonEmptyString(event.ciphertext)) return "Missing ciphertext";
  if (!isNonEmptyString(event.createdAt)) return "Missing createdAt";
  // A present streamId must be the exact shape sealPayload emits. null,
  // undefined, and "" all mean "no stream" and are stored as SQL NULL (see
  // insertAndCharge's `|| null`), so an empty id can no longer be grouped by
  // the compaction cron into one stream that deletes an owner's log. This
  // matches the Go relay's validateEnvelope exactly.
  if (event.streamId != null && event.streamId !== "") {
    if (typeof event.streamId !== "string" || !STREAM_ID_SHAPE.test(event.streamId)) {
      return "Invalid streamId";
    }
  }
  return null;
}

function parseHlcMillis(value: string): number | null {
  const match = CANONICAL_HLC.exec(value);
  if (!match) return null;
  const millis = Number.parseInt(match[1]!, 36);
  const counter = Number.parseInt(match[2]!, 36);
  if (!Number.isSafeInteger(millis) || !Number.isSafeInteger(counter)) {
    return null;
  }
  return millis;
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

// Buffer a request body but abort past `max` bytes even when there is no
// Content-Length. exceedsContentLength only sees a declared length; a chunked /
// length-less body slips past it and would otherwise buffer whole into the
// isolate. Returns "too-large" if the stream exceeds the cap. Mirrors the Go
// relay's http.MaxBytesReader on every write route.
async function readBodyCapped(
  request: Request,
  max: number,
): Promise<Uint8Array | "too-large"> {
  const body = request.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function readJsonCapped(
  request: Request,
  max: number,
): Promise<unknown | "too-large"> {
  const raw = await readBodyCapped(request, max);
  if (raw === "too-large") return "too-large";
  try {
    return JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return null;
  }
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
