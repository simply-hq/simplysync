import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  sha256Base64Url,
  sha256Base64UrlBytes,
  type SyncEnvelope,
} from "@simplysync/protocol";
import { ADMIN_PAGE } from "./admin";
import {
  buildStats,
  recordRequest,
  routeLabel,
  setCompactionInfo,
  startSampler,
} from "./metrics";

const PORT = Number(process.env.PORT ?? 4100);
// Reported by /health and /v1/status so clients can tell which relay build
// they're talking to when diagnosing sync issues. Keep in sync with relay-go.
const RELAY_VERSION = "1.0.0";
// When set, the ops dashboard (+ its /stats JSON) is enabled and gated by this
// bearer token. Unset => the admin endpoints don't exist at all (404, same as
// any unknown path — there's no signal a dashboard exists).
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
// The dashboard lives at a *secret* base path, not /admin (which every scanner
// probes). By default the path is derived from the token, so it's unguessable
// without already knowing the secret and needs zero extra config. Override with
// ADMIN_PATH=/your-path. The resolved path is logged at startup.
const ADMIN_BASE = ADMIN_TOKEN ? resolveAdminBase(ADMIN_TOKEN) : "";

function resolveAdminBase(token: string): string {
  const explicit = process.env.ADMIN_PATH?.trim();
  if (explicit) return `/${explicit.replace(/^\/+|\/+$/gu, "")}`;
  const digest = new Bun.CryptoHasher("sha256")
    .update(token)
    .digest("hex")
    .slice(0, 16);
  return `/ops-${digest}`;
}
// Where the SQLite file lives. Defaults to ./data for local dev; production
// deploys point this at a persistent path like /var/lib/simplysync-relay.
const DATA_DIR = process.env.RELAY_DATA_DIR ?? "data";
const MAX_EVENT_BYTES = readPositiveIntegerEnv(
  "MAX_EVENT_BYTES",
  256 * 1024,
);
const MAX_OWNER_BYTES = readPositiveIntegerEnv(
  "MAX_OWNER_BYTES",
  1024 * 1024 * 1024,
);
const MAX_EVENTS_PER_PUSH = readPositiveIntegerEnv(
  "MAX_EVENTS_PER_PUSH",
  1_000,
);
const MAX_EVENTS_PER_PULL = readPositiveIntegerEnv(
  "MAX_EVENTS_PER_PULL",
  5_000,
);
const DEFAULT_EVENTS_PER_PULL = readPositiveIntegerEnv(
  "DEFAULT_EVENTS_PER_PULL",
  1_000,
);
const MAX_BLOB_BYTES = readPositiveIntegerEnv(
  "MAX_BLOB_BYTES",
  8 * 1024 * 1024,
);

const BLOB_PATH_PREFIX = "/v1/blobs/";

mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "relay.db"));
db.exec(`
  pragma journal_mode = WAL;
  pragma synchronous = NORMAL;

  create table if not exists owners (
    owner_id text primary key,
    relay_auth_hash text not null,
    stored_bytes integer not null default 0,
    created_at text not null
  );

  create table if not exists events (
    owner_id text not null,
    event_id text not null,
    device_id text not null,
    envelope_json text not null,
    stored_bytes integer not null,
    created_at text not null,
    stream_id text,
    primary key (owner_id, event_id)
  );

  create index if not exists events_owner_event_id
    on events (owner_id, event_id);

  create table if not exists blobs (
    owner_id text not null,
    hash text not null,
    bytes blob not null,
    size integer not null,
    created_at text not null,
    primary key (owner_id, hash)
  );
`);

// Backfill stream_id on databases created before compaction existed (no-op if
// the column already exists).
try {
  db.exec(`alter table events add column stream_id text`);
} catch {
  // column already present
}

// Supports compaction's "max(event_id) per (owner, stream)" lookups. Created
// after the stream_id backfill above so it works on databases that predate the
// column (where `create table if not exists` was a no-op).
db.exec(
  `create index if not exists events_owner_stream
    on events (owner_id, stream_id, event_id)`,
);

