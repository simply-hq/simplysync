import { createHlc } from "@simplysync/protocol";
import type {
  DbSnapshot,
  IndexCreate,
  SchemaDefinition,
  SyncEngineConfig,
} from "../engine-types";
import {
  LEGACY_IMPORT_VERSION,
  SYNC_LOG_CAP,
  SYNC_LOG_TABLE,
  SYNC_META_TABLE,
  SYNC_OUTBOX_TABLE,
  SYNC_PURGE_TABLE,
  SYNC_SEEN_TABLE,
} from "./constants";
import type { SyncFailureKind, SyncLogEntry } from "../engine-types";
import type { EngineState } from "./state";

// Extract the wall-clock millis encoded in an HLC's first segment
// (`base36(millis,10)-base36(counter,4)-deviceId`). Returns null if malformed.
function hlcMillis(hlc: string): number | null {
  const first = hlc.split("-")[0];
  if (!first || first.length !== 10) return null;
  const millis = Number.parseInt(first, 36);
  return Number.isFinite(millis) ? millis : null;
}

function makeIndexCreate(name: string): IndexCreate {
  const spec = { name, table: "", columns: [] as string[] };
  const api: IndexCreate = {
    __spec: spec,
    on(table) {
      spec.table = table;
      return api;
    },
    column(column) {
      spec.columns.push(column);
      return api;
    },
  };
  return api;
}

