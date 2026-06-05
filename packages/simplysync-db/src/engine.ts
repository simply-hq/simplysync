import {
  Kysely,
  DummyDriver,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
} from "kysely";
import {
  base64UrlEncode,
  compareHlc,
  createHlc,
  createMnemonic,
  decryptEnvelope,
  deriveIdentity,
  encryptPayload,
  isRecoveryMnemonic,
  normalizeMnemonic,
  type LocalFirstIdentity,
  type SyncEnvelope,
  type SyncPayload,
} from "@simplysync/core";
import {
  sqliteFalse,
  type Id,
  type SqliteBoolean,
  type Type,
} from "./type";

// ---------------------------------------------------------------------------
// Schema typing — derive the Kysely Database type (and insert/update shapes)
// from a plain `{ table: { column: Type } }` schema, adding the system columns
// every row carries (id is declared per table; isDeleted/createdAt/updatedAt
// are implicit, by default).
// ---------------------------------------------------------------------------

export type ColumnTypes = Record<string, Type<unknown>>;
export type SchemaDefinition = Record<string, ColumnTypes>;

type DecodedOf<T> = T extends Type<infer U> ? U : never;

export interface SystemColumns {
  readonly isDeleted: SqliteBoolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DecodedRow<Table extends ColumnTypes> = {
  [K in keyof Table]: DecodedOf<Table[K]>;
};

export type Row<Table extends ColumnTypes> = DecodedRow<Table> & SystemColumns;

export type Database<S extends SchemaDefinition> = {
  [T in keyof S]: Row<S[T]>;
};

/** Optional system-column overrides accepted by mutations. */
export interface SystemColumnOverrides {
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly isDeleted?: SqliteBoolean;
}

// All columns optional on insert (partial inserts are allowed; the engine
// fills id + system columns and leaves omitted columns NULL).
export type InsertValues<
  Table extends ColumnTypes,
  R = DecodedRow<Table>,
> = Partial<R> & SystemColumnOverrides;

export type UpdateValues<
  Table extends ColumnTypes,
  R = DecodedRow<Table>,
> = Partial<R> &
  SystemColumnOverrides & {
    id: R extends { id: infer I } ? I : Id;
  };

export interface Query<Row = unknown> {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  /** Phantom carrier for the row type — never read at runtime. */
  readonly Row: Row;
}

/** Extracts the row type from a query (the `typeof query.Row` idiom). */
export type QueryRow<Q> = Q extends Query<infer R> ? R : never;

export type MutationResult =
  | { readonly ok: true; readonly value: { readonly id: Id } }
  | { readonly ok: false; readonly error: { readonly message: string } };

// ---------------------------------------------------------------------------
// Platform plumbing injected by each app (expo-sqlite / wa-sqlite, secure
// storage for the recovery phrase).
// ---------------------------------------------------------------------------

export interface SqliteDriver {
  exec(sql: string, params?: readonly unknown[]): void;
  select<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): R[];
  transaction<T>(fn: () => T): T;
}

export interface SecureStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}

export interface SyncEngineDeps {
  readonly createSqliteDriver: (
    name: string,
  ) => SqliteDriver | Promise<SqliteDriver>;
  readonly secureStorage: SecureStorage;
  readonly fetch?: typeof fetch;
  /**
   * Platform reload used after restore/reset to re-evaluate app state. On web
   * the engine falls back to `location.reload()`; React Native must provide one
   * (e.g. expo-updates `reloadAsync`) since there's no `location`.
   */
  readonly reloadApp?: () => void | Promise<void>;
}

export interface Transport {
  readonly type: "WebSocket" | "Http";
  readonly url: string;
}

export interface IndexCreate {
  on(table: string): IndexCreate;
  column(column: string): IndexCreate;
  readonly __spec: { name: string; table: string; columns: string[] };
}

export type IndexBuilder = (
  create: (name: string) => IndexCreate,
) => IndexCreate[];

export interface AppOwner {
  readonly id: string;
  readonly mnemonic: string;
  /** Bearer token presented to relays (the write key). */
  readonly writeKey: string;
}

export interface MutationOptions {
  readonly onComplete?: () => void;
}

export interface SyncEngineConfig {
  readonly name: string;
  readonly indexes?: IndexBuilder;
  readonly transports?: readonly Transport[];
  readonly externalAppOwner?: AppOwner | null;
  readonly encryptionKey?: unknown;
  /** Poll interval (ms) for pulling remote changes. Default 5000. */
  readonly syncIntervalMs?: number;
}

