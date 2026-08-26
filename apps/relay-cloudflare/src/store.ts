/**
 * The relay's store: everything that touches D1 or R2, and nothing that knows
 * what an HTTP status code is.
 *
 * Same division as `apps/relay-go/store.go`, for the same reason. Request
 * handling (`src/handlers.ts`) is a thin adapter — routing, validation,
 * headers, status codes — over a deep module that hides quota accounting,
 * sequence reservation, Compaction, and trust-on-first-use auth. Every refusal
 * here is named in the store's own terms (`AuthDenial`, `PushRejection`) and
 * the adapter owns the mapping to a status code, so an HTTP decision can never
 * hide inside a storage decision.
 *
 * Nothing below constructs a Response, which is also what makes it drivable
 * from a plain test with a stub D1 and no workerd (see `test/store.test.mjs`).
 *
 * Ciphertext-only: rows hold nonce + ciphertext + routing metadata, and the
 * relay has no key for any of it.
 */

// Kept local so this Worker can be deployed directly from its repository
// subdirectory without installing the rest of the SimplySync monorepo. The
// conformance suite verifies this shape against @simplysync/protocol.
export interface SyncEnvelope {
  readonly version: 1;
  readonly ownerId: string;
  readonly eventId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly createdAt: string;
  readonly streamId?: string;
}

export interface RateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  API_LIMITER: RateLimiter;
  CREATE_LIMITER: RateLimiter;
  WRITE_LIMITER: RateLimiter;
  MAX_EVENT_BYTES: string;
  MAX_OWNER_BYTES: string;
  MAX_TOTAL_BYTES?: string;
  MAX_EVENTS_PER_PUSH: string;
  MAX_EVENTS_PER_PULL: string;
  DEFAULT_EVENTS_PER_PULL: string;
  MAX_PULL_BYTES?: string;
  MAX_BLOB_BYTES: string;
  MAX_OWNERS: string;
  MAX_STREAMS_PER_COMPACT?: string;
  RELAY_DISABLED: string;
}

export interface Config {
  maxEventBytes: number;
  maxOwnerBytes: number;
  maxTotalBytes: number;
  maxEventsPerPush: number;
  maxEventsPerPull: number;
  defaultEventsPerPull: number;
  maxPullBytes: number;
  maxBlobBytes: number;
  maxOwners: number;
  maxStreamsPerCompact: number;
  relayDisabled: boolean;
}