// Monotonic server sequence for a skip-proof pull cursor (HLC eventIds aren't
// globally ordered across devices, so an event_id cursor can permanently skip
// an offline/clock-skewed event). The counter only increases — never reused
// even when compaction deletes rows.
try {
  db.exec(`alter table events add column seq integer`);
} catch {
  // column already present
}
db.exec(`update events set seq = rowid where seq is null`);
db.exec(`create index if not exists events_owner_seq on events (owner_id, seq)`);
db.exec(
  `create table if not exists relay_meta (key text primary key, value integer not null)`,
);
db.exec(`insert or ignore into relay_meta (key, value) values ('event_seq', 0)`);
db.exec(
  `update relay_meta set value = (select coalesce(max(seq), 0) from events) where key = 'event_seq' and value < (select coalesce(max(seq), 0) from events)`,
);

const getEventSeq = db.query<{ value: number }, []>(
  `select value from relay_meta where key = 'event_seq'`,
);
const setEventSeq = db.prepare(
  `update relay_meta set value = ? where key = 'event_seq'`,
);

const getOwner = db.query<{
  owner_id: string;
  relay_auth_hash: string;
  stored_bytes: number;
}, [string]>(
  `select owner_id, relay_auth_hash, stored_bytes from owners where owner_id = ?`,
);
const getOwnerCreatedAt = db.query<{ created_at: string }, [string]>(
  `select created_at from owners where owner_id = ?`,
);
// Head cursor + entity counts for /v1/status (owner-scoped indexes keep it cheap).
const getOwnerEventStats = db.query<
  { head_seq: number; events: number; streams: number },
  [string]
>(
  `select coalesce(max(seq), 0) as head_seq, count(*) as events,
          count(distinct stream_id) as streams
   from events where owner_id = ?`,
);
const insertOwner = db.prepare(
  `insert into owners (owner_id, relay_auth_hash, stored_bytes, created_at)
   values (?, ?, 0, ?)`,
);
const incrementOwnerUsage = db.prepare(
  `update owners set stored_bytes = stored_bytes + ? where owner_id = ?`,
);
const insertEvent = db.prepare(
  `insert or ignore into events
    (owner_id, event_id, device_id, envelope_json, stored_bytes, created_at, stream_id, seq)
   values (?, ?, ?, ?, ?, ?, ?, ?)`,
);
const listEvents = db.query<
  { seq: number; envelope_json: string },
  [string, number, number]
>(
  `select seq, envelope_json
   from events
   where owner_id = ? and seq > ?
   order by seq asc
   limit ?`,
);
const existsBlob = db.query<{ ok: number }, [string, string]>(
  `select 1 as ok from blobs where owner_id = ? and hash = ?`,
);
const getBlobBytes = db.query<{ bytes: Uint8Array }, [string, string]>(
  `select bytes from blobs where owner_id = ? and hash = ?`,
);
const insertBlob = db.prepare(
  `insert or ignore into blobs (owner_id, hash, bytes, size, created_at)
   values (?, ?, ?, ?, ?)`,
);

// --- Log compaction ----------------------------------------------------------
// The event log is append-only, so a row edited N times leaves N events even
// though only the last matters. Because eventId === HLC and the relay's
// event_id ordering is exactly the client's compareHlc order, the highest
// event_id per (owner, streamId) IS the last-writer-wins value. Deleting the
// rest is safe: any device pulling only survivors reconstructs identical state.
// Events without a streamId (legacy / untagged) are never touched.
interface CompactionResult {
  ranAt: string;
  deletedEvents: number;
  reclaimedBytes: number;
  durationMs: number;
}

// Bytes that would be reclaimed = all non-winner events that have a streamId.
const reclaimableBytes = db.query<{ b: number }, []>(`
  select coalesce(sum(stored_bytes), 0) as b from events
  where stream_id is not null
    and event_id < (select max(e2.event_id) from events e2
                    where e2.owner_id = events.owner_id
                      and e2.stream_id = events.stream_id)
`);
// Decrement each owner's usage by the bytes its losers occupied (clamped >= 0).
const reclaimOwnerUsage = db.prepare(`
  update owners set stored_bytes = max(0, stored_bytes - coalesce((
    select sum(e.stored_bytes) from events e
    where e.owner_id = owners.owner_id and e.stream_id is not null
      and e.event_id < (select max(e2.event_id) from events e2
                        where e2.owner_id = e.owner_id and e2.stream_id = e.stream_id)
  ), 0))
`);
const deleteLosers = db.prepare(`
  delete from events where stream_id is not null
    and event_id < (select max(e2.event_id) from events e2
                    where e2.owner_id = events.owner_id
                      and e2.stream_id = events.stream_id)
`);

let lastCompaction: CompactionResult | null = null;

