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
  SYNC_SEEN_TABLE,
} from "./constants";
import type { SyncFailureKind, SyncLogEntry } from "../engine-types";
import type { EngineState } from "./state";

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
      for (const [name, type] of Object.entries(columns)) {
        if (name === "id") continue;
        defs.push(`"${name}" ${type.sqlite}`);
      }
      defs.push('"createdAt" text');
      defs.push('"updatedAt" text');
      defs.push('"isDeleted" integer default 0');
      driver.exec(
        `create table if not exists "${table}" (${defs.join(", ")});`,
      );
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
    driver.exec(
      `create table if not exists "${SYNC_OUTBOX_TABLE}" (event_id text primary key, envelope_json text not null, pushed_at text);`,
    );
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
        for (const row of rows) writeRow(table, row);
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
    writeRow,
    coerceValues,
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
 */
export function createClock(state: EngineState, store: Store) {
  const persist = (): void => {
    store.setMeta("hlc:time", String(state.hlcTime));
    store.setMeta("hlc:counter", String(state.hlcCounter));
  };

  const nextHlc = (): string => {
    const now = Date.now();
    const nextTime = Math.max(now, state.hlcTime);
    state.hlcCounter = nextTime === state.hlcTime ? state.hlcCounter + 1 : 0;
    state.hlcTime = nextTime;
    persist();
    return createHlc(state.deviceId || "local", nextTime, state.hlcCounter);
  };

  const observeHlc = (remote: string): void => {
    // A well-formed HLC is `<10-char base36 millis>-<base36 counter>-<deviceId>`.
    // Parse defensively: anything malformed is ignored rather than risk poisoning
    // the clock with a garbage time it could never recover from.
    const parts = remote.split("-");
    if (parts.length < 3 || parts[0]!.length !== 10) return;
    const millis = Number.parseInt(parts[0]!, 36);
    if (!Number.isFinite(millis)) return;
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