export function readConfig(env: Env): Config {
  return {
    maxEventBytes: readPositiveInt(env.MAX_EVENT_BYTES, 256 * 1024),
    maxOwnerBytes: readPositiveInt(env.MAX_OWNER_BYTES, 1024 * 1024 * 1024),
    // Global storage ceiling across all owners; 0 = disabled (per-owner only).
    maxTotalBytes: readPositiveInt(env.MAX_TOTAL_BYTES, 0),
    maxEventsPerPush: readPositiveInt(env.MAX_EVENTS_PER_PUSH, 1000),
    maxEventsPerPull: readPositiveInt(env.MAX_EVENTS_PER_PULL, 5000),
    defaultEventsPerPull: readPositiveInt(env.DEFAULT_EVENTS_PER_PULL, 1000),
    maxPullBytes: readPositiveInt(env.MAX_PULL_BYTES, 8 * 1024 * 1024),
    maxBlobBytes: readPositiveInt(env.MAX_BLOB_BYTES, 8 * 1024 * 1024),
    maxOwners: readPositiveInt(env.MAX_OWNERS, 100000),
    maxStreamsPerCompact: readPositiveInt(env.MAX_STREAMS_PER_COMPACT, 1000),
    relayDisabled: env.RELAY_DISABLED === "true",
  };
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

// -----------------------------------------------------------------------------
// D1 statement arity
// -----------------------------------------------------------------------------

/**
 * D1 caps the bound parameters of a single statement (~100), far below
 * MAX_EVENTS_PER_PUSH and MAX_STREAMS_PER_COMPACT — so every IN list this
 * module builds has to be split. One fact, one home: the push path and the
 * Compaction path share it through this interface rather than by being written
 * next to each other. Exceed it and a full 500-event push 500s before storing
 * anything.
 */
export const D1_MAX_BOUND_IDS = 80;

/** Splits ids into IN-list-sized chunks; empty input yields no chunks. */
export function chunked<T>(
  items: readonly T[],
  size: number = D1_MAX_BOUND_IDS,
): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

// -----------------------------------------------------------------------------
// Owner auth (trust-on-first-use) + lifecycle
// -----------------------------------------------------------------------------

/**
 * Why the store refused, in the store's own terms. `src/handlers.ts` maps each
 * to a status code; this module never names one.
 */
export type AuthDenial =
  | "unknown-owner"
  | "invalid-token"
  | "relay-at-capacity"
  | "create-rate-limited";

export type OwnerAuth =
  | { readonly ok: true; readonly storedBytes: number; readonly createdAt: string }
  | { readonly ok: false; readonly denial: AuthDenial };

export async function ensureOwnerAuth(
  env: Env,
  cfg: Config,
  ownerId: string,
  relayAuth: string,
  opts: { createIfMissing: boolean; ip?: string },
): Promise<OwnerAuth> {
  const relayAuthHash = await sha256Base64Url(relayAuth);
  const owner = await env.DB.prepare(
    `select relay_auth_hash, stored_bytes, created_at from owners where owner_id = ?`,
  )
    .bind(ownerId)
    .first<{ relay_auth_hash: string; stored_bytes: number; created_at: string }>();

  if (!owner) {
    if (!opts.createIfMissing) return { ok: false, denial: "unknown-owner" };

    // --- Anti row-spam gate: creating a *new* owner is the only way to grow
    // the fleet, so it's the costliest thing to leave open. Two cheap checks
    // bound it without any account registration (keys-only product promise):
    //   1. per-IP creation rate limit (in-colo)
    //   2. global owner cap (single counter row, no count(*) scan)
    if (opts.ip && !(await env.CREATE_LIMITER.limit({ key: opts.ip })).success) {
      return { ok: false, denial: "create-rate-limited" };
    }

    const capped = await env.DB.prepare(
      `update relay_meta set value = value + 1
         where key = 'owner_count' and value < ?`,
    )
      .bind(cfg.maxOwners)
      .run();
    if ((capped.meta?.changes ?? 0) === 0) {
      return { ok: false, denial: "relay-at-capacity" };
    }

    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(
      `insert or ignore into owners
         (owner_id, relay_auth_hash, stored_bytes, created_at)
       values (?, ?, 0, ?)`,
    )
      .bind(ownerId, relayAuthHash, createdAt)
      .run();

    // Lost a creation race: roll the counter back so it stays accurate.
    if ((inserted.meta?.changes ?? 0) === 0) {
      await env.DB.prepare(
        `update relay_meta set value = value - 1 where key = 'owner_count'`,
      ).run();
      // Re-read the row the winner created and fall through to auth-check it.
      const racedOwner = await env.DB.prepare(
        `select relay_auth_hash, stored_bytes, created_at from owners where owner_id = ?`,
      )
        .bind(ownerId)
        .first<{ relay_auth_hash: string; stored_bytes: number; created_at: string }>();
      if (racedOwner && timingSafeEqual(racedOwner.relay_auth_hash, relayAuthHash)) {
        return {
          ok: true,
          storedBytes: racedOwner.stored_bytes,
          createdAt: racedOwner.created_at,
        };
      }
      return { ok: false, denial: "invalid-token" };
    }

    return { ok: true, storedBytes: 0, createdAt };
  }

  if (!timingSafeEqual(owner.relay_auth_hash, relayAuthHash)) {
    return { ok: false, denial: "invalid-token" };
  }
  return { ok: true, storedBytes: owner.stored_bytes, createdAt: owner.created_at };
}

/** The per-owner snapshot behind GET /v1/status. `createdAt` rides on the
 * auth read (see OwnerAuth) so this never re-reads the owner row. */
export interface OwnerStatusInfo {
  headSeq: number;
  events: number;
  streams: number;
}

export async function ownerStatus(
  env: Env,
  ownerId: string,
): Promise<OwnerStatusInfo> {
  // Head cursor + counts use the owner-scoped indexes, so these stay cheap.
  const agg = await env.DB.prepare(
    `select coalesce(max(seq), 0) as head_seq, count(*) as events,
            count(distinct stream_id) as streams
     from events where owner_id = ?`,
  )
    .bind(ownerId)
    .first<{ head_seq: number; events: number; streams: number }>();

  return {
    headSeq: agg?.head_seq ?? 0,
    events: agg?.events ?? 0,
    streams: agg?.streams ?? 0,
  };
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

/**
 * A validated envelope plus the two facts the store needs about it: the exact
 * text it is stored as, and the bytes the owner is charged for it.
 *
 * Byte-accounting basis (frozen, plan 009): the canonical basis is the raw
 * received envelope bytes (relay-go's `len(ev.raw)`). Re-serializing via
 * JSON.stringify is byte-identical for compliant canonical envelopes; the
 * conformance suite's cross-relay comparison guards that it stays that way.
 */
export interface PreparedEvent {
  readonly event: SyncEnvelope;
  readonly json: string;
  readonly bytes: number;
}

export type PushRejection = "owner-quota-exceeded" | "relay-full";

export type PushOutcome =
  | { readonly ok: true; readonly accepted: number; readonly duplicate: number }
  | { readonly ok: false; readonly rejection: PushRejection };

/**
 * Stores a validated batch and charges the owner for the bytes it keeps.
 *
 * Three invariants, each named and owned by its own function below rather than
 * described in prose here:
 *
 *   chargeableBytes  — the quota decision counts genuinely-new bytes only.
 *   reserveSeqRange  — the batch's pull cursors, reserved in one atomic bump.
 *   insertAndCharge  — rows and their charge commit together, never apart.
 *
 * `storedBytes` is the owner's current usage, already read by the caller's
 * auth; passing it in keeps this to one D1 read per decision.
 */
export async function pushEvents(
  env: Env,
  cfg: Config,
  ownerId: string,
  storedBytes: number,
  prepared: readonly PreparedEvent[],
): Promise<PushOutcome> {
  // Cheap up-front guard: reject outright if the owner is already over quota,
  // so a doomed push doesn't waste a write.
  if (storedBytes > cfg.maxOwnerBytes) {
    return { ok: false, rejection: "owner-quota-exceeded" };
  }

  const chargeable = await chargeableBytes(env.DB, ownerId, prepared);
  if (storedBytes + chargeable > cfg.maxOwnerBytes) {
    return { ok: false, rejection: "owner-quota-exceeded" };
  }

  // Global storage ceiling (opt-in): per-owner quotas bound one tenant, but
  // maxOwners × maxOwnerBytes multiplies to far more than the account should
  // hold. On Cloudflare this is a metered-spend bound rather than a disk one.
  if (cfg.maxTotalBytes > 0 && chargeable > 0) {
    const total = await fleetStoredBytes(env.DB);
    if (total + chargeable > cfg.maxTotalBytes) {
      return { ok: false, rejection: "relay-full" };
    }
  }

  const range = await reserveSeqRange(env.DB, prepared.length);
  const accepted = await insertAndCharge(env.DB, ownerId, prepared, range);
  return { ok: true, accepted, duplicate: prepared.length - accepted };
}

/**
 * The bytes this push would genuinely add. Enforcing the quota against these —
 * not against a naive sum of everything submitted — is what makes an idempotent
 * retry free: a re-push of events the relay already holds stores nothing, so it
 * must cost nothing, not even for an owner sitting exactly at the cap (the
 * CORRECTNESS-05a divergence). An over-cap push of new bytes is still rejected
 * whole, matching Go.
 *
 * This read informs only the DECISION; the actual charge comes from the seq
 * range the insert reserves, which makes it self-correcting under a concurrent
 * racing push: if a peer inserts one of "our new" events first, our
 * `insert or ignore` skips it (no seq consumed in our range) and we charge only
 * our real inserts — we under-charge here, never double. Residual overshoot is
 * therefore only possible across concurrent pushes (inherent to D1 having no
 * cross-request write lock), matching the Go relay's concurrent overshoot.
 *
 * One intentional, benign difference from Go's per-event check: a pure-duplicate
 * re-push while the owner sits exactly AT cap charges 0 here and returns
 * 200/duplicate, whereas Go adds the duplicate's bytes per-event and can reject.
 * A no-op store shouldn't be rejected, so we don't replicate that quirk.
 */
export async function chargeableBytes(
  db: D1Database,
  ownerId: string,
  prepared: readonly PreparedEvent[],
): Promise<number> {
  const stored = new Set<string>();
  for (const chunk of chunked(prepared)) {
    const existing = await db
      .prepare(
        `select event_id from events
         where owner_id = ? and event_id in (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(ownerId, ...chunk.map((p) => p.event.eventId))
      .all<{ event_id: string }>();
    for (const row of existing.results ?? []) stored.add(row.event_id);
  }
  return prepared.reduce(
    (sum, p) => (stored.has(p.event.eventId) ? sum : sum + p.bytes),
    0,
  );
}

/** Total bytes stored across every owner — the input to the global ceiling. */
export async function fleetStoredBytes(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`select coalesce(sum(stored_bytes), 0) as total from owners`)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/**
 * A half-open run of pull cursors owned by one push: the rows it inserts are
 * exactly those with `base < seq <= high`.
 */
export interface SeqRange {
  readonly base: number;
  readonly high: number;
}

/**
 * Reserves `count` consecutive cursors for one batch. RETURNING hands back the
 * post-increment counter, so concurrent pushes get disjoint ranges and never
 * collide, and the counter only ever increases — a cursor is never reused, even
 * after Compaction deletes the row that consumed it. Events take positions in
 * the range by index; duplicates just leave a harmless gap.
 */
export async function reserveSeqRange(
  db: D1Database,
  count: number,
): Promise<SeqRange> {
  const seqRow = await db
    .prepare(
      `update relay_meta set value = value + ? where key = 'event_seq' returning value`,
    )
    .bind(count)
    .first<{ value: number }>();
  const base = (seqRow?.value ?? count) - count;
  return { base, high: base + count };
}

/**
 * Inserts the batch and charges the owner in ONE `batch()` — D1 runs a batch as
 * a single atomic transaction — so events are never stored without their bytes
 * being charged in the same commit (CORRECTNESS-06). Per-statement `changes`
 * isn't visible until the whole batch returns, so the usage update recomputes
 * its delta from the rows this push actually inserted, identified by the
 * reserved seq range: duplicates never consume a row in that range, so the sum
 * is exactly the accepted bytes.
 */
async function insertAndCharge(
  db: D1Database,
  ownerId: string,
  prepared: readonly PreparedEvent[],
  range: SeqRange,
): Promise<number> {
  const insertStmt = db.prepare(
    `insert or ignore into events
       (owner_id, event_id, device_id, envelope_json, stored_bytes, created_at, stream_id, seq)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const usageStmt = db
    .prepare(
      `update owners
         set stored_bytes = stored_bytes + (
               select coalesce(sum(stored_bytes), 0) from events
               where owner_id = ? and seq > ? and seq <= ?
             )
       where owner_id = ?`,
    )
    .bind(ownerId, range.base, range.high, ownerId);

  const results = await db.batch([
    ...prepared.map((p, i) =>
      insertStmt.bind(
        p.event.ownerId,
        p.event.eventId,
        p.event.deviceId,
        p.json,
        p.bytes,
        p.event.createdAt,
        // `|| null` (not `??`): an empty streamId is "no stream", stored as
        // SQL NULL so the compaction cron never groups it. validateEnvelope
        // already rejects a present, non-empty, malformed id upstream.
        p.event.streamId || null,
        range.base + i + 1,
      ),
    ),
    usageStmt,
  ]);

  let accepted = 0;
  for (const res of results.slice(0, prepared.length)) {
    if ((res.meta?.changes ?? 0) > 0) accepted += 1;
  }
  return accepted;
}

export interface EventPage {
  readonly events: SyncEnvelope[];
  readonly nextCursor: string;
}

export async function listEvents(
  env: Env,
  ownerId: string,
  after: string,
  limit: number,
  maxBytes: number,
): Promise<EventPage> {
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
  // Bound the response page by bytes as well as count: at the 256 KiB/event max
  // the count cap alone lets one page reach hundreds of MiB, doubling during
  // JSON.stringify. Stop after at least one row so the pull always advances;
  // the client loops on nextCursor. Matches the Go relay's listEvents.
  const events: SyncEnvelope[] = [];
  let cursor = afterSeq;
  let accumulated = 0;
  for (const row of rows) {
    events.push(JSON.parse(row.envelope_json) as SyncEnvelope);
    cursor = row.seq;
    accumulated += row.envelope_json.length;
    if (maxBytes > 0 && accumulated >= maxBytes) break;
  }
  return { events, nextCursor: String(cursor) };
}

// -----------------------------------------------------------------------------
// Blobs (R2 bytes, D1 metadata)
// -----------------------------------------------------------------------------

function blobKey(ownerId: string, hash: string): string {
  return `${ownerId}/${hash}`;
}

export async function blobExists(
  env: Env,
  ownerId: string,
  hash: string,
): Promise<boolean> {
  const existing = await env.DB.prepare(
    `select 1 from blobs where owner_id = ? and hash = ?`,
  )
    .bind(ownerId, hash)
    .first();
  return Boolean(existing);
}

export function getBlob(
  env: Env,
  ownerId: string,
  hash: string,
): Promise<R2ObjectBody | null> {
  return env.BLOBS.get(blobKey(ownerId, hash));
}

export type BlobRejection = "owner-quota-exceeded" | "relay-full";

export type PutBlobOutcome =
  | { readonly ok: true; readonly stored: boolean }
  | { readonly ok: false; readonly rejection: BlobRejection };

/**
 * Stores a content-addressed chunk and charges usage if it is genuinely new.
 *
 * Write ordering, deliberately (the Go relay gets this from one locked SQLite
 * transaction; here the bytes and the metadata live in different stores, so the
 * order is the guarantee):
 *
 *   1. R2 first. The key IS the content hash, so a failure after this leaves an
 *      unreferenced object that nothing can read (every read path goes through
 *      the D1 row) and that the next PUT of the same hash overwrites
 *      byte-for-byte — an orphan, never a corruption.
 *   2. Metadata + the usage charge in ONE batch, which D1 runs as a single
 *      transaction. So the relay can never charge an owner for a chunk it has
 *      no metadata for, nor record metadata pointing at bytes it never wrote.
 */
export async function putBlob(
  env: Env,
  cfg: Config,
  ownerId: string,
  storedBytes: number,
  hash: string,
  bytes: Uint8Array,
): Promise<PutBlobOutcome> {
  if (storedBytes + bytes.length > cfg.maxOwnerBytes) {
    return { ok: false, rejection: "owner-quota-exceeded" };
  }
  if (cfg.maxTotalBytes > 0) {
    const total = await fleetStoredBytes(env.DB);
    if (total + bytes.length > cfg.maxTotalBytes) {
      return { ok: false, rejection: "relay-full" };
    }
  }

  await env.BLOBS.put(blobKey(ownerId, hash), bytes, {
    httpMetadata: { contentType: "application/octet-stream" },
  });

  // The charge runs BEFORE the insert inside that transaction, so its
  // `not exists` reads the pre-insert state: the owner is charged exactly when
  // the row is new. `insert or ignore` makes a racing double PUT idempotent,
  // and because both statements read the same pre-state, its `changes` is the
  // decision the charge already made.
  const [, meta] = await env.DB.batch([
    env.DB.prepare(
      `update owners set stored_bytes = stored_bytes + ?
         where owner_id = ?
           and not exists (
             select 1 from blobs where owner_id = ? and hash = ?
           )`,
    ).bind(bytes.length, ownerId, ownerId, hash),
    env.DB.prepare(
      `insert or ignore into blobs (owner_id, hash, size, created_at)
       values (?, ?, ?, ?)`,
    ).bind(ownerId, hash, bytes.length, new Date().toISOString()),
  ]);

  return { ok: true, stored: (meta?.meta?.changes ?? 0) > 0 };
}

// -----------------------------------------------------------------------------
// Compaction
// -----------------------------------------------------------------------------

export interface CompactionOutcome {
  readonly deletedEvents: number;
  readonly reclaimedBytes: number;
}

/**
 * Drops every event of the named streams — winners and tombstones alike: the
 * owner has asserted the logical rows are fully purged. Idempotent: unknown
 * streamIds are a no-op. R2 blobs are untouched (no blob GC here).
 *
 * Every chunk lands in ONE batch — a single implicit transaction — with each
 * chunk's usage reclaim ordered before its delete (the reclaim's subquery reads
 * the rows the delete removes), mirroring compactLog.
 */
export async function compactStreams(
  env: Env,
  ownerId: string,
  streamIds: readonly string[],
): Promise<CompactionOutcome> {
  if (streamIds.length === 0) return { deletedEvents: 0, reclaimedBytes: 0 };

  // Reported reclaimed bytes come from a pre-read (the batch's own reclaim
  // subquery is what actually adjusts usage, atomically with the delete); a
  // concurrent push racing this call can skew the *reported* number only.
  let reclaimedBytes = 0;
  // Statements alternate reclaim/delete by construction, so odd indexes are
  // the deletes whose `changes` count as deleted events.
  const plan: D1PreparedStatement[] = [];

  for (const chunk of chunked(streamIds)) {
    const inList = chunk.map(() => "?").join(", ");
    const preRead = await env.DB.prepare(
      `select coalesce(sum(stored_bytes), 0) as b from events
       where owner_id = ? and stream_id in (${inList})`,
    )
      .bind(ownerId, ...chunk)
      .first<{ b: number }>();
    reclaimedBytes += preRead?.b ?? 0;
    plan.push(
      env.DB.prepare(
        `update owners set stored_bytes = max(0, stored_bytes - coalesce((
           select sum(stored_bytes) from events
           where owner_id = ?1 and stream_id in (${chunk
             .map((_, j) => `?${j + 2}`)
             .join(", ")})), 0))
         where owner_id = ?1`,
      ).bind(ownerId, ...chunk),
      env.DB.prepare(
        `delete from events where owner_id = ? and stream_id in (${inList})`,
      ).bind(ownerId, ...chunk),
    );
  }

  const results = await env.DB.batch(plan);
  let deletedEvents = 0;
  for (let i = 1; i < results.length; i += 2) {
    deletedEvents += results[i]?.meta?.changes ?? 0;
  }

  return { deletedEvents, reclaimedBytes };
}

/**
 * The scheduled pass over the append-only log. Same invariant as the Go relay —
 * eventId === HLC, and event_id order is the client's LWW order, so keeping the
 * max event_id per (owner, streamId) is exactly the last-writer value. A fresh
 * device pulling only survivors reconstructs identical state. Events without a
 * streamId are never touched.
 */
export async function compactLog(env: Env): Promise<void> {
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
// Digests
// -----------------------------------------------------------------------------

// SHA-256 -> base64url (no padding). Matches `@simplysync/protocol` so blob
// content-hash verification agrees with the client, and so an owner's auth hash
// is the same value every port computes. Inlined (rather than importing the
// core helper) to keep the Worker bundle dependency-free.
async function sha256Base64Url(value: string): Promise<string> {
  return sha256Base64UrlBytes(new TextEncoder().encode(value));
}

// Constant-time compare of the two equal-length base64url SHA-256 digests, so
// the relay's primary auth check leaks no timing signal (matches the Go relay's
// subtle.ConstantTimeCompare; the V8 runtime has no timingSafeEqual).
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export async function sha256Base64UrlBytes(bytes: Uint8Array): Promise<string> {
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