export type SyncState =
  | { readonly type: "SyncStateInitial" }
  | { readonly type: "SyncStateIsSyncing" }
  | { readonly type: "SyncStateIsSynced"; readonly lastSyncedAt: string }
  | {
      readonly type: "SyncStateIsNotSynced";
      readonly error?: string;
      // Set for non-retryable failures (auth/quota/bad-request). The UI should
      // show these; the engine backs the poller off so it doesn't hammer.
      readonly terminal?: boolean;
      readonly status?: number;
    };

export interface SyncError {
  readonly type: string;
  readonly message: string;
}

export interface SyncEngine<S extends SchemaDefinition> {
  createQuery<O>(fn: (db: Kysely<Database<S>>) => Compilable<O>): Query<O>;
  loadQuery<R>(query: Query<R>): Promise<readonly R[]>;
  getQueryRows<R>(query: Query<R>): readonly R[];
  subscribeQuery(query: Query): (listener: () => void) => () => void;
  insert<T extends keyof S & string>(
    table: T,
    values: InsertValues<S[T]>,
    options?: MutationOptions,
  ): MutationResult;
  update<T extends keyof S & string>(
    table: T,
    values: UpdateValues<S[T]>,
    options?: MutationOptions,
  ): MutationResult;
  upsert<T extends keyof S & string>(
    table: T,
    values: InsertValues<S[T]> & UpdateValues<S[T]>,
    options?: MutationOptions,
  ): MutationResult;
  readonly appOwner: Promise<AppOwner | null>;
  useOwner(options: { transports?: readonly Transport[] }): () => void;
  /**
   * One-time best-effort import of rows from a legacy SQLite database
   * with the same per-table layout. Safe to call always: it no-ops if the
   * legacy db is missing/incompatible or already imported. Imported rows are
   * re-emitted as sync events so they propagate to the new relay.
   */
  importLegacy(
    legacyDbName: string,
  ): Promise<{ imported: number; skipped: number }>;
  /**
   * Restore an owner from its recovery phrase. By default this refuses to wipe
   * local data unless the relay confirms the owner has data (so a wrong phrase
   * or an unreachable relay can't destroy the current data). Pass
   * `{ force: true }` to switch to an empty/new owner intentionally.
   */
  restoreAppOwner(
    mnemonic: string,
    options?: { force?: boolean },
  ): Promise<void>;
  resetAppOwner(): Promise<void>;
  subscribeError(listener: () => void): () => void;
  getError(): SyncError | null;
  subscribeSyncState(listener: () => void): () => void;
  getSyncState(): SyncState;
  setTransports(transports: readonly Transport[]): void;
  sync(): Promise<void>;
  reloadApp(): void;
  readonly ready: Promise<void>;
}

const SYNC_OUTBOX_TABLE = "_sync_outbox";
const SYNC_META_TABLE = "_sync_meta";
const SYNC_SEEN_TABLE = "_sync_seen";

function createId(): Id {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes) as Id;
}

/**
 * Deterministic id from a string (sync), the `createIdFromString` idiom
 * so callers like `seedDefaultCategories` can upsert by a stable id. Uses a sync
 * 128-bit hash so it runs without WebCrypto on the JS thread.
 */
export function createIdFromString<_B extends string = never>(
  value: string,
): Id {
  let h1 = 0x9e3779b1 ^ value.length;
  let h2 = 0x85ebca77 ^ value.length;
  let h3 = 0xc2b2ae3d;
  let h4 = 0x27d4eb2f;
  for (let i = 0; i < value.length; i += 1) {
    const k = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ k, 2654435761);
    h2 = Math.imul(h2 ^ k, 1597334677);
    h3 = Math.imul(h3 ^ k, 2246822519);
    h4 = Math.imul(h4 ^ k, 3266489917);
  }
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, h1 >>> 0);
  view.setUint32(4, h2 >>> 0);
  view.setUint32(8, h3 >>> 0);
  view.setUint32(12, h4 >>> 0);
  return base64UrlEncode(bytes) as Id;
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

/** Builds a compile-only Kysely instance (SQLite dialect, no real driver). */
function createCompiler<S extends SchemaDefinition>(): Kysely<Database<S>> {
  return new Kysely<Database<S>>({
    dialect: {
      createAdapter: () => new SqliteAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new SqliteIntrospector(db),
      createQueryCompiler: () => new SqliteQueryCompiler(),
    },
  });
}

