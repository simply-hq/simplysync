// Types for the sync engine: the schema-to-Kysely-Database derivation, the
// mutation/query shapes, the platform plumbing each app injects (SQLite driver,
// secure storage), and the public {@link SyncEngine} surface. The runtime lives
// in ./engine.

import { type Kysely, type Compilable } from "kysely";
import { type EncryptedEnvelopeV1 } from "@simplysync/protocol";
import { type Id, type SqliteBoolean, type Type } from "./type";

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

/**
 * One write in a `batch`. A discriminated union over the schema's tables, so
 * `values` is type-checked against the chosen `table`. `mode` defaults to
 * "upsert".
 */
export type BatchOp<S extends SchemaDefinition> = {
  [T in keyof S & string]:
    | {
        readonly table: T;
        readonly values: InsertValues<S[T]> & Partial<UpdateValues<S[T]>>;
        readonly mode?: "insert" | "update" | "upsert";
      }
    | {
        readonly table: T;
        readonly mode: "delete";
        readonly values: { readonly id: Id };
      };
}[keyof S & string];

/** Result of `batch`: the ids written (in op order) or the first error. */
export type BatchResult =
  | { readonly ok: true; readonly ids: readonly Id[] }
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
  /**
   * Override the passphrase key-derivation used by exportDatabase /
   * importDatabase. The default uses WebCrypto PBKDF2 (browsers / Bun / Node).
   * React Native's subtle PBKDF2 is unreliable, so RN apps should inject a
   * native one (e.g. react-native-quick-crypto's `pbkdf2Sync`). It must honour
   * the given salt + iterations and return `keyBytes` bytes.
   */
  readonly deriveKeyFromPassphrase?: (
    passphrase: string,
    salt: Uint8Array,
    iterations: number,
    keyBytes: number,
  ) => Uint8Array | Promise<Uint8Array>;
}

/**
 * A portable, driver-agnostic snapshot of the whole local database: the
 * recovery phrase (so the data decrypts on a new device), every row of every
 * table (including soft-deleted rows and the system columns), and the sync
 * metadata (HLC high-water mark + per-relay pull cursors). Produced by
 * `exportDatabase` and consumed by `importDatabase`.
 */
export interface DbSnapshot {
  readonly format: "simplysync-db-snapshot";
  readonly version: 1;
  readonly exportedAt: string;
  /** Recovery phrase — the identity root needed to decrypt the data. */
  readonly mnemonic: string;
  readonly tables: Record<string, Record<string, unknown>[]>;
  /** Selected `_sync_meta` keys: `hlc:time`, `hlc:counter`, `cursor:*`. */
  readonly meta: Record<string, string>;
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
  /**
   * Write to the local database and refresh queries, but DON'T enqueue a sync
   * event or trigger a push. The row still gets a fresh HLC, so the local UI
   * updates instantly and a later synced write to the same row wins LWW.
   *
   * For high-frequency, soon-superseded edits where syncing every step is
   * wasteful: a streaming AI reply written token-by-token, a text field saved on
   * every keystroke, a slider dragged in real time. Stream the intermediate
   * states with `{ local: true }`, then do ONE normal write at the end so peers
   * receive a single event with the final value instead of hundreds of
   * throwaway envelopes (every one of which they'd otherwise pull + decrypt).
   *
   * Trade-off: a local-only write that's never followed by a synced write stays
   * on this device. Commit on completion (or debounce a periodic real write) so
   * the latest value reaches the relay.
   */
  readonly local?: boolean;
}

