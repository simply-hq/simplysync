import {
  compareHlc,
  createHlc,
  getHlcAdmissibility,
  parseHlc,
  SYNC_SCHEMA_VERSION,
  type SyncPayload,
} from "@simplysync/protocol";
import type {
  DbSnapshot,
  SchemaDefinition,
  SyncEngineConfig,
} from "../engine-types.js";
import {
  OUTBOX_PUSH_BATCH,
  SYNC_DEFERRED_TABLE,
  SYNC_LOG_CAP,
  SYNC_LOG_TABLE,
  SYNC_META_TABLE,
  SYNC_OUTBOX_RELAY_TABLE,
  SYNC_OUTBOX_TABLE,
  SYNC_PURGE_TABLE,
  SYNC_SEEN_TABLE,
} from "./constants.js";
import type { SyncFailureKind, SyncLogEntry } from "../engine-types.js";
import type { EngineState } from "./state.js";

// Extract the wall-clock millis encoded in an HLC's first segment
// (`base36(millis,10)-base36(counter,4)-deviceId`). Returns null if malformed.
function hlcMillis(hlc: string): number | null {
  return parseHlc(hlc)?.millis ?? null;
}

export type Store = ReturnType<typeof createStore>;

function sqliteDefault(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("SimplySync schema defaults must be finite numbers or strings.");
}

/**
 * The local SQLite layer: physical schema creation, the `_sync_meta` key/value
 * store, row upserts, and value coercion against the typed schema. Everything
 * here reads `state.driver` at call time, so it safely no-ops before the driver
 * is opened.
 */