export const createSync =
  (deps: SyncEngineDeps) =>
  <S extends SchemaDefinition>(
    schema: S,
    config: SyncEngineConfig,
  ): SyncEngine<S> => {
    const compiler = createCompiler<S>();
    const fetchImpl = deps.fetch ?? globalThis.fetch;

    let driver: SqliteDriver | null = null;
    let identity: LocalFirstIdentity | null = null;
    let appOwnerValue: AppOwner | null = null;
    // Cached so `engine.appOwner` returns a STABLE promise reference — required
    // by React's `use(engine.appOwner)` (a fresh promise each access makes `use`
    // suspend forever). Reset when the owner changes (restore/reset).
    let appOwnerPromise: Promise<AppOwner | null> | null = null;
    let deviceId = "";
    let hlcCounter = 0;
    let hlcTime = 0;
    let error: SyncError | null = null;
    let syncState: SyncState = { type: "SyncStateInitial" };
    let transports: Transport[] = [...(config.transports ?? [])];
    let syncing = false;
    let syncTimer: number | null = null;
    let schemaReady = false;
    let reportedQueryError = false;

    const errorListeners = new Set<() => void>();
    const syncListeners = new Set<() => void>();
    // queryKey -> { sql, params, tables, rows, listeners }
    const queries = new Map<
      string,
      {
        sql: string;
        params: readonly unknown[];
        tables: Set<string>;
        rows: readonly unknown[];
        listeners: Set<() => void>;
      }
    >();

    const mnemonicKey = `${config.name}:mnemonic`;
    const deviceKey = `${config.name}:deviceId`;
    // Bumped when the legacy importer changes. Stored in _sync_meta as
    // "legacyImported". After an explicit erase/restore we set it so the
    // one-time legacy import does NOT resurrect the wiped data on the next boot.
    const LEGACY_IMPORT_VERSION = 3;

    const setError = (next: SyncError | null) => {
      error = next;
      errorListeners.forEach((l) => l());
    };
    const setSyncState = (next: SyncState) => {
      syncState = next;
      syncListeners.forEach((l) => l());
    };

    const nextHlc = (): string => {
      const now = Date.now();
      const nextTime = Math.max(now, hlcTime);
      hlcCounter = nextTime === hlcTime ? hlcCounter + 1 : 0;
      hlcTime = nextTime;
      // Persist so the clock is monotonic across restarts. Without this, a
      // restart (or a wall clock that moves backwards) resets hlcTime to 0 and
      // can produce HLCs that sort below existing rows — LWW then discards the
      // newer edit, or two events collide on eventId and one is dropped.
      setMeta("hlc:time", String(hlcTime));
      setMeta("hlc:counter", String(hlcCounter));
      return createHlc(deviceId || "local", nextTime, hlcCounter);
    };

    const tablesInSql = (sql: string): Set<string> => {
      const found = new Set<string>();
      for (const table of Object.keys(schema)) {
        if (sql.includes(`"${table}"`)) found.add(table);
      }
      return found;
    };

    const queryKey = (query: Query): string =>
      `${query.sql}::${JSON.stringify(query.parameters)}`;

    const runQuery = (sql: string, params: readonly unknown[]): unknown[] => {
      if (!driver) return [];
      try {
        return driver.select(sql, params);
      } catch (caught) {
        // Before the schema exists, tables may be missing — treat as empty.
        // After init, a failure here is a real DB error (corruption, disk full,
        // bad SQL): surface it instead of masquerading as "no data" (which would
        // render a permanently blank screen with no signal).
        if (schemaReady) {
          console.error("local-first query failed:", sql, caught);
          if (!reportedQueryError) {
            reportedQueryError = true;
            setError({
              type: "QueryError",
              message:
                caught instanceof Error ? caught.message : String(caught),
            });
          }
        }
        return [];
      }
    };

    const refreshQueries = (changedTables: Iterable<string>) => {
      const changed = new Set(changedTables);
      for (const entry of queries.values()) {
        let touched = false;
        for (const table of entry.tables) {
          if (changed.has(table)) {
            touched = true;
            break;
          }
        }
        if (!touched) continue;
        entry.rows = runQuery(entry.sql, entry.params);
        entry.listeners.forEach((l) => l());
      }
    };

    const ensureSchema = () => {
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
    };

    const getMeta = (key: string): string | null => {
      if (!driver) return null;
      const rows = driver.select<{ value: string }>(
        `select value from "${SYNC_META_TABLE}" where key = ?`,
        [key],
      );
      return rows[0]?.value ?? null;
    };
    const setMeta = (key: string, value: string) => {
      driver?.exec(
        `insert into "${SYNC_META_TABLE}" (key, value) values (?, ?) on conflict(key) do update set value = excluded.value`,
        [key, value],
      );
    };

    const wipeLocalData = () => {
      if (!driver) return;
      for (const table of Object.keys(schema)) {
        driver.exec(`delete from "${table}"`);
      }
      driver.exec(`delete from "${SYNC_OUTBOX_TABLE}"`);
      driver.exec(`delete from "${SYNC_SEEN_TABLE}"`);
      driver.exec(`delete from "${SYNC_META_TABLE}"`);
    };

    const writeRow = (
      table: string,
      row: Record<string, unknown>,
    ): void => {
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

    const enqueue = async (
      table: string,
      op: SyncPayload["op"],
      rowId: string,
      hlc: string,
      value: unknown,
    ): Promise<void> => {
      if (!identity || !driver) return;
      const envelope = await encryptPayload(
        identity,
        { eventId: hlc, deviceId },
        { schemaVersion: 1, table, op, rowId, hlc, value },
      );
      driver.exec(
        `insert or ignore into "${SYNC_OUTBOX_TABLE}" (event_id, envelope_json) values (?, ?)`,
        [hlc, JSON.stringify(envelope)],
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

    const mutate = (
      table: string,
      values: Record<string, unknown>,
      mode: "insert" | "update" | "upsert",
      options?: MutationOptions,
    ): MutationResult => {
      if (!driver) return { ok: false, error: { message: "Database not ready." } };
      if (!(table in schema))
        return { ok: false, error: { message: `Unknown table: ${table}` } };

      const id = (values.id as Id | undefined) ?? createId();
      const existing =
        mode === "insert"
          ? null
          : driver.select<Record<string, unknown>>(
              `select * from "${table}" where id = ?`,
              [id],
            )[0] ?? null;

      if (mode === "update" && !existing)
        return { ok: false, error: { message: `Row not found: ${id}` } };

      const { row, error: coerceError } = coerceValues(table, {
        ...values,
        id,
      });
      if (coerceError) return { ok: false, error: { message: coerceError } };

      if ("isDeleted" in values) row.isDeleted = values.isDeleted;

      const hlc = nextHlc();
      const providedCreatedAt =
        typeof values.createdAt === "string" ? values.createdAt : undefined;
      const merged: Record<string, unknown> = {
        ...(existing ?? {}),
        ...row,
        id,
        updatedAt: hlc,
        // Keep the existing createdAt on update; allow callers (demo data,
        // legacy import) to backfill a date-appropriate createdAt on insert;
        // otherwise stamp now.
        createdAt:
          (existing?.createdAt as string | undefined) ??
          providedCreatedAt ??
          new Date().toISOString(),
        isDeleted:
          (row.isDeleted as SqliteBoolean | undefined) ??
          (existing?.isDeleted as SqliteBoolean | undefined) ??
          sqliteFalse,
      };

      try {
        driver.transaction(() => {
          writeRow(table, merged);
        });
      } catch (caught) {
        return {
          ok: false,
          error: {
            message: caught instanceof Error ? caught.message : String(caught),
          },
        };
      }

      void enqueue(table, "upsert", id, hlc, merged).then(() => {
        // best-effort opportunistic sync after a local write
        if (transports.length > 0) void sync().catch(() => undefined);
      });
      refreshQueries([table]);
      options?.onComplete?.();
      return { ok: true, value: { id } };
    };

    // Relay HTTP errors carry their status so sync() can tell a retryable
    // failure (network / 5xx / 429) from a terminal one (400/401/403/413).
    const httpError = (op: string, status: number): Error => {
      const err = new Error(`${op} failed: ${status}`) as Error & {
        status?: number;
      };
      err.status = status;
      return err;
    };
    const TERMINAL_STATUSES = new Set([400, 401, 403, 413]);
    const DEFAULT_POLL_MS =
      typeof config.syncIntervalMs === "number" && config.syncIntervalMs > 0
        ? config.syncIntervalMs
        : 5000;
    // Backoff poll interval after a terminal failure so we don't re-push a
    // rejected batch every 5s forever (battery/network drain). focus/online
    // and local writes still trigger an immediate retry.
    const BACKOFF_POLL_MS = 5 * 60_000;
    let pollIntervalMs = DEFAULT_POLL_MS;

    const relayBaseUrls = (): string[] =>
      transports.map((t) => t.url.replace(/^wss:\/\//u, "https://").replace(/^ws:\/\//u, "http://"));

    const pushOutbox = async (baseUrl: string): Promise<void> => {
      if (!identity || !driver) return;
      const events = driver.select<{ event_id: string; envelope_json: string }>(
        `select event_id, envelope_json from "${SYNC_OUTBOX_TABLE}" where pushed_at is null order by event_id asc limit 1000`,
      );
      if (events.length === 0) return;
      const response = await fetchImpl(`${baseUrl}/v1/events`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${identity.relayAuth}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ownerId: identity.ownerId,
          events: events.map((e) => JSON.parse(e.envelope_json)),
        }),
      });
      if (!response.ok) throw httpError("push", response.status);
      const pushedAt = new Date().toISOString();
      for (const event of events) {
        driver.exec(
          `update "${SYNC_OUTBOX_TABLE}" set pushed_at = ? where event_id = ?`,
          [pushedAt, event.event_id],
        );
      }
    };

    const pullAndApply = async (baseUrl: string): Promise<Set<string>> => {
      const changed = new Set<string>();
      if (!identity || !driver) return changed;
      const cursorKey = `cursor:${baseUrl}`;
      const after = getMeta(cursorKey) ?? "";
      const url = new URL(`${baseUrl}/v1/events`);
      url.searchParams.set("ownerId", identity.ownerId);
      url.searchParams.set("after", after);
      const response = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${identity.relayAuth}` },
      });
      if (!response.ok) throw httpError("pull", response.status);
      const body = (await response.json()) as {
        events: SyncEnvelope[];
        nextCursor: string;
      };
      for (const envelope of body.events) {
        const seen = driver.select(
          `select 1 from "${SYNC_SEEN_TABLE}" where event_id = ?`,
          [envelope.eventId],
        );
        if (seen.length > 0) continue;
        const payload = await decryptEnvelope<Record<string, unknown>>(
          identity,
          envelope,
        );
        if (payload.table in schema) {
          applyRemoteRow(payload);
          changed.add(payload.table);
        }
        driver.exec(
          `insert or ignore into "${SYNC_SEEN_TABLE}" (event_id) values (?)`,
          [envelope.eventId],
        );
      }
      setMeta(cursorKey, body.nextCursor);
      return changed;
    };

    // Cap the dedup set so it can't grow without bound. Safe to prune: the
    // relay cursor only advances, so pruned (oldest) eventIds won't be re-pulled,
    // and applyRemoteRow is idempotent (LWW) even if one were.
    const SEEN_CAP = 50_000;
    const pruneSeen = () => {
      if (!driver) return;
      const n =
        driver.select<{ c: number }>(
          `select count(*) as c from "${SYNC_SEEN_TABLE}"`,
        )[0]?.c ?? 0;
      if (n > SEEN_CAP) {
        driver.exec(
          `delete from "${SYNC_SEEN_TABLE}" where event_id not in (select event_id from "${SYNC_SEEN_TABLE}" order by event_id desc limit ?)`,
          [SEEN_CAP],
        );
      }
    };

    const applyRemoteRow = (payload: SyncPayload<Record<string, unknown>>) => {
      if (!driver) return;
      const existing = driver.select<{ updatedAt: string }>(
        `select updatedAt from "${payload.table}" where id = ?`,
        [payload.rowId],
      )[0];
      if (existing && compareHlc(existing.updatedAt, payload.hlc) >= 0) return;
      writeRow(payload.table, { ...payload.value, id: payload.rowId });
    };

    const sync = async (): Promise<void> => {
      if (!identity || syncing) return;
      const bases = relayBaseUrls();
      if (bases.length === 0) return;
      syncing = true;
      setSyncState({ type: "SyncStateIsSyncing" });
      try {
        const changed = new Set<string>();
        for (const base of bases) {
          await pushOutbox(base);
          for (const table of await pullAndApply(base)) changed.add(table);
        }
        if (changed.size > 0) refreshQueries(changed);
        pruneSeen();
        setSyncState({
          type: "SyncStateIsSynced",
          lastSyncedAt: new Date().toISOString(),
        });
        // Recovered — restore the normal poll cadence if we'd backed off.
        if (pollIntervalMs !== DEFAULT_POLL_MS) {
          pollIntervalMs = DEFAULT_POLL_MS;
          stopPolling();
          startPolling();
        }
      } catch (caught) {
        const status = (caught as { status?: number } | undefined)?.status;
        const terminal =
          typeof status === "number" && TERMINAL_STATUSES.has(status);
        setSyncState({
          type: "SyncStateIsNotSynced",
          error: caught instanceof Error ? caught.message : String(caught),
          terminal,
          status,
        });
        // A terminal failure (auth/quota/bad event) won't self-heal by
        // retrying the same batch — slow the poller so it stops hammering, but
        // keep retrying occasionally (and immediately on focus/online/write).
        if (terminal && pollIntervalMs !== BACKOFF_POLL_MS) {
          pollIntervalMs = BACKOFF_POLL_MS;
          stopPolling();
          startPolling();
        }
      } finally {
        syncing = false;
      }
    };

    // The relay is HTTP (no server push), so poll periodically to pull remote
    // changes while transports are configured. Also synced opportunistically
    // after local writes and on web focus/online (below).
    const startPolling = () => {
      if (syncTimer !== null || transports.length === 0) return;
      syncTimer = setInterval(() => {
        void sync().catch(() => undefined);
      }, pollIntervalMs) as unknown as number;
    };
    const stopPolling = () => {
      if (syncTimer !== null) {
        clearInterval(syncTimer as unknown as ReturnType<typeof setInterval>);
        syncTimer = null;
      }
    };

    const loadIdentity = async (): Promise<void> => {
      let mnemonic =
        config.externalAppOwner?.mnemonic ??
        (await deps.secureStorage.getItem(mnemonicKey));
      if (!mnemonic || !isRecoveryMnemonic(mnemonic)) {
        mnemonic = createMnemonic();
        await deps.secureStorage.setItem(mnemonicKey, mnemonic);
      }
      mnemonic = normalizeMnemonic(mnemonic);
      identity = await deriveIdentity(mnemonic);
      appOwnerValue = { id: identity.ownerId, mnemonic, writeKey: identity.relayAuth };
      let storedDevice = await deps.secureStorage.getItem(deviceKey);
      if (!storedDevice) {
        const bytes = new Uint8Array(8);
        globalThis.crypto.getRandomValues(bytes);
        storedDevice = base64UrlEncode(bytes);
        await deps.secureStorage.setItem(deviceKey, storedDevice);
      }
      deviceId = storedDevice;
    };

    const init = async (): Promise<void> => {
      try {
        // Open the DB and derive identity while `driver` is still null, so any
        // query that renders during these awaits safely returns []. Only expose
        // the driver after the schema exists — assignment + ensureSchema are
        // synchronous and adjacent, so no query can run against missing tables.
        const sqlite = await deps.createSqliteDriver(config.name);
        await loadIdentity();
        driver = sqlite;
        ensureSchema();
        schemaReady = true;
        // Seed the HLC clock from its persisted high-water mark so it stays
        // monotonic across restarts (see nextHlc).
        hlcTime = Number(getMeta("hlc:time") ?? "0") || 0;
        hlcCounter = Number(getMeta("hlc:counter") ?? "0") || 0;
        // hydrate any active queries created before init finished
        refreshQueries(Object.keys(schema));
        if (transports.length > 0) {
          void sync().catch(() => undefined);
          startPolling();
        }
        // Sync promptly when the app regains focus / connectivity (web).
        const target = globalThis as unknown as {
          addEventListener?: (t: string, cb: () => void) => void;
        };
        if (typeof target.addEventListener === "function") {
          const onActive = () => {
            if (transports.length > 0) void sync().catch(() => undefined);
          };
          target.addEventListener("online", onActive);
          target.addEventListener("focus", onActive);
          target.addEventListener("visibilitychange", onActive);
        }
      } catch (caught) {
        setError({
          type: "InitError",
          message: caught instanceof Error ? caught.message : String(caught),
        });
        throw caught;
      }
    };

    const ready = init();

    const instance: SyncEngine<S> = {
      createQuery(fn) {
        const compiled = fn(compiler).compile();
        return {
          sql: compiled.sql,
          parameters: compiled.parameters as readonly unknown[],
          Row: undefined as never,
        };
      },
      getQueryRows<R>(query: Query<R>) {
        // Return a stable array reference (cached per query) so React's
        // useSyncExternalStore doesn't loop; refreshQueries swaps it on change.
        const key = queryKey(query);
        let entry = queries.get(key);
        if (!entry) {
          entry = {
            sql: query.sql,
            params: query.parameters,
            tables: tablesInSql(query.sql),
            rows: driver ? runQuery(query.sql, query.parameters) : [],
            listeners: new Set(),
          };
          queries.set(key, entry);
        }
        return entry.rows as readonly R[];
      },
      async loadQuery<R>(query: Query<R>) {
        await ready;
        const rows = runQuery(query.sql, query.parameters);
        const key = queryKey(query);
        const entry = queries.get(key);
        if (entry) entry.rows = rows;
        return rows as readonly R[];
      },
      subscribeQuery(query) {
        const key = queryKey(query);
        let entry = queries.get(key);
        if (!entry) {
          entry = {
            sql: query.sql,
            params: query.parameters,
            tables: tablesInSql(query.sql),
            rows: driver ? runQuery(query.sql, query.parameters) : [],
            listeners: new Set(),
          };
          queries.set(key, entry);
        }
        return (listener: () => void) => {
          entry!.listeners.add(listener);
          return () => {
            entry!.listeners.delete(listener);
            if (entry!.listeners.size === 0) queries.delete(key);
          };
        };
      },
      insert(table, values, options) {
        return mutate(table, values as Record<string, unknown>, "insert", options);
      },
      update(table, values, options) {
        return mutate(table, values as Record<string, unknown>, "update", options);
      },
      upsert(table, values, options) {
        return mutate(table, values as Record<string, unknown>, "upsert", options);
      },
      useOwner(options) {
        if (options.transports) instance.setTransports(options.transports);
        return () => instance.setTransports([]);
      },
      async importLegacy(legacyDbName) {
        await ready;
        // Versioned so a fixed importer re-runs for users imported by an older,
        // buggy version. v2: coerce NULL booleans (legacy schemas allowed NULL
        // where ours requires SqliteBoolean) so those rows aren't silently
        // dropped — v1 lost e.g. accounts whose `excludeFromReports` was NULL.
        // v3: also count + LOG rows we can't import (required non-boolean
        // column NULL/invalid in legacy data) instead of dropping them
        // silently. Re-runs for users imported by older versions.
        const IMPORT_VERSION = LEGACY_IMPORT_VERSION;
        const done = Number(getMeta("legacyImported") ?? "0") || 0;
        if (!driver || done >= IMPORT_VERSION) return { imported: 0, skipped: 0 };
        let imported = 0;
        let skipped = 0;
        const skipReasons: string[] = [];
        try {
          const legacy = await deps.createSqliteDriver(legacyDbName);
          for (const table of Object.keys(schema)) {
            const columns = schema[table];
            // SqliteBoolean columns accept 0 and 1 but reject 2 — used to spot
            // required booleans so a legacy NULL/missing becomes `false`, not a
            // drop. (PositiveInt/FiniteNumber/strings don't match, so e.g.
            // `order` stays untouched.)
            const boolColumns = Object.entries(columns)
              .filter(
                ([, type]) =>
                  type.from(0).ok && type.from(1).ok && !type.from(2).ok,
              )
              .map(([name]) => name);
            let rows: Record<string, unknown>[] = [];
            try {
              rows = legacy.select<Record<string, unknown>>(
                `select * from "${table}"`,
              );
            } catch {
              continue; // table absent in legacy db
            }
            for (const row of rows) {
              if (typeof row.id !== "string") continue;
              // Re-run recovers only rows not already imported (no churn on the
              // rows a prior import got right).
              const exists =
                driver.select(`select 1 from "${table}" where id = ? limit 1`, [
                  row.id,
                ]).length > 0;
              if (exists) continue;
              const sanitized: Record<string, unknown> = { ...row };
              for (const name of boolColumns) {
                if (sanitized[name] === null || sanitized[name] === undefined) {
                  sanitized[name] = sqliteFalse;
                }
              }
              const result = mutate(table, sanitized, "upsert");
              if (result.ok) {
                imported += 1;
              } else {
                skipped += 1;
                if (skipReasons.length < 20) {
                  skipReasons.push(
                    `${table}#${row.id}: ${result.error.message}`,
                  );
                }
              }
            }
          }
        } catch (caught) {
          // No legacy database, or incompatible — leave the new db untouched.
          console.warn("importLegacy: legacy db unreadable", caught);
        }
        setMeta("legacyImported", String(IMPORT_VERSION));
        if (imported > 0) refreshQueries(Object.keys(schema));
        if (skipped > 0) {
          // Visible, not silent: a column was NULL/invalid for a required field
          // we can't safely default (e.g. a NULL amount/date/name). Surfaced so
          // it can be investigated rather than vanishing.
          console.warn(
            `importLegacy: skipped ${skipped} legacy row(s) that failed validation:`,
            skipReasons,
          );
        }
        return { imported, skipped };
      },
      get appOwner() {
        appOwnerPromise ??= ready.then(() => appOwnerValue);
        return appOwnerPromise;
      },
      async restoreAppOwner(mnemonic, options) {
        const normalized = normalizeMnemonic(mnemonic);
        if (!isRecoveryMnemonic(normalized))
          throw new Error("Invalid recovery phrase.");
        const restored = await deriveIdentity(normalized);
        // Safety: don't destroy local data unless the relay confirms this owner
        // actually has a backup. A valid-but-wrong phrase derives a different,
        // empty owner; without this check, restore would wipe everything and
        // restore nothing, with no way back. `force` overrides (intentional new
        // owner). If there are no relays configured we can't verify -> refuse
        // unless forced.
        if (!options?.force) {
          const bases = relayBaseUrls();
          let hasBackup = false;
          for (const base of bases) {
            try {
              const url = new URL(`${base}/v1/events`);
              url.searchParams.set("ownerId", restored.ownerId);
              url.searchParams.set("after", "");
              url.searchParams.set("limit", "1");
              const res = await fetchImpl(url.toString(), {
                headers: { Authorization: `Bearer ${restored.relayAuth}` },
              });
              if (res.ok) {
                const b = (await res.json()) as { events?: unknown[] };
                if (Array.isArray(b.events) && b.events.length > 0) {
                  hasBackup = true;
                  break;
                }
              }
            } catch {
              // network/relay error — treat as "unverified"
            }
          }
          if (!hasBackup) {
            throw new Error(
              "No backup found for this recovery phrase (the relay is empty or unreachable). Nothing was changed. Use force to switch to a new owner.",
            );
          }
        }
        // Verified (or forced): switch owners — persist phrase, wipe, reload so
        // the engine reboots with the restored owner and pulls fresh.
        await deps.secureStorage.setItem(mnemonicKey, normalized);
        wipeLocalData();
        // Suppress the one-time legacy import on the post-reload boot — the user
        // chose this owner explicitly; re-importing the old legacy db would mix
        // stale data back in. (wipeLocalData cleared this flag.)
        setMeta("legacyImported", String(LEGACY_IMPORT_VERSION));
        // Soft re-init for platforms without a hard reload (RN); on web the
        // reload below supersedes this.
        identity = await deriveIdentity(normalized);
        appOwnerValue = {
          id: identity.ownerId,
          mnemonic: normalized,
          writeKey: identity.relayAuth,
        };
        appOwnerPromise = Promise.resolve(appOwnerValue);
        refreshQueries(Object.keys(schema));
        if (transports.length > 0) void sync().catch(() => undefined);
        instance.reloadApp();
      },
      async resetAppOwner() {
        const mnemonic = createMnemonic();
        await deps.secureStorage.setItem(mnemonicKey, mnemonic);
        wipeLocalData();
        // "Erase all data" must stay erased: mark the legacy import done so the
        // post-reload boot doesn't re-import the old legacy db and bring it back.
        setMeta("legacyImported", String(LEGACY_IMPORT_VERSION));
        identity = await deriveIdentity(mnemonic);
        appOwnerValue = {
          id: identity.ownerId,
          mnemonic,
          writeKey: identity.relayAuth,
        };
        appOwnerPromise = Promise.resolve(appOwnerValue);
        refreshQueries(Object.keys(schema));
        instance.reloadApp();
      },
      subscribeError(listener) {
        errorListeners.add(listener);
        return () => errorListeners.delete(listener);
      },
      getError() {
        return error;
      },
      subscribeSyncState(listener) {
        syncListeners.add(listener);
        return () => syncListeners.delete(listener);
      },
      getSyncState() {
        return syncState;
      },
      setTransports(next) {
        transports = [...next];
        if (transports.length > 0) {
          void sync().catch(() => undefined);
          startPolling();
        } else {
          stopPolling();
        }
      },
      sync,
      reloadApp() {
        if (deps.reloadApp) {
          void deps.reloadApp();
          return;
        }
        globalThis.location?.reload?.();
      },
      ready,
    };

    return instance;
  };