export interface SyncEngineConfig {
  readonly name: string;
  readonly indexes?: IndexBuilder;
  readonly transports?: readonly Transport[];
  readonly externalAppOwner?: AppOwner | null;
  readonly encryptionKey?: unknown;
  /** Poll interval (ms) for pulling remote changes. Default 5000. */
  readonly syncIntervalMs?: number;
  /**
   * Retention window for the automatic tombstone sweep that runs (at most once
   * a day) during sync: soft-deleted rows older than this are hard-deleted
   * locally and their relay streams compacted away (`POST /v1/streams/compact`)
   * on every configured relay. Default 30 days. Pass `false` to disable the
   * automatic sweep (manual `purgeDeleted` / `purgeRows` still work).
   */
  readonly tombstoneRetentionMs?: number | false;
}

/** Structured reason a sync attempt failed, so a consumer can show *why*. */
export type SyncFailureKind =
  | "offline"
  | "unreachable"
  | "timeout"
  | "authRejected"
  | "quotaExceeded"
  | "rateLimited"
  | "badRequest"
  | "serverError"
  | "decryptFailed"
  | "applyFailed"
  | "unknown";

export type SyncState =
  | { readonly type: "SyncStateInitial" }
  | { readonly type: "SyncStateIsSyncing" }
  | { readonly type: "SyncStateIsSynced"; readonly lastSyncedAt: string }
  | {
      readonly type: "SyncStateIsNotSynced";
      readonly error?: string;
      readonly kind?: SyncFailureKind;
      // Set for non-retryable failures (auth/quota/bad-request). The UI should
      // show these; the engine backs the poller off so it doesn't hammer.
      readonly terminal?: boolean;
      readonly status?: number;
    };

/**
 * Live view of one configured relay: this device's last sync outcome with it
 * (tracked locally by the sync loop) merged with the relay-reported account
 * snapshot from `GET /v1/status` — how much of the owner's storage quota is
 * used, and how much data the relay holds. Multi-relay setups get one entry
 * per relay, so a failing or filling-up relay is visible even while another
 * relay keeps the overall SyncState green.
 */
export interface RelayStatus {
  /** Relay base URL, normalized (wss:// → https://). */
  readonly url: string;
  /** True when the relay answered the status probe (even with no account). */
  readonly reachable: boolean;
  /** Last successful sync with this relay this session (ISO8601). */
  readonly lastSyncedAt?: string;
  /** Most recent failure talking to this relay (sync or status probe). */
  readonly lastFailure?: {
    readonly kind: SyncFailureKind;
    readonly message: string;
    readonly at: string;
  };
  /** Relay software version (from /v1/status, or /health when no account). */
  readonly version?: string;
  // Account block from /v1/status. Absent when the relay is unreachable or
  // this owner has never pushed to it (the relay answers 404 until then).
  /** Bytes of this owner's data the relay currently stores. */
  readonly usedBytes?: number;
  /** The relay's per-owner storage limit in bytes. */
  readonly quotaBytes?: number;
  /** usedBytes / quotaBytes × 100, as reported by the relay. */
  readonly usedPct?: number;
  /** The relay's newest event sequence for this owner (pull-cursor head). */
  readonly headSeq?: number;
  /** Distinct streams (≈ live rows) the relay holds for this owner. */
  readonly streams?: number;
  /** Raw stored event count (shrinks when the relay compacts). */
  readonly events?: number;
}