export function createStore(
  state: EngineState,
  schema: SchemaDefinition,
  config: SyncEngineConfig,
  schemaVersion: number = SYNC_SCHEMA_VERSION,
) {
  const ensureSchema = () => {
    const { driver } = state;
    if (!driver) return;
    driver.exec("pragma journal_mode = WAL;");
    for (const [table, columns] of Object.entries(schema)) {
      const defs: string[] = ['"id" text primary key'];
      const columnTypes: Array<[string, string, unknown?]> = [];
      for (const [name, type] of Object.entries(columns)) {
        if (name === "id") continue;
        const defaultSql = type.defaultValue === undefined
          ? ""
          : ` not null default ${sqliteDefault(type.defaultValue)}`;
        defs.push(`"${name}" ${type.sqlite}${defaultSql}`);
        columnTypes.push([name, type.sqlite, type.defaultValue]);
      }
      defs.push('"createdAt" text');
      defs.push('"updatedAt" text');
      defs.push('"isDeleted" integer default 0');
      driver.exec(
        `create table if not exists "${table}" (${defs.join(", ")});`,
      );
      // Additive migration. `create table if not exists` is a no-op on a table
      // that already exists, so a schema that has grown new columns since the
      // table was first created (apps add fields as they evolve — a todo gains
      // `dueDate`, a message gains `replyToId`) would never get them. Reconcile
      // by adding any missing column: ALTER ADD COLUMN is metadata-only in
      // SQLite, and existing rows read NULL for the new column until a write
      // backfills it — which merges cleanly under LWW like any field edit. Only
      // additive (never rename/drop): old and new app versions stay
      // wire-compatible against the same relay. New *tables* are handled by the
      // create above; new *indexes* by `create index if not exists` below.
      const present = new Set(
        driver
          .select<{ name: string }>(`pragma table_info("${table}")`)
          .map((c) => c.name),
      );
      for (const [name, sqlite, defaultValue] of columnTypes) {
        if (!present.has(name)) {
          const defaultSql = defaultValue === undefined
            ? ""
            : ` not null default ${sqliteDefault(defaultValue)}`;
          driver.exec(
            `alter table "${table}" add column "${name}" ${sqlite}${defaultSql};`,
          );
        } else if (defaultValue !== undefined) {
          // Databases created before a column gained a declared default may
          // contain NULLs. Normalize them once so subsequent merged payloads
          // match the schema's canonical row shape on every platform.
          driver.exec(`update "${table}" set "${name}" = ? where "${name}" is null`, [
            defaultValue,
          ]);
        }
      }
    }
    for (const { name, table, columns } of config.indexes ?? []) {
      if (!table || columns.length === 0) continue;
      driver.exec(
        `create index if not exists "${name}" on "${table}" (${columns
          .map((c) => `"${c}"`)
          .join(", ")});`,
      );
    }
    // `payload_json` holds the plaintext event (same trust level as the local
    // row itself) written SYNCHRONOUSLY, in the same transaction as the row it
    // replicates — see insertPendingOutboxEvent. `envelope_json` starts as ''
    // ("not yet sealed") and is filled in by the async seal step
    // (sealPendingOutbox in relay.ts) before the row is ever pushed; a relay
    // only ever receives envelope_json, never payload_json. This makes the row
    // write and its outbox marker atomic without requiring the (necessarily
    // async) encryption step to run inside the write transaction.
    driver.exec(
      `create table if not exists "${SYNC_OUTBOX_TABLE}" (event_id text primary key, payload_json text, envelope_json text not null default '', pushed_at text);`,
    );
    // Additive migration for databases created before payload_json existed:
    // `create table if not exists` above is a no-op on them, so backfill the
    // column here (metadata-only in SQLite). Their existing rows already carry
    // a real (sealed) envelope_json and a NULL payload_json, which reads as
    // "already sealed" below — nothing to re-encrypt, no data loss.
    const outboxColumns = new Set(
      driver
        .select<{ name: string }>(`pragma table_info("${SYNC_OUTBOX_TABLE}")`)
        .map((c) => c.name),
    );
    if (!outboxColumns.has("payload_json")) {
      driver.exec(
        `alter table "${SYNC_OUTBOX_TABLE}" add column payload_json text;`,
      );
    }
    // A cursor says only that a relay accepted some highest event id; it cannot
    // prove that a lower-sorting event which arrived later (for example from a
    // sibling browser tab) reached that relay. Keep exact acknowledgements while
    // an event is in the outbox so every configured relay gets one attempt.
    driver.exec(
      `create table if not exists "${SYNC_OUTBOX_RELAY_TABLE}" (` +
        `event_id text not null, relay text not null, ` +
        `primary key (event_id, relay));`,
    );
    driver.exec(
      `create table if not exists "${SYNC_SEEN_TABLE}" (event_id text primary key);`,
    );
    driver.exec(
      `create table if not exists "${SYNC_DEFERRED_TABLE}" (` +
        `event_id text primary key, payload_json text not null, retry_after_ms integer);`,
    );
    // NULL means the payload is opaque until a schema/app upgrade (unknown
    // table or future payload version). A timestamp means only wall-clock
    // recovery is needed. Older databases predate the distinction, so their
    // rows start opaque and are classified once by the bounded boot replay.
    const deferredColumns = new Set(
      driver
        .select<{ name: string }>(`pragma table_info("${SYNC_DEFERRED_TABLE}")`)
        .map((column) => column.name),
    );
    if (!deferredColumns.has("retry_after_ms")) {
      driver.exec(
        `alter table "${SYNC_DEFERRED_TABLE}" add column retry_after_ms integer;`,
      );
    }
    driver.exec(
      `create index if not exists "${SYNC_DEFERRED_TABLE}_retry" ` +
        `on "${SYNC_DEFERRED_TABLE}" (retry_after_ms, event_id);`,
    );
    driver.exec(
      `create table if not exists "${SYNC_META_TABLE}" (key text primary key, value text not null);`,
    );
    driver.exec(
      `create table if not exists "${SYNC_LOG_TABLE}" (` +
        `seq integer primary key autoincrement, at text not null, relay text not null, ` +
        `phase text not null, result text not null, kind text, message text, ` +
        `pushed integer not null default 0, pulled integer not null default 0, ` +
        `applied integer not null default 0);`,
    );
    // Purged rows whose relay streams still await `POST /v1/streams/compact`.
    // Written in the SAME transaction as the hard delete (purgeDeleted /
    // purgeRows) because the streamId can't be re-derived once the row is gone
    // — the HMAC input is (table, rowId). `acked_bases` is a JSON array of
    // relay base URLs that have acknowledged; the drain (relay.ts) deletes the
    // row once every currently-configured relay is in it.
    driver.exec(
      `create table if not exists "${SYNC_PURGE_TABLE}" (` +
        `table_name text not null, row_id text not null, ` +
        `acked_bases text not null default '[]', ` +
        `primary key (table_name, row_id));`,
    );
  };

  // --- Sync diagnostics log (device-local; not synced) -----------------------

  const appendSyncLog = (entry: {
    relay: string;
    phase: string;
    result: "ok" | "fail";
    kind?: SyncFailureKind;
    message?: string;
    pushed?: number;
    pulled?: number;
    applied?: number;
  }) => {
    const { driver } = state;
    if (!driver) return;
    driver.exec(
      `insert into "${SYNC_LOG_TABLE}" (at, relay, phase, result, kind, message, pushed, pulled, applied) ` +
        `values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        entry.relay,
        entry.phase,
        entry.result,
        entry.kind ?? null,
        entry.message ?? null,
        entry.pushed ?? 0,
        entry.pulled ?? 0,
        entry.applied ?? 0,
      ],
    );
    // Ring buffer: drop everything older than the most recent SYNC_LOG_CAP rows.
    driver.exec(
      `delete from "${SYNC_LOG_TABLE}" where seq <= ` +
        `(select seq from "${SYNC_LOG_TABLE}" order by seq desc limit 1 offset ?)`,
      [SYNC_LOG_CAP],
    );
  };

  const recentSyncLog = (limit = 100): SyncLogEntry[] => {
    const { driver } = state;
    if (!driver) return [];
    return driver
      .select<{
        seq: number;
        at: string;
        relay: string;
        phase: string;
        result: "ok" | "fail";
        kind: SyncFailureKind | null;
        message: string | null;
        pushed: number;
        pulled: number;
        applied: number;
      }>(
        `select * from "${SYNC_LOG_TABLE}" order by seq desc limit ?`,
        [limit],
      )
      .map((row) => ({
        seq: row.seq,
        at: row.at,
        relay: row.relay,
        phase: row.phase,
        result: row.result,
        kind: row.kind ?? undefined,
        message: row.message ?? undefined,
        pushed: row.pushed,
        pulled: row.pulled,
        applied: row.applied,
      }));
  };

  const pendingOutboxCount = (): number => {
    const { driver } = state;
    if (!driver) return 0;
    return (
      driver.select<{ c: number }>(
        `select count(*) as c from "${SYNC_OUTBOX_TABLE}" where pushed_at is null`,
      )[0]?.c ?? 0
    );
  };

  // `_sync_meta` is a string-keyed table, and those key strings are an on-disk
  // contract the Kotlin and Swift ports read too — they are not renameable.
  // What is not a contract is every caller having to spell them: a key typed
  // in one module and globbed in another drifts apart with no type error and
  // no failing test. The keys live here and callers ask for facts instead.
  const getMeta = (key: string): string | null => {
    if (!state.driver) return null;
    const rows = state.driver.select<{ value: string }>(
      `select value from "${SYNC_META_TABLE}" where key = ?`,
      [key],
    );
    return rows[0]?.value ?? null;
  };

  const setMeta = (key: string, value: string) => {
    state.driver?.exec(
      `insert into "${SYNC_META_TABLE}" (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`,
      [key, value],
    );
  };

  // The three per-relay key prefixes. `relayStateKeys` is the single list that
  // `hasRelayHistory` scans and `resetRelaySyncState` deletes, so the two can
  // no longer disagree about what "this device knows about a relay" means.
  const pullCursorKey = (base: string) => `cursor:${base}`;
  const pushCursorKey = (base: string) => `push:${base}`;
  const backfillMarkerKey = (base: string) => `backfill:${base}`;
  const relayStateKeys = (base: string) => [
    pullCursorKey(base),
    pushCursorKey(base),
    backfillMarkerKey(base),
  ];

  const pullCursor = (base: string): string | null => getMeta(pullCursorKey(base));
  const setPullCursor = (base: string, cursor: string): void =>
    setMeta(pullCursorKey(base), cursor);
  const pushCursor = (base: string): string | null => getMeta(pushCursorKey(base));

  // The HLC high-water mark, so the clock stays monotonic across restarts.
  const clockHighWaterMark = (): { time: number; counter: number } => ({
    time: Number(getMeta("hlc:time") ?? "0") || 0,
    counter: Number(getMeta("hlc:counter") ?? "0") || 0,
  });
  const setClockHighWaterMark = (time: number, counter: number): void => {
    setMeta("hlc:time", String(time));
    setMeta("hlc:counter", String(counter));
  };

  // The Seen set: which relay-delivered events this device has already
  // processed. It is what makes a re-pull free and a duplicate within one page
  // harmless. Safe to prune from the oldest end — the pull cursor only
  // advances, so pruned ids are not re-delivered, and apply is idempotent
  // under last-writer-wins even if one were.
  const hasSeenEvent = (eventId: string): boolean =>
    (state.driver?.select(
      `select 1 from "${SYNC_SEEN_TABLE}" where event_id = ?`,
      [eventId],
    ).length ?? 0) > 0;

  const markEventSeen = (eventId: string): void => {
    state.driver?.exec(
      `insert or ignore into "${SYNC_SEEN_TABLE}" (event_id) values (?)`,
      [eventId],
    );
  };

  const pruneSeen = (cap: number): void => {
    const { driver } = state;
    if (!driver) return;
    const count =
      driver.select<{ c: number }>(
        `select count(*) as c from "${SYNC_SEEN_TABLE}"`,
      )[0]?.c ?? 0;
    if (count <= cap) return;
    driver.exec(
      `delete from "${SYNC_SEEN_TABLE}" where event_id not in ` +
        `(select event_id from "${SYNC_SEEN_TABLE}" order by event_id desc limit ?)`,
      [cap],
    );
  };

  // A temporary `setTransports([])` must not turn a previously synced database
  // into a "local-only" one for tombstone GC. Relay cursors/backfill markers
  // are durable evidence that stale peers may still exist.
  const hasRelayHistory = (): boolean => {
    if (!state.driver) return false;
    const prefixes = relayStateKeys("").map((key) => `${key}*`);
    return (
      state.driver.select(
        `select 1 from "${SYNC_META_TABLE}" ` +
          `where ${prefixes.map(() => "key glob ?").join(" or ")} ` +
          `limit 1`,
        prefixes,
      ).length > 0
    );
  };

  const deferRemoteEvent = (
    eventId: string,
    payloadJson: string,
    retryAfterMs: number | null = null,
  ): void => {
    state.driver?.exec(
      `insert or replace into "${SYNC_DEFERRED_TABLE}" ` +
        `(event_id, payload_json, retry_after_ms) values (?, ?, ?)`,
      [eventId, payloadJson, retryAfterMs],
    );
  };

  const listOpaqueDeferredEvents = (
    afterEventId: string | null,
    limit: number,
  ): Array<{
    eventId: string;
    payloadJson: string;
  }> => {
    if (!state.driver) return [];
    const afterClause = afterEventId === null ? "" : " and event_id > ?";
    const args = afterEventId === null ? [limit] : [afterEventId, limit];
    return state.driver
      .select<{ event_id: string; payload_json: string }>(
        `select event_id, payload_json from "${SYNC_DEFERRED_TABLE}" ` +
          `where retry_after_ms is null${afterClause} ` +
          `order by event_id asc limit ?`,
        args,
      )
      .map((row) => ({
        eventId: row.event_id,
        payloadJson: row.payload_json,
      }));
  };

  const listDueDeferredEvents = (
    nowMs: number,
    limit: number,
  ): Array<{
    eventId: string;
    payloadJson: string;
  }> => {
    if (!state.driver) return [];
    return state.driver
      .select<{ event_id: string; payload_json: string }>(
        `select event_id, payload_json from "${SYNC_DEFERRED_TABLE}" ` +
          `where retry_after_ms is not null and retry_after_ms <= ? ` +
          `order by retry_after_ms asc, event_id asc limit ?`,
        [nowMs, limit],
      )
      .map((row) => ({
        eventId: row.event_id,
        payloadJson: row.payload_json,
      }));
  };

  const dropDeferredEvent = (eventId: string): void => {
    state.driver?.exec(
      `delete from "${SYNC_DEFERRED_TABLE}" where event_id = ?`,
      [eventId],
    );
  };

  const wipeLocalData = () => {
    const { driver } = state;
    if (!driver) return;
    for (const table of Object.keys(schema)) {
      driver.exec(`delete from "${table}"`);
    }
    driver.exec(`delete from "${SYNC_OUTBOX_TABLE}"`);
    driver.exec(`delete from "${SYNC_OUTBOX_RELAY_TABLE}"`);
    driver.exec(`delete from "${SYNC_SEEN_TABLE}"`);
    driver.exec(`delete from "${SYNC_DEFERRED_TABLE}"`);
    driver.exec(`delete from "${SYNC_META_TABLE}"`);
    driver.exec(`delete from "${SYNC_LOG_TABLE}"`);
    driver.exec(`delete from "${SYNC_PURGE_TABLE}"`);
  };

  // Reclaim local space by hard-deleting old soft-deleted rows (tombstones).
  // Safe because: (1) only tombstones older than `olderThanMs` are touched, so
  // the deletion has had ample time to reach the relay and peers; (2) when
  // relays are configured, a tombstone whose delete event is still pending in
  // the outbox (not yet pushed) is kept, so an offline device can't forget a
  // delete it never sent. The relay retains the latest event per row
  // (compaction keeps tombstones), so a fresh re-sync re-applies the delete —
  // purging never resurrects data on a synced peer. Returns rows purged.
  //
  // Each hard delete also enqueues (table, id) in _sync_purge — atomically, in
  // the same transaction — so the sync loop can later ask every relay to drop
  // the row's stream (`POST /v1/streams/compact`). The queue must be written
  // here and not derived later: the streamId HMAC's input is (table, rowId),
  // which no longer exists anywhere once this delete commits.
  const hardDeleteRow = (table: string, id: string) => {
    const { driver } = state;
    if (!driver) return;
    driver.transaction(() => {
      driver.exec(`delete from "${table}" where id = ?`, [id]);
      driver.exec(
        `insert or ignore into "${SYNC_PURGE_TABLE}" (table_name, row_id) values (?, ?)`,
        [table, id],
      );
    });
  };

  const purgeDeleted = (olderThanMs: number, nowMs: number): number => {
    const { driver } = state;
    if (!driver) return 0;
    const cutoff = nowMs - olderThanMs;
    const requirePushed = state.transports.length > 0;
    let purged = 0;
    for (const table of Object.keys(schema)) {
      const rows = driver.select<{ id: string; updatedAt: string }>(
        `select id, updatedAt from "${table}" where isDeleted = 1`,
      );
      for (const row of rows) {
        const millis = hlcMillis(row.updatedAt);
        if (millis === null || millis > cutoff) continue; // too new / unparseable
        if (requirePushed) {
          const pending = driver.select(
            `select 1 from "${SYNC_OUTBOX_TABLE}" where event_id = ? and pushed_at is null limit 1`,
            [row.updatedAt],
          );
          if (pending.length > 0) continue; // delete not yet on the relay
        }
        hardDeleteRow(table, row.id);
        purged += 1;
      }
    }
    return purged;
  };

  // Immediate, user-initiated purge ("Delete Permanently" / "Empty Trash"):
  // hard-delete specific rows now, skipping the age window but keeping the two
  // non-negotiable guards — the row must already be a tombstone (never hard-
  // delete live data), and its delete event must have reached at least one
  // relay when relays are configured (otherwise an offline device would forget
  // a delete it never sent). Skipped rows stay in the trash; the caller can
  // report them ("will be removed after next sync"). Returns rows purged.
  const purgeRows = (
    rows: ReadonlyArray<{ table: string; id: string }>,
  ): number => {
    const { driver } = state;
    if (!driver) return 0;
    const requirePushed = state.transports.length > 0;
    let purged = 0;
    for (const target of rows) {
      if (!(target.table in schema)) continue; // unknown table — never raw-SQL it
      const row = driver.select<{ id: string; updatedAt: string }>(
        `select id, updatedAt from "${target.table}" where id = ? and isDeleted = 1`,
        [target.id],
      )[0];
      if (!row) continue; // absent or not a tombstone
      if (requirePushed) {
        const pending = driver.select(
          `select 1 from "${SYNC_OUTBOX_TABLE}" where event_id = ? and pushed_at is null limit 1`,
          [row.updatedAt],
        );
        if (pending.length > 0) continue; // delete not yet on the relay
      }
      hardDeleteRow(target.table, row.id);
      purged += 1;
    }
    return purged;
  };

  // --- Relay stream-purge queue (drained by relay.ts during sync) ------------

  const listPurgeQueue = (): Array<{
    table: string;
    rowId: string;
    ackedBases: string[];
  }> => {
    const { driver } = state;
    if (!driver) return [];
    return driver
      .select<{ table_name: string; row_id: string; acked_bases: string }>(
        `select table_name, row_id, acked_bases from "${SYNC_PURGE_TABLE}"`,
      )
      .map((row) => {
        let acked: string[] = [];
        try {
          const parsed = JSON.parse(row.acked_bases);
          if (Array.isArray(parsed)) acked = parsed.filter((b) => typeof b === "string");
        } catch {
          // Corrupt acked list reads as "no acks yet" — worst case a re-send,
          // and the endpoint is idempotent.
        }
        return { table: row.table_name, rowId: row.row_id, ackedBases: acked };
      });
  };

  const ackPurgeBase = (table: string, rowId: string, base: string) => {
    const { driver } = state;
    if (!driver) return;
    const row = driver.select<{ acked_bases: string }>(
      `select acked_bases from "${SYNC_PURGE_TABLE}" where table_name = ? and row_id = ?`,
      [table, rowId],
    )[0];
    if (!row) return;
    let acked: string[] = [];
    try {
      const parsed = JSON.parse(row.acked_bases);
      if (Array.isArray(parsed)) acked = parsed.filter((b) => typeof b === "string");
    } catch {
      /* treat as empty */
    }
    if (!acked.includes(base)) acked.push(base);
    driver.exec(
      `update "${SYNC_PURGE_TABLE}" set acked_bases = ? where table_name = ? and row_id = ?`,
      [JSON.stringify(acked), table, rowId],
    );
  };

  const dropPurgeEntry = (table: string, rowId: string) => {
    state.driver?.exec(
      `delete from "${SYNC_PURGE_TABLE}" where table_name = ? and row_id = ?`,
      [table, rowId],
    );
  };

  const markOutboxDelivered = (eventId: string, relay: string): void => {
    state.driver?.exec(
      `insert or ignore into "${SYNC_OUTBOX_RELAY_TABLE}" (event_id, relay) values (?, ?)`,
      [eventId, relay],
    );
  };

  // The Outbox's five states — pending, sealed, pushed, acknowledged per relay,
  // pruned — all live in this file. relay.ts supplies only the two things the
  // Store cannot: the AES-GCM seal (async, and it needs the owner's identity)
  // and the HTTP round trip. So the `envelope_json = ''` sentinel that divides
  // pending from sealed never has to be understood outside this file.

  /** Rows still holding the plaintext-pending marker, oldest event id first. */
  const listUnsealedOutbox = (): readonly {
    eventId: string;
    payloadJson: string;
  }[] => {
    const { driver } = state;
    if (!driver) return [];
    return driver
      .select<{ event_id: string; payload_json: string }>(
        `select event_id, payload_json from "${SYNC_OUTBOX_TABLE}" ` +
          `where envelope_json = '' and payload_json is not null ` +
          `order by event_id asc`,
      )
      .map((row) => ({ eventId: row.event_id, payloadJson: row.payload_json }));
  };

  // Idempotent via `and envelope_json = ''`: a row a concurrent pass already
  // sealed is skipped rather than re-encrypted under a second nonce.
  const sealOutboxEvent = (eventId: string, envelopeJson: string): void => {
    state.driver?.exec(
      `update "${SYNC_OUTBOX_TABLE}" set envelope_json = ? ` +
        `where event_id = ? and envelope_json = ''`,
      [envelopeJson, eventId],
    );
  };

  /**
   * The next push batch for one relay: sealed events that relay has not
   * acknowledged, oldest first, bounded by {@link OUTBOX_PUSH_BATCH}. A caller
   * handed a full batch must ask again — a full batch never means "drained".
   *
   * Selecting on the acknowledgement rows rather than a cursor is what lets a
   * lower-sorting cross-tab straggler still be delivered after the cursor moved
   * past it.
   */
  const claimPushBatch = (
    relay: string,
  ): readonly { eventId: string; envelopeJson: string }[] => {
    const { driver } = state;
    if (!driver) return [];
    return driver
      .select<{ event_id: string; envelope_json: string }>(
        `select outbox.event_id, outbox.envelope_json ` +
          `from "${SYNC_OUTBOX_TABLE}" as outbox ` +
          `where outbox.envelope_json != '' and not exists (` +
          `select 1 from "${SYNC_OUTBOX_RELAY_TABLE}" as delivery ` +
          `where delivery.event_id = outbox.event_id and delivery.relay = ?` +
          `) order by outbox.event_id asc limit ${OUTBOX_PUSH_BATCH}`,
        [relay],
      )
      .map((row) => ({
        eventId: row.event_id,
        envelopeJson: row.envelope_json,
      }));
  };

  /**
   * Record a whole batch as delivered to one relay, atomically: the per-relay
   * acknowledgements (the only delivery proof `pruneOutbox` trusts), the
   * `pushed_at` stamp, and that relay's push cursor.
   *
   * `pushed_at` means "reached at least one relay" — it drives the pending
   * count and the purge guard — so `coalesce` keeps the earliest and a re-push
   * to a second relay never resets it. The cursor advance is monotonic: a
   * straggler-only batch can end below the stored high-water mark.
   */
  const markBatchDelivered = (
    eventIds: readonly string[],
    relay: string,
    pushedAt: string,
  ): void => {
    const { driver } = state;
    if (!driver || eventIds.length === 0) return;
    driver.transaction(() => {
      for (const eventId of eventIds) {
        driver.exec(
          `update "${SYNC_OUTBOX_TABLE}" set pushed_at = coalesce(pushed_at, ?) where event_id = ?`,
          [pushedAt, eventId],
        );
        markOutboxDelivered(eventId, relay);
      }
      const last = eventIds[eventIds.length - 1]!;
      if (last > (pushCursor(relay) ?? "")) setMeta(pushCursorKey(relay), last);
    });
  };

  // Forget everything this device knows about one relay. Used when a relay has
  // lost its data (wiped volume, fresh deploy, restored from an older backup):
  // its event `seq` counter restarts, so a stale pull cursor matches nothing and
  // sync stalls silently and permanently. Clearing `cursor:` re-pulls from zero
  // (the seen-set dedupes), and clearing `push:`/`backfill:` re-arms
  // `backfillOutboxForNewRelay` so this device re-seeds the owner's rows. The
  // delivery rows must go too, or `pushOutbox` skips every event it already
  // acknowledged for that relay and the re-seed pushes nothing.
  const resetRelaySyncState = (base: string): void => {
    const { driver } = state;
    if (!driver) return;
    driver.transaction(() => {
      driver.exec(
        `delete from "${SYNC_OUTBOX_RELAY_TABLE}" where relay = ?`,
        [base],
      );
      const keys = relayStateKeys(base);
      driver.exec(
        `delete from "${SYNC_META_TABLE}" where key in (${keys.map(() => "?").join(", ")})`,
        keys,
      );
    });
  };

  // Bound the outbox (a send queue, not an archive): drop an event only after
  // every currently configured relay has an exact acknowledgement for it.
  // Push cursors remain useful high-water marks and new-relay markers, but are
  // not delivery proof: a lower-sorting cross-tab event can arrive after a
  // cursor advanced. A relay added after pruning is handled by the current-row
  // backfill below. Returns rows pruned.
  const pruneOutbox = (relayBases: readonly string[]): number => {
    const { driver } = state;
    if (!driver || relayBases.length === 0) return 0;
    const bases = [...new Set(relayBases)];
    const placeholders = bases.map(() => "?").join(", ");
    const deliveredToEveryRelay =
      `select outbox.event_id from "${SYNC_OUTBOX_TABLE}" as outbox ` +
      `where outbox.pushed_at is not null and (` +
      `select count(distinct delivery.relay) from "${SYNC_OUTBOX_RELAY_TABLE}" as delivery ` +
      `where delivery.event_id = outbox.event_id and delivery.relay in (${placeholders})` +
      `) = ?`;
    const params = [...bases, bases.length];
    const count =
      driver.select<{ c: number }>(
        `select count(*) as c from (${deliveredToEveryRelay}) as delivered`,
        params,
      )[0]?.c ?? 0;
    if (count > 0) {
      driver.transaction(() => {
        driver.exec(
          `delete from "${SYNC_OUTBOX_TABLE}" where event_id in (${deliveredToEveryRelay})`,
          params,
        );
        driver.exec(
          `delete from "${SYNC_OUTBOX_RELAY_TABLE}" where event_id not in (` +
            `select event_id from "${SYNC_OUTBOX_TABLE}")`,
        );
      });
    }
    return count;
  };

  // A relay added after older events were pruned still needs a complete copy of
  // the owner's current rows. Rebuild one canonical upsert per row from the
  // database once whenever that relay has not been initialized yet. Existing outbox rows
  // win via `insert or ignore`; rows learned from another device are included,
  // so a new redundant relay receives the whole owner state, not just this
  // device's recent edits. The separate marker matters when the database is
  // initially empty: a pull must not make the next sync echo every remotely
  // learned row back to the same relay just because no push cursor existed.
  const backfillOutboxForNewRelay = (base: string): number => {
    const { driver } = state;
    const marker = backfillMarkerKey(base);
    if (!driver || getMeta(marker) !== null) return 0;
    if (pushCursor(base) !== null) {
      setMeta(marker, "1");
      return 0;
    }
    const hasRows = Object.keys(schema).some(
      (table) => driver.select(`select 1 from "${table}" limit 1`).length > 0,
    );
    if (!hasRows) {
      setMeta(marker, "1");
      return 0;
    }
    let inserted = 0;
    driver.transaction(() => {
      for (const table of Object.keys(schema)) {
        const rows = driver.select<Record<string, unknown>>(
          `select * from "${table}"`,
        );
        for (const row of rows) {
          if (
            typeof row.id !== "string" ||
            typeof row.updatedAt !== "string" ||
            row.updatedAt.length === 0
          ) {
            continue;
          }
          const before = driver.select<{ c: number }>(
            `select count(*) as c from "${SYNC_OUTBOX_TABLE}" where event_id = ?`,
            [row.updatedAt],
          )[0]?.c ?? 0;
          insertPendingOutboxEvent(
            row.updatedAt,
            JSON.stringify({
              schemaVersion,
              table,
              op: "upsert",
              rowId: row.id,
              hlc: row.updatedAt,
              value: row,
            }),
          );
          if (before === 0) inserted += 1;
        }
      }
      setMeta(marker, "1");
    });
    return inserted;
  };

  // Insert the durable, plaintext-pending outbox marker for one replicated
  // event. Called from INSIDE the same `driver.transaction(...)` as the row
  // write it accompanies (see mutations-lifecycle.ts `mutate`/`batch`) so the
  // row and its marker commit — or roll back — together: if the process dies
  // before this line runs, the row write itself never committed either. No
  // encryption happens here (that's async; it would have to run outside any
  // transaction) — `envelope_json` starts '' and is filled in later by
  // `sealPendingOutbox` (relay.ts), before the event is ever pushed.
  const insertPendingOutboxEvent = (
    eventId: string,
    payloadJson: string,
  ): void => {
    const { driver } = state;
    if (!driver) return;
    driver.exec(
      `insert or ignore into "${SYNC_OUTBOX_TABLE}" (event_id, payload_json, envelope_json, pushed_at) values (?, ?, '', null)`,
      [eventId, payloadJson],
    );
  };

  const writeRow = (table: string, row: Record<string, unknown>): void => {
    const { driver } = state;
    if (!driver) return;
    const keys = Object.keys(row);
    const placeholders = keys.map(() => "?").join(", ");
    const updates = keys
      .filter((k) => k !== "id")
      .map((k) => `"${k}" = excluded."${k}"`)
      .join(", ");
    driver.exec(
      `insert into "${table}" (${keys
        .map((k) => `"${k}"`)
        .join(", ")}) values (${placeholders}) on conflict("id") do update set ${updates}`,
      keys.map((k) => row[k] as unknown),
    );
  };

  const coerceValues = (
    table: string,
    values: Record<string, unknown>,
  ): { row: Record<string, unknown>; error: string | null } => {
    const columns = schema[table];
    const row: Record<string, unknown> = {};
    for (const [name, type] of Object.entries(columns)) {
      if (!(name in values)) continue;
      const result = type.from(values[name]);
      if (!result.ok)
        return { row, error: `${table}.${name}: ${result.error.message}` };
      row[name] = result.value;
    }
    return { row, error: null };
  };

  // Columns every table carries besides the schema's typed columns (see the
  // DDL built in ensureSchema): `id` (primary key) plus `createdAt`,
  // `updatedAt`, `isDeleted` appended after the schema-defined columns. These
  // live outside `schema[table]`, so coerceValues alone would drop them.
  const SYSTEM_COLUMNS = ["id", "createdAt", "updatedAt", "isDeleted"] as const;

  const validateSystemColumn = (
    name: (typeof SYSTEM_COLUMNS)[number],
    value: unknown,
  ): string | null => {
    switch (name) {
      case "id":
        return typeof value === "string" && value.length > 0
          ? null
          : "Expected a non-empty id string.";
      case "createdAt":
        return typeof value === "string"
          ? null
          : "Expected a string.";
      case "updatedAt":
        return typeof value === "string" && parseHlc(value) !== null
          ? null
          : "Expected a valid SimplySync HLC.";
      case "isDeleted":
        return value === 0 || value === 1
          ? null
          : "Expected a SQLite boolean (0 or 1).";
    }
  };

  // Project an arbitrary row object — a decrypted remote payload's value, or a
  // row from an imported snapshot — onto exactly the columns *this* schema
  // knows: the system columns plus whatever coerceValues recognizes as a
  // typed business column. Any other key (e.g. a column a newer app version
  // added) is silently dropped instead of reaching writeRow, which would
  // otherwise throw "no column named …" and lose the whole row. This is what
  // keeps additive migrations wire-compatible on the *read* side, matching
  // the write side's coerceValues-based projection in mutate().
  const projectRow = (
    table: string,
    values: Record<string, unknown>,
  ): { row: Record<string, unknown>; error: string | null } => {
    const row: Record<string, unknown> = {};
    for (const [name, type] of Object.entries(schema[table])) {
      if (!(name in values)) continue;
      const value = values[name];
      const result = type.from(value);
      if (!result.ok) {
        // SQLite fills omitted columns with NULL. A later partial update reads
        // those NULLs back and includes the merged row in its sync payload,
        // even when the application's type for that column is non-null. NULL
        // therefore means "no value was ever supplied", not an invalid remote
        // mutation. Omitting it preserves the peer's value on conflict (and
        // lets SQLite use NULL for a new row) while still rejecting every
        // genuinely invalid non-null value.
        if (value === null) continue;
        return {
          row,
          error: `${table}.${name}: ${result.error.message}`,
        };
      }
      row[name] = result.value;
    }
    for (const name of SYSTEM_COLUMNS) {
      if (!(name in values)) continue;
      const value = values[name];
      const message = validateSystemColumn(name, value);
      if (message) return { row, error: `${table}.${name}: ${message}` };
      row[name] = value;
    }
    return { row, error: null };
  };

  // Apply one replicated payload under last-writer-wins: keep the local row
  // when its HLC is newer-or-equal, otherwise project the payload onto the
  // local schema (unknown columns from a newer app version are dropped, not
  // fatal — see projectRow) and write it. Shared by the relay pull path and
  // the cross-tab apply path so both merge identically. Returns true when the
  // row was written, false when the local copy wins.
  const applyLwwRow = (
    payload: SyncPayload<Record<string, unknown>, number>,
  ): boolean => {
    const { driver } = state;
    if (!driver) return false;
    const existing = driver.select<{ updatedAt: string }>(
      `select updatedAt from "${payload.table}" where id = ?`,
      [payload.rowId],
    )[0];
    if (existing && compareHlc(existing.updatedAt, payload.hlc) >= 0)
      return false;
    const { row: projected, error } = projectRow(payload.table, {
      ...payload.value,
      id: payload.rowId,
      // `hlc` is the canonical version on the wire. Native ports do not need
      // to duplicate it inside `value`, and update payloads may otherwise
      // carry the row's previous `updatedAt` (or NULL for a new row).
      updatedAt: payload.hlc,
    });
    if (error) throw new Error(error);
    writeRow(payload.table, projected);
    return true;
  };

  // A driver-agnostic full snapshot: every row of every schema table (including
  // soft-deleted rows + system columns) and the sync metadata worth preserving
  // across a device switch — the HLC high-water mark (so the clock can't
  // regress) and per-relay pull cursors. The recovery credential is supplied by
  // the caller (the store has no identity). Phrase-backed snapshots retain the
  // legacy `mnemonic` field so older engines can continue to import them.
  const exportSnapshot = (
    recoveryKey: string,
    mnemonic?: string,
  ): DbSnapshot => {
    const { driver } = state;
    const tables: Record<string, Record<string, unknown>[]> = {};
    const meta: Record<string, string> = {};
    if (driver) {
      for (const table of Object.keys(schema)) {
        tables[table] = driver.select<Record<string, unknown>>(
          `select * from "${table}"`,
        );
      }
      const metaRows = driver.select<{ key: string; value: string }>(
        `select key, value from "${SYNC_META_TABLE}"`,
      );
      for (const { key, value } of metaRows) meta[key] = value;
    }
    return {
      format: "simplysync-db-snapshot",
      version: 1,
      exportedAt: new Date().toISOString(),
      recoveryKey,
      ...(mnemonic ? { mnemonic } : {}),
      tables,
      meta,
    };
  };

  // Validate the complete runtime shape and every row before restore changes
  // secure storage or starts the database replacement. importSnapshot is
  // transactional, but the owner credential lives outside SQLite; a separate
  // preflight keeps a malformed backup from changing either one.
  const validateSnapshot = (snapshot: DbSnapshot): void => {
    if (
      !snapshot.tables
      || typeof snapshot.tables !== "object"
      || Array.isArray(snapshot.tables)
      || !snapshot.meta
      || typeof snapshot.meta !== "object"
      || Array.isArray(snapshot.meta)
    ) {
      throw new Error("Backup contains malformed tables or metadata.");
    }
    for (const [key, value] of Object.entries(snapshot.meta)) {
      if (typeof value !== "string") {
        throw new Error(`Backup metadata ${key} must be a string.`);
      }
    }
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      if (!Array.isArray(rows)) {
        throw new Error(`Backup table ${table} must contain an array of rows.`);
      }
      const seenIds = new Set<string>();
      for (const value of rows) {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(`Backup table ${table} contains a malformed row.`);
        }
        if (!schema[table]) continue; // a newer schema's row stays opaque
        const { row, error } = projectRow(table, value);
        if (error) throw new Error(error);
        for (const name of SYSTEM_COLUMNS) {
          if (!(name in row)) {
            throw new Error(`Backup row ${table} is missing ${name}.`);
          }
        }
        const id = row.id as string;
        if (seenIds.has(id)) {
          throw new Error(`Backup table ${table} contains duplicate id ${id}.`);
        }
        seenIds.add(id);
      }
    }
  };

  // Replace all local data with a snapshot. Atomic: wipe, re-write every row
  // verbatim (preserving each row's `updatedAt` HLC so LWW stays correct) and
  // restore the sync metadata. Identity is handled by the caller.
  const importSnapshot = (snapshot: DbSnapshot): void => {
    const { driver } = state;
    if (!driver) return;
    validateSnapshot(snapshot);
    driver.transaction(() => {
      wipeLocalData();
      for (const [table, rows] of Object.entries(snapshot.tables)) {
        if (!schema[table]) continue; // ignore tables not in the current schema
        for (const row of rows) {
          // A snapshot exported by a newer app version can carry a column
          // this schema doesn't have yet (same additive-migration exposure
          // as applyRemoteRow in relay.ts) — project it away instead of
          // letting one row's unknown column roll back the whole restore.
          const { row: projected, error } = projectRow(table, row);
          if (error) throw new Error(`${table}: ${error}`);
          writeRow(table, projected);
        }
      }
      for (const [key, value] of Object.entries(snapshot.meta)) {
        setMeta(key, value);
      }
    });
  };

  return {
    ensureSchema,
    pullCursor,
    setPullCursor,
    pushCursor,
    clockHighWaterMark,
    setClockHighWaterMark,
    hasSeenEvent,
    markEventSeen,
    pruneSeen,
    hasRelayHistory,
    deferRemoteEvent,
    listOpaqueDeferredEvents,
    listDueDeferredEvents,
    dropDeferredEvent,
    wipeLocalData,
    purgeDeleted,
    purgeRows,
    listPurgeQueue,
    ackPurgeBase,
    dropPurgeEntry,
    markOutboxDelivered,
    listUnsealedOutbox,
    sealOutboxEvent,
    claimPushBatch,
    markBatchDelivered,
    resetRelaySyncState,
    pruneOutbox,
    backfillOutboxForNewRelay,
    insertPendingOutboxEvent,
    writeRow,
    coerceValues,
    applyLwwRow,
    exportSnapshot,
    validateSnapshot,
    importSnapshot,
    appendSyncLog,
    recentSyncLog,
    pendingOutboxCount,
  };
}

export type Clock = ReturnType<typeof createClock>;

/**
 * The hybrid logical clock. Persists its high-water mark to `_sync_meta` so the
 * clock stays monotonic across restarts (a backward wall clock or a restart that
 * reset `hlcTime` to 0 could otherwise mint HLCs that sort below existing rows —
 * LWW would then discard the newer edit).
 *
 * `observeHlc` is the HLC "receive" step: it absorbs the physical time of every
 * remote HLC we pull so a later local write can never mint an HLC that sorts
 * below an edit we've already seen (e.g. one stamped by a device whose wall
 * clock runs ahead). Without it that edit would silently lose the LWW compare.
 * The Swift engine does the same on its apply path so the two stay convergent.
 *
 * Two guards keep a single bad device from poisoning the whole fleet (plan 010):
 *  - `MAX_DRIFT_MS` bounds how far `observeHlc` will raise the high-water mark
 *    for a *remote* time. All of an owner's events come from that owner's own
 *    devices, so without a bound one device with a far-future wall clock would
 *    mint far-future HLCs that every peer absorbs on pull, permanently
 *    detaching the fleet from wall-clock time. 5 minutes is a generous bound on
 *    real clock skew (NTP-class drift is seconds, not minutes) while still
 *    rejecting "clock reset to year 2099" style corruption. Times beyond the
 *    bound are ignored — same defensive posture as a malformed HLC.
 *  - `HLC_COUNTER_MAX` guards the counter that `nextHlc` increments on repeat
 *    writes within the same millisecond. `createHlc` encodes the counter in a
 *    fixed 4-digit base-36 field (`packages/simplysync-protocol/src/index.ts`);
 *    widening it would change every stored HLC's string length and break the
 *    fixed-width lexical ordering the whole system relies on. Instead, once the
 *    counter would overflow the field, logical time rolls forward by 1ms and
 *    the counter resets to 0 — standard HLC "counter rollover advances logical
 *    time" behavior. This can put `hlcTime` slightly ahead of the wall clock
 *    under sustained high-frequency writes; that's expected and self-correcting
 *    (the next `nextHlc` call folds the wall clock back in via `Math.max`).
 */
const HLC_COUNTER_MAX = 36 ** 4 - 1; // createHlc pads the counter to 4 base-36 digits

/**
 * The clock needs somewhere durable to keep its high-water mark, and nothing
 * else the Store offers. Naming that as its own parameter type keeps the
 * dependency honest — and lets a test hand the clock two functions instead of
 * casting a stub through `as unknown as Store`.
 */
export type ClockHighWaterMarkStore = Pick<
  Store,
  "clockHighWaterMark" | "setClockHighWaterMark"
>;

export function createClock(
  state: EngineState,
  store: ClockHighWaterMarkStore,
) {
  const persist = (): void => {
    store.setClockHighWaterMark(state.hlcTime, state.hlcCounter);
  };

  const nextHlc = (): string => {
    const now = Date.now();
    let nextTime = Math.max(now, state.hlcTime);
    let nextCounter = nextTime === state.hlcTime ? state.hlcCounter + 1 : 0;
    if (nextCounter > HLC_COUNTER_MAX) {
      // Counter rollover: the 4-digit base-36 field can't hold this value.
      // Advance logical time by 1ms and reset the counter rather than widening
      // the field (see the class doc above).
      nextTime += 1;
      nextCounter = 0;
    }
    state.hlcCounter = nextCounter;
    state.hlcTime = nextTime;
    persist();
    return createHlc(state.deviceId || "local", nextTime, nextCounter);
  };

  const observeHlc = (remote: string): boolean => {
    if (getHlcAdmissibility(remote) !== "admissible") return false;
    const parsed = parseHlc(remote);
    if (!parsed) return false;
    const { millis, counter: c } = parsed;
    // Raise the high-water mark; nextHlc() folds in the wall clock via Math.max,
    // so it's enough to ensure (hlcTime, hlcCounter) is >= the observed value.
    if (millis > state.hlcTime) {
      state.hlcTime = millis;
      state.hlcCounter = c;
    } else if (millis === state.hlcTime && c > state.hlcCounter) {
      state.hlcCounter = c;
    } else {
      return true; // already at or above the observed time — still acceptable
    }
    persist();
    return true;
  };

  return { nextHlc, observeHlc };
}