export type Store = ReturnType<typeof createStore>;

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
) {
  const ensureSchema = () => {
    const { driver } = state;
    if (!driver) return;
    driver.exec("pragma journal_mode = WAL;");
    for (const [table, columns] of Object.entries(schema)) {
      const defs: string[] = ['"id" text primary key'];
      const columnTypes: Array<[string, string]> = [];
      for (const [name, type] of Object.entries(columns)) {
        if (name === "id") continue;
        defs.push(`"${name}" ${type.sqlite}`);
        columnTypes.push([name, type.sqlite]);
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
      for (const [name, sqlite] of columnTypes) {
        if (!present.has(name)) {
          driver.exec(`alter table "${table}" add column "${name}" ${sqlite};`);
        }
      }
    }
    if (config.indexes) {
      for (const index of config.indexes(makeIndexCreate)) {
        const { name, table, columns } = index.__spec;
        if (!table || columns.length === 0) continue;
        driver.exec(
          `create index if not exists "${name}" on "${table}" (${columns
            .map((c) => `"${c}"`)
            .join(", ")});`,
        );
      }
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
    driver.exec(
      `create table if not exists "${SYNC_SEEN_TABLE}" (event_id text primary key);`,
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

  const wipeLocalData = () => {
    const { driver } = state;
    if (!driver) return;
    for (const table of Object.keys(schema)) {
      driver.exec(`delete from "${table}"`);
    }
    driver.exec(`delete from "${SYNC_OUTBOX_TABLE}"`);
    driver.exec(`delete from "${SYNC_SEEN_TABLE}"`);
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

  // Bound the outbox (a send queue, not an archive): drop events confirmed
  // delivered to EVERY current relay. The lowest per-relay push cursor
  // (`push:<base>` in meta) is the highest event id every relay has acked;
  // events at or below it are fully delivered and safe to forget. A relay with
  // no cursor yet (just added, never pushed) makes the minimum "" so nothing is
  // pruned — it still needs the backlog. (Pruning a pushed row is safe for the
  // purge guard, which treats an absent outbox row as "already pushed", and for
  // the pending count, which only counts un-pushed rows.) Returns rows pruned.
  const pruneOutbox = (relayBases: readonly string[]): number => {
    const { driver } = state;
    if (!driver || relayBases.length === 0) return 0;
    let min: string | null = null;
    for (const base of relayBases) {
      const cursor = getMeta(`push:${base}`) ?? "";
      if (min === null || cursor < min) min = cursor;
    }
    if (!min) return 0; // a relay hasn't been pushed to yet -> keep everything
    const count =
      driver.select<{ c: number }>(
        `select count(*) as c from "${SYNC_OUTBOX_TABLE}" where event_id <= ?`,
        [min],
      )[0]?.c ?? 0;
    if (count > 0) {
      driver.exec(`delete from "${SYNC_OUTBOX_TABLE}" where event_id <= ?`, [
        min,
      ]);
    }
    return count;
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
    const { row, error } = coerceValues(table, values);
    if (error) return { row, error };
    for (const name of SYSTEM_COLUMNS) {
      if (name in values) row[name] = values[name];
    }
    return { row, error: null };
  };

  // A driver-agnostic full snapshot: every row of every schema table (including
  // soft-deleted rows + system columns) and the sync metadata worth preserving
  // across a device switch — the HLC high-water mark (so the clock can't
  // regress) and per-relay pull cursors. The recovery phrase is supplied by the
  // caller (the store has no identity).
  const exportSnapshot = (mnemonic: string): DbSnapshot => {
    const { driver } = state;
    const tables: Record<string, Record<string, unknown>[]> = {};
    const meta: Record<string, string> = {};
    if (driver) {
      for (const table of Object.keys(schema)) {
        tables[table] = driver.select<Record<string, unknown>>(
          `select * from "${table}"`,
        );
      }
      // Everything except the legacy-import marker, which is owned by the
      // restore flow (see importSnapshot) — not carried from the source device.
      const metaRows = driver.select<{ key: string; value: string }>(
        `select key, value from "${SYNC_META_TABLE}" where key != ?`,
        ["legacyImported"],
      );
      for (const { key, value } of metaRows) meta[key] = value;
    }
    return {
      format: "simplysync-db-snapshot",
      version: 1,
      exportedAt: new Date().toISOString(),
      mnemonic,
      tables,
      meta,
    };
  };

  // Replace all local data with a snapshot. Atomic: wipe, re-write every row
  // verbatim (preserving each row's `updatedAt` HLC so LWW stays correct),
  // restore the sync metadata, and re-assert the legacy-import marker so the
  // one-time importer doesn't resurrect a wiped legacy db on the next boot
  // (mirrors switchOwner). Identity is handled by the caller.
  const importSnapshot = (snapshot: DbSnapshot): void => {
    const { driver } = state;
    if (!driver) return;
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
      setMeta("legacyImported", String(LEGACY_IMPORT_VERSION));
    });
  };

  return {
    ensureSchema,
    getMeta,
    setMeta,
    wipeLocalData,
    purgeDeleted,
    purgeRows,
    listPurgeQueue,
    ackPurgeBase,
    dropPurgeEntry,
    pruneOutbox,
    insertPendingOutboxEvent,
    writeRow,
    coerceValues,
    projectRow,
    exportSnapshot,
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
const MAX_DRIFT_MS = 5 * 60_000;
const HLC_COUNTER_MAX = 36 ** 4 - 1; // createHlc pads the counter to 4 base-36 digits

export function createClock(state: EngineState, store: Store) {
  const persist = (): void => {
    store.setMeta("hlc:time", String(state.hlcTime));
    store.setMeta("hlc:counter", String(state.hlcCounter));
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

  const observeHlc = (remote: string): void => {
    // A well-formed HLC is `<10-char base36 millis>-<base36 counter>-<deviceId>`.
    // Parse defensively: anything malformed is ignored rather than risk poisoning
    // the clock with a garbage time it could never recover from.
    const parts = remote.split("-");
    if (parts.length < 3 || parts[0]!.length !== 10) return;
    const millis = Number.parseInt(parts[0]!, 36);
    if (!Number.isFinite(millis)) return;
    // Absurd future drift is treated like a malformed value (see class doc).
    if (millis > Date.now() + MAX_DRIFT_MS) return;
    const counter = Number.parseInt(parts[1] ?? "", 36);
    const c = Number.isFinite(counter) ? counter : 0;
    // Raise the high-water mark; nextHlc() folds in the wall clock via Math.max,
    // so it's enough to ensure (hlcTime, hlcCounter) is >= the observed value.
    if (millis > state.hlcTime) {
      state.hlcTime = millis;
      state.hlcCounter = c;
    } else if (millis === state.hlcTime && c > state.hlcCounter) {
      state.hlcCounter = c;
    } else {
      return; // already at or above the observed time — nothing to absorb
    }
    persist();
  };

  return { nextHlc, observeHlc };
}