/** One persisted row of the sync diagnostics log. */
export interface SyncLogEntry {
  readonly seq: number;
  readonly at: string; // ISO8601
  readonly relay: string;
  readonly phase: string; // "sync" | "push" | "pull"
  readonly result: "ok" | "fail";
  readonly kind?: SyncFailureKind;
  readonly message?: string;
  readonly pushed: number;
  readonly pulled: number;
  readonly applied: number;
}

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
  /**
   * Write many rows atomically in one transaction with a single query refresh
   * and a single sync. Bulk-seed, import, or persist several AI-generated items
   * at once — and mix in deletes (`mode: "delete"`) for atomic moves. Validates
   * every op first; one invalid op aborts the whole batch.
   */
  batch(ops: ReadonlyArray<BatchOp<S>>, options?: MutationOptions): BatchResult;
  /**
   * Soft-delete a row by id: marks it deleted so the deletion replicates as a
   * tombstone (a hard local delete would resurrect from a peer on next sync) and
   * queries that filter `isDeleted` stop returning it. Idempotent.
   */
  delete<T extends keyof S & string>(
    table: T,
    id: Id,
    options?: MutationOptions,
  ): MutationResult;
  /** Soft-delete many rows of one table in a single atomic batch. */
  deleteMany<T extends keyof S & string>(
    table: T,
    ids: readonly Id[],
    options?: MutationOptions,
  ): BatchResult;
  /**
   * Reclaim local storage by hard-deleting soft-deleted rows (tombstones) older
   * than `olderThanMs` (default 30 days). Safe: the grace window lets the
   * deletion replicate first, pending-but-unpushed deletes are kept while
   * relays are configured, and the relay retains tombstones so a re-sync
   * re-applies them — synced peers are never resurrected. Returns the count
   * purged.
   */
  purgeDeleted(options?: { olderThanMs?: number }): { purged: number };
  /**
   * Immediately hard-delete specific tombstoned rows ("Delete Permanently" /
   * "Empty Trash"), skipping the age window. Rows that aren't tombstones, or
   * whose delete event hasn't reached a relay yet (while relays are
   * configured), are skipped and stay in the trash — retry after a sync.
   * Purged rows' relay streams are queued for compaction and dropped from
   * every configured relay on the next sync. Note: a device that stays offline
   * past the purge never learns of the delete — permanent delete is
   * best-effort on multi-device, not a guaranteed global erase.
   */
  purgeRows(
    rows: ReadonlyArray<{ table: keyof S & string; id: Id }>,
  ): { purged: number };
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
  /**
   * Build an encrypted, portable full-database snapshot (every table + the
   * recovery phrase + sync cursors) — the file a user carries to a new main
   * device without relying on a relay. Pair with {@link importDatabase}.
   *
   * By default the file is encrypted with a key derived from the owner's
   * recovery phrase: no extra secret to manage, and restoring just requires the
   * phrase (which the user already safeguards). Pass `{ passphrase }` for the
   * optional mode where a separate passphrase protects the file instead — a
   * second, independent secret that survives loss of the recovery phrase.
   */
  exportDatabase(options?: {
    passphrase?: string;
  }): Promise<EncryptedEnvelopeV1>;
  /**
   * Restore a snapshot produced by {@link exportDatabase}: decrypt, adopt the
   * backup's identity, REPLACE all local data, and reload. The file proves
   * ownership, so no relay is consulted. Throws on the wrong secret or an
   * unrecognized file.
   *
   * For a recovery-phrase-keyed file, pass `{ recoveryPhrase }` (defaults to the
   * current device's phrase if it matches). For a passphrase-keyed file, pass
   * `{ passphrase }`.
   */
  importDatabase(
    envelope: EncryptedEnvelopeV1 | string,
    options?: { passphrase?: string; recoveryPhrase?: string },
  ): Promise<void>;
  subscribeError(listener: () => void): () => void;
  getError(): SyncError | null;
  subscribeSyncState(listener: () => void): () => void;
  getSyncState(): SyncState;
  /** Most-recent-first slice of the on-device sync diagnostics log. */
  getSyncLog(limit?: number): SyncLogEntry[];
  /** Count of unpushed events still in the outbox (0 = drained). */
  getPendingOutboxCount(): number;
  /**
   * One entry per configured relay: local sync health plus the relay-reported
   * storage snapshot (used vs quota, stream/event counts) fetched live from
   * `GET /v1/status`. Network I/O on every call — poll at UI cadence (e.g. a
   * diagnostics screen), not per frame.
   */
  getRelayStatuses(): Promise<RelayStatus[]>;
  setTransports(transports: readonly Transport[]): void;
  sync(): Promise<void>;
  reloadApp(): void;
  readonly ready: Promise<void>;
}