function compactLog(): CompactionResult {
  const start = performance.now();
  const run = db.transaction(() => {
    const reclaimedBytes = reclaimableBytes.get()?.b ?? 0;
    reclaimOwnerUsage.run(); // must run before the delete (reads losers)
    const deletedEvents = deleteLosers.run().changes;
    return { reclaimedBytes, deletedEvents };
  });
  const { reclaimedBytes, deletedEvents } = run();
  // Return freed pages to the OS-visible WAL so the file stops ballooning.
  if (deletedEvents > 0) db.exec(`pragma wal_checkpoint(TRUNCATE)`);
  const result: CompactionResult = {
    ranAt: new Date().toISOString(),
    deletedEvents,
    reclaimedBytes,
    durationMs: Math.round(performance.now() - start),
  };
  lastCompaction = result;
  return result;
}

// Interval in ms; "0" disables. Defaults to every 6 hours.
const COMPACTION_INTERVAL_MS = (() => {
  const raw = process.env.COMPACTION_INTERVAL_MS;
  if (raw === "0") return 0;
  const value = Number(raw ?? 6 * 60 * 60 * 1000);
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 6 * 60 * 60 * 1000;
})();

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    // Instrument every request for the ops dashboard, then delegate to routing.
    const response = await route(request, url);
    recordRequest(routeLabel(request.method, url.pathname), response.status);
    return response;
  },
});

// Sample storage/system stats on a timer so the dashboard can show trends and
// project disk runway. Cheap and in-process; only runs when admin is enabled.
if (ADMIN_TOKEN) startSampler(db, DATA_DIR);

// Periodically compact the log so the DB stops growing with superseded events
// and per-owner quotas reflect current footprint, not lifetime writes.
if (COMPACTION_INTERVAL_MS > 0) {
  const timer = setInterval(() => {
    try {
      const result = compactLog();
      setCompactionInfo(result);
      if (result.deletedEvents > 0) {
        console.log(
          `compaction: removed ${result.deletedEvents} superseded events, ` +
            `reclaimed ${result.reclaimedBytes} bytes in ${result.durationMs}ms`,
        );
      }
    } catch (error) {
      console.error("compaction failed", error);
    }
  }, COMPACTION_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
}

console.log(`Secure local-first relay listening on http://localhost:${PORT}`);
if (ADMIN_TOKEN) {
  // Logged only to the server console (journalctl), so the operator can find
  // the secret path without it being exposed anywhere public.
  console.log(`Ops dashboard: http://localhost:${PORT}${ADMIN_BASE}`);
}
if (COMPACTION_INTERVAL_MS > 0) {
  console.log(
    `Log compaction every ${Math.round(COMPACTION_INTERVAL_MS / 60000)}m`,
  );
}

async function route(request: Request, url: URL): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return json({
      ok: true,
      service: "simplysync-relay",
      version: RELAY_VERSION,
      serverTime: new Date().toISOString(),
    });
  }

  if (
    ADMIN_TOKEN &&
    (url.pathname === ADMIN_BASE ||
      url.pathname === `${ADMIN_BASE}/stats` ||
      url.pathname === `${ADMIN_BASE}/compact`)
  ) {
    return handleAdmin(request, url);
  }

  if (request.method === "POST" && url.pathname === "/v1/events") {
    return handlePush(request);
  }

  if (request.method === "GET" && url.pathname === "/v1/events") {
    return handlePull(request, url);
  }

  if (request.method === "GET" && url.pathname === "/v1/usage") {
    return handleUsage(request, url);
  }

  if (request.method === "GET" && url.pathname === "/v1/status") {
    return handleStatus(request, url);
  }

  if (url.pathname.startsWith(BLOB_PATH_PREFIX)) {
    const hash = decodeURIComponent(
      url.pathname.slice(BLOB_PATH_PREFIX.length),
    );
    if (!hash) return json({ error: "Missing blob hash" }, 400);
    if (request.method === "PUT") return handleBlobPut(request, url, hash);
    if (request.method === "GET") return handleBlobGet(request, url, hash);
    if (request.method === "HEAD") return handleBlobHead(request, url, hash);
    return json({ error: "Method not allowed" }, 405);
  }

  return json({ error: "Not found" }, 404);
}

// Brute-force lockout for the admin token: too many failed attempts from one IP
// trips a cooldown, so the token can't be hammered even if the secret path leaks.
const ADMIN_MAX_FAILS = 10;
const ADMIN_LOCK_MS = 5 * 60_000;
const adminFails = new Map<string, { count: number; until: number }>();

function adminLocked(ip: string): boolean {
  const rec = adminFails.get(ip);
  return rec ? rec.until > Date.now() : false;
}
function adminRecordFail(ip: string): void {
  const rec = adminFails.get(ip) ?? { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= ADMIN_MAX_FAILS) {
    rec.until = Date.now() + ADMIN_LOCK_MS;
    rec.count = 0;
  }
  adminFails.set(ip, rec);
}
function clientIp(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "local"
  );
}

function handleAdmin(request: Request, url: URL): Response {
  // The dashboard shell is served (it holds no data); it prompts for the token
  // client-side and calls <base>/stats with it. The shell living at the secret
  // path is itself proof you already know the path, so it's safe to serve.
  if (url.pathname === ADMIN_BASE && request.method === "GET") {
    return new Response(ADMIN_PAGE, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // <base>/stats — the data. Bearer-gated, constant-time compare, with lockout.
  if (url.pathname === `${ADMIN_BASE}/stats` && request.method === "GET") {
    const auth = adminAuth(request);
    if (!auth.ok) return auth.response;
    return json(buildStats(db, DATA_DIR));
  }

  // <base>/compact — run log compaction on demand (same gate as stats).
  if (url.pathname === `${ADMIN_BASE}/compact` && request.method === "POST") {
    const auth = adminAuth(request);
    if (!auth.ok) return auth.response;
    const result = compactLog();
    setCompactionInfo(result);
    return json(result);
  }

  return json({ error: "Method not allowed" }, 405);
}

// Shared admin auth: lockout check + constant-time token compare.
function adminAuth(
  request: Request,
): { ok: true } | { ok: false; response: Response } {
  const ip = clientIp(request);
  if (adminLocked(ip)) {
    return { ok: false, response: json({ error: "Too many attempts" }, 429) };
  }
  const token = getBearerToken(request);
  if (!token || !timingSafeEqual(token, ADMIN_TOKEN)) {
    adminRecordFail(ip);
    return { ok: false, response: json({ error: "Unauthorized" }, 401) };
  }
  adminFails.delete(ip); // reset on success
  return { ok: true };
}

// Length-independent comparison to avoid leaking the token via timing.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < ab.length; i += 1) diff |= ab[i]! ^ (bb[i] ?? 0);
  return diff === 0;
}

async function handlePush(request: Request): Promise<Response> {
  const relayAuth = getBearerToken(request);
  if (!relayAuth) return json({ error: "Missing bearer token" }, 401);

  const body = (await request.json().catch(() => null)) as {
    ownerId?: unknown;
    events?: unknown;
  } | null;

  if (!body || typeof body.ownerId !== "string" || !Array.isArray(body.events)) {
    return json({ error: "Invalid push body" }, 400);
  }

  if (body.events.length > MAX_EVENTS_PER_PUSH) {
    return json({ error: "Too many events in one push" }, 413);
  }

  const authResult = await ensureOwnerAuth(body.ownerId, relayAuth);
  if (!authResult.ok) return authResult.response;

  let accepted = 0;
  let duplicate = 0;
  let storedBytesDelta = 0;

  const transaction = db.transaction((events: SyncEnvelope[]) => {
    let seq = getEventSeq.get()?.value ?? 0;
    for (const event of events) {
      const validationError = validateEnvelope(body.ownerId as string, event);
      if (validationError) {
        throw new RelayError(validationError, 400);
      }

      const envelopeJson = JSON.stringify(event);
      const storedBytes = new TextEncoder().encode(envelopeJson).length;
      if (storedBytes > MAX_EVENT_BYTES) {
        throw new RelayError("Event is too large", 413);
      }

      const owner = getOwner.get(body.ownerId as string);
      if ((owner?.stored_bytes ?? 0) + storedBytesDelta + storedBytes > MAX_OWNER_BYTES) {
        throw new RelayError("Owner quota exceeded", 413);
      }

      const result = insertEvent.run(
        event.ownerId,
        event.eventId,
        event.deviceId,
        envelopeJson,
        storedBytes,
        event.createdAt,
        event.streamId ?? null,
        seq + 1, // tentative; only consumed if the row is genuinely new
      );

      if (result.changes === 0) {
        duplicate += 1;
      } else {
        accepted += 1;
        storedBytesDelta += storedBytes;
        seq += 1;
      }
    }

    if (storedBytesDelta > 0) {
      incrementOwnerUsage.run(storedBytesDelta, body.ownerId as string);
    }
    if (accepted > 0) setEventSeq.run(seq);
  });

  try {
    transaction(body.events as SyncEnvelope[]);
    return json({ accepted, duplicate });
  } catch (error) {
    if (error instanceof RelayError) {
      return json({ error: error.message }, error.status);
    }
    console.error(error);
    return json({ error: "Failed to store events" }, 500);
  }
}

async function handlePull(request: Request, url: URL): Promise<Response> {
  const after = url.searchParams.get("after") ?? "";
  const requestedLimit = Number(
    url.searchParams.get("limit") ?? DEFAULT_EVENTS_PER_PULL,
  );
  const limit = clampPositiveInteger(
    requestedLimit,
    DEFAULT_EVENTS_PER_PULL,
    MAX_EVENTS_PER_PULL,
  );

  const auth = await authOwner(request, url);
  if (!auth.ok) return auth.response;
  const { ownerId } = auth;

  // Cursor is a monotonic seq. A legacy HLC-string cursor parses to 0 -> the
  // client re-pulls once (deduped by its seen-set) then advances on seq.
  const afterSeq = Number.isFinite(Number(after)) ? Number(after) : 0;
  const rows = listEvents.all(ownerId, afterSeq, limit);
  const events = rows.map((row) => JSON.parse(row.envelope_json) as SyncEnvelope);
  const nextCursor = String(rows.at(-1)?.seq ?? afterSeq);

  // Pull is the one large response (a full page of envelopes), so it's the only
  // one worth compressing. The ciphertext is incompressible, but gzip still
  // recovers most of the base64 inflation plus the repeated JSON scaffolding
  // (field names, ownerId/deviceId, ISO timestamps) on every event.
  return jsonMaybeGzip(request, { events, nextCursor });
}

async function handleUsage(request: Request, url: URL): Promise<Response> {
  const auth = await authOwner(request, url);
  if (!auth.ok) return auth.response;
  const { ownerId } = auth;

  const owner = getOwner.get(ownerId);
  return json({ ownerId, storedBytes: owner?.stored_bytes ?? 0 });
}

// Per-owner health + quota surface a client app polls to tell apart "relay
// down" / "network" / "quota" / "auth" / "healthy-but-behind". Mirrors
// relay-go's handleStatus. A reachable-but-never-synced owner gets 404 from
// authOwner, which the client reads as "relay up, account empty".
async function handleStatus(request: Request, url: URL): Promise<Response> {
  const auth = await authOwner(request, url);
  if (!auth.ok) return auth.response;
  const { ownerId } = auth;

  const owner = getOwner.get(ownerId);
  const createdAt = getOwnerCreatedAt.get(ownerId)?.created_at ?? "";
  const stats = getOwnerEventStats.get(ownerId) ?? {
    head_seq: 0,
    events: 0,
    streams: 0,
  };
  const usedBytes = owner?.stored_bytes ?? 0;
  const usedPct = MAX_OWNER_BYTES > 0 ? (usedBytes / MAX_OWNER_BYTES) * 100 : 0;
  return json({
    server: { version: RELAY_VERSION, serverTime: new Date().toISOString() },
    account: {
      ownerId,
      quotaBytes: MAX_OWNER_BYTES,
      usedBytes,
      usedPct,
      headSeq: stats.head_seq,
      streams: stats.streams,
      events: stats.events,
      createdAt,
    },
  });
}

async function handleBlobPut(
  request: Request,
  url: URL,
  hash: string,
): Promise<Response> {
  const auth = await authOwner(request, url, true);
  if (!auth.ok) return auth.response;
  const { ownerId } = auth;

  // Short-circuit before reading the body: dedupe by content hash.
  if (existsBlob.get(ownerId, hash)) {
    return json({ stored: false, duplicate: true });
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length === 0) return json({ error: "Empty blob" }, 400);
  if (bytes.length > MAX_BLOB_BYTES) {
    return json({ error: "Blob chunk is too large" }, 413);
  }

  // The path hash must equal the content hash — clients can't choose keys.
  if ((await sha256Base64UrlBytes(bytes)) !== hash) {
    return json({ error: "Blob hash mismatch" }, 400);
  }

  const owner = getOwner.get(ownerId);
  if ((owner?.stored_bytes ?? 0) + bytes.length > MAX_OWNER_BYTES) {
    return json({ error: "Owner quota exceeded" }, 413);
  }

  const stored = db.transaction(() => {
    const result = insertBlob.run(
      ownerId,
      hash,
      bytes,
      bytes.length,
      new Date().toISOString(),
    );
    if (result.changes > 0) incrementOwnerUsage.run(bytes.length, ownerId);
    return result.changes > 0;
  })();

  return json({ stored, duplicate: !stored });
}

async function handleBlobGet(
  request: Request,
  url: URL,
  hash: string,
): Promise<Response> {
  const auth = await authOwner(request, url);
  if (!auth.ok) return auth.response;
  const { ownerId } = auth;

  const row = getBlobBytes.get(ownerId, hash);
  if (!row) return json({ error: "Unknown blob" }, 404);

  const body = row.bytes.buffer.slice(
    row.bytes.byteOffset,
    row.bytes.byteOffset + row.bytes.byteLength,
  ) as ArrayBuffer;
  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/octet-stream",
      // Encrypted + content-addressed, so it's safe to cache immutably.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}

async function handleBlobHead(
  request: Request,
  url: URL,
  hash: string,
): Promise<Response> {
  const ownerId = url.searchParams.get("ownerId");
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return new Response(null, { status: 401, headers: corsHeaders() });
  }

  const authResult = await ensureOwnerAuth(ownerId, relayAuth, false);
  if (!authResult.ok) {
    return new Response(null, {
      status: authResult.response.status,
      headers: corsHeaders(),
    });
  }

  const exists = Boolean(existsBlob.get(ownerId, hash));
  return new Response(null, {
    status: exists ? 200 : 404,
    headers: corsHeaders(),
  });
}

// Shared front door for owner-scoped JSON handlers: read the ownerId + bearer
// token off the request and verify them, returning either the validated ownerId
// or the error Response to send. (handleBlobHead doesn't use this — a HEAD must
// answer with a bodiless Response, not a JSON error.)
async function authOwner(
  request: Request,
  url: URL,
  createIfMissing = false,
): Promise<
  { ok: true; ownerId: string } | { ok: false; response: Response }
> {
  const ownerId = url.searchParams.get("ownerId");
  const relayAuth = getBearerToken(request);
  if (!ownerId || !relayAuth) {
    return {
      ok: false,
      response: json({ error: "Missing ownerId or bearer token" }, 401),
    };
  }
  const authResult = await ensureOwnerAuth(ownerId, relayAuth, createIfMissing);
  if (!authResult.ok) return authResult;
  return { ok: true, ownerId };
}

async function ensureOwnerAuth(
  ownerId: string,
  relayAuth: string,
  createIfMissing = true,
): Promise<{ ok: true } | { ok: false; response: Response }> {
  const relayAuthHash = await sha256Base64Url(relayAuth);
  const owner = getOwner.get(ownerId);

  if (!owner) {
    if (!createIfMissing) {
      return { ok: false, response: json({ error: "Unknown owner" }, 404) };
    }

    insertOwner.run(ownerId, relayAuthHash, new Date().toISOString());
    return { ok: true };
  }

  if (owner.relay_auth_hash !== relayAuthHash) {
    return { ok: false, response: json({ error: "Invalid bearer token" }, 401) };
  }

  return { ok: true };
}

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

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: corsHeaders() });
}

// Below this, gzip's header/CPU overhead isn't worth it — small responses go
// out as-is. (Bun.gzipSync handles the compression; the client's fetch sends
// Accept-Encoding and transparently inflates, so no client change is needed.)
const GZIP_MIN_BYTES = 1024;

function acceptsGzip(request: Request): boolean {
  return /\bgzip\b/iu.test(request.headers.get("accept-encoding") ?? "");
}

// Like json(), but gzips the body when the client advertises gzip support and
// the payload is large enough to benefit. Vary: Accept-Encoding keeps any
// intermediary cache from serving a gzipped body to a client that can't decode.
function jsonMaybeGzip(
  request: Request,
  body: unknown,
  status = 200,
): Response {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = {
    ...(corsHeaders() as Record<string, string>),
    "Content-Type": "application/json; charset=utf-8",
    Vary: "Accept-Encoding",
  };
  if (text.length >= GZIP_MIN_BYTES && acceptsGzip(request)) {
    headers["Content-Encoding"] = "gzip";
    return new Response(Bun.gzipSync(new TextEncoder().encode(text)), {
      status,
      headers,
    });
  }
  return new Response(text, { status, headers });
}

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, HEAD, OPTIONS",
  };
}

class RelayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function clampPositiveInteger(
  value: number,
  fallback: number,
  max: number,
): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}
