// Types for the sync engine: the schema-to-Kysely-Database derivation, the
// mutation/query shapes, the platform plumbing each app injects (SQLite driver,
// secure storage), and the public {@link SyncEngine} surface. The runtime lives
// in ./engine.

import { type Kysely, type Compilable } from "kysely";
import { type EncryptedEnvelopeV1 } from "@simplysync/protocol";
import { type Id, type SqliteBoolean, type Type } from "./type.js";

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

export interface CreateQueryOptions {
  /**
   * Acknowledges that this query intentionally reads soft-deleted rows, which
   * silences the missing-`isDeleted`-filter warning. Does not change the SQL.
   */
  readonly includeDeleted?: boolean;
}

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
      /** Commit only if the live row still has this sync version. */
      readonly expectedUpdatedAt?: string;
    }
    | {
        readonly table: T;
        readonly mode: "delete";
        readonly values: { readonly id: Id };
        /** Tombstone only if the live row still has this sync version. */
        readonly expectedUpdatedAt?: string;
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

/**
 * One committed event crossing the tab channel: the outbox row's identity plus
 * its plaintext payload (same trust level as the local database — the channel
 * is same-origin only and never leaves the machine). `outbox` distinguishes
 * local-origin writes (receivers stage the same outbox row so ANY tab promoted
 * to leader can push it) from relay-pulled or `local: true` events (already on
 * the relay / deliberately unsynced — applied to the receiver's rows only).
 */
export interface TabSyncEvent {
  readonly eventId: string;
  readonly payloadJson: string;
  readonly outbox: boolean;
}

/**
 * Cross-instance coordination for platforms where several engine instances
 * share one persisted database (browser tabs). Every instance applies every
 * other instance's events through the normal LWW path; exactly one instance —
 * the "leader" — persists snapshots and talks to relays. Absent (native, CLI,
 * tests) the engine behaves exactly as before.
 */
export interface TabSync {
  isLeader(): boolean;
  /** Fires when THIS instance becomes the leader (the previous one closed). */
  onPromoted(listener: () => void): () => void;
  publishEvents(events: readonly TabSyncEvent[]): void;
  subscribeEvents(
    listener: (events: readonly TabSyncEvent[]) => void,
  ): () => void;
  /** Leader → followers mirror, so sync UI works in every tab. */
  publishSyncState(state: SyncState): void;
  subscribeSyncState(listener: (state: SyncState) => void): () => void;
  /** Cross-tab critical section (e.g. first-boot identity creation). */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Destructive-op barrier (owner restore/reset, database import): every other
   * tab stops writing/persisting and reboots; resolves once this tab is the
   * sole writer. Rebooting tabs block in their boot barrier until the
   * initiating tab has persisted the post-op snapshot and reloaded.
   */
  acquireExclusive(): Promise<void>;
}

export interface SyncEngineDeps {
  readonly createSqliteDriver: (
    name: string,
  ) => SqliteDriver | Promise<SqliteDriver>;
  readonly secureStorage: SecureStorage;
  readonly fetch?: typeof fetch;
  /**
   * Multi-instance coordination (browser tabs sharing one database). When
   * present the engine also stamps a per-instance suffix onto the HLC device
   * id so two tabs can never mint the same event id in the same millisecond.
   */
  readonly tabSync?: TabSync;
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
 * recovery key or phrase (so the data decrypts on a new device), every row of
 * every table (including soft-deleted rows and the system columns), and the
 * sync metadata (HLC high-water mark + per-relay pull cursors). Produced by
 * `exportDatabase` and consumed by `importDatabase`.
 */
export interface DbSnapshot {
  readonly format: "simplysync-db-snapshot";
  readonly version: 1;
  readonly exportedAt: string;
  /**
   * Canonical identity root needed to decrypt the data: either a native
   * `sf1_` recovery key or a normalized BIP39 phrase.
   */
  readonly recoveryKey?: string;
  /**
   * Legacy snapshot field, retained so backups written by older engines still
   * import. New phrase-backed snapshots include it for backward compatibility;
   * native-key snapshots use {@link recoveryKey} only.
   */
  readonly mnemonic?: string;
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
  /** Secret to back up: a native `sf1_` key or a normalized BIP39 phrase. */
  readonly recoveryKey: string;
  /** Present only when {@link recoveryKey} is a BIP39 recovery phrase. */
  readonly mnemonic?: string;
  /** Bearer token presented to relays (the write key). */
  readonly writeKey: string;
}

/**
 * Owner supplied by a host integration. The mnemonic-only branch keeps source
 * compatibility with integrations built before {@link AppOwner.recoveryKey}
 * became the canonical credential field.
 */
export type ExternalAppOwner =
  | AppOwner
  | (Omit<AppOwner, "recoveryKey" | "mnemonic"> & {
      readonly recoveryKey?: never;
      readonly mnemonic: string;
    });

export interface MutationOptions {
  readonly onComplete?: () => void;
  /**
   * Compare-and-set guard for an editor snapshot. The mutation succeeds only
   * when the current row has its `updatedAt` HLC and expected deletion state
   * (live by default). A missing or newer row returns a write conflict.
   */
  readonly expectedUpdatedAt?: string;
  /**
   * Internal companion to `expectedUpdatedAt`: require the matching row to be
   * a tombstone. App code should use `restore`, which sets this safely and also
   * forces the committed row live again.
   */
  readonly expectedDeleted?: boolean;
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
  /**
   * Highest sync-payload schema this app can interpret. Defaults to `1`.
   *
   * Keep this unchanged for additive table/column changes: older engines
   * already project known columns and defer unknown tables. Bump it only when
   * payload field meaning changes. Older clients then retain those events in
   * `_sync_deferred` and replay them after an app upgrade declares support.
   */
  readonly schemaVersion?: number;
  readonly indexes?: IndexBuilder;
  readonly transports?: readonly Transport[];
  readonly externalAppOwner?: ExternalAppOwner | null;
  readonly encryptionKey?: unknown;
  /** Poll interval (ms) for pulling remote changes. Default 60000. */
  readonly syncIntervalMs?: number;
  /**
   * Set `false` to stop the engine scheduling sync for itself: no poll timer,
   * and no opportunistic pass after a local write, at boot, when transports
   * are attached, on web focus/online, or on promotion to Leader.
   * `engine.sync()` still runs a full pass, so the host decides exactly when
   * this Device talks to a Relay.
   *
   * For anything that wants one observable sync instead of a background loop:
   * a CLI that syncs once and exits, a diagnostic that reports what a single
   * pass did, a test that needs the Outbox to sit still. Default: on.
   */
  readonly autoSync?: boolean;
  /**
   * Reserved retention setting kept for source compatibility.
   *
   * Automatic hard deletion is disabled until the protocol has a durable
   * cross-device delete watermark. Without one, a long-offline device could
   * resurrect a row after its tombstone and relay stream were erased. Manual
   * purge methods remain available only for databases that have never used a
   * relay.
   *
   * @deprecated Currently has no effect.
   */
  readonly tombstoneRetentionMs?: number | false;
  /**
   * Reject a write whose encrypted event would exceed this many bytes, at write
   * time, with a clear error — instead of letting it into the outbox where a
   * relay's per-event cap (default 256 KiB) rejects it on every push and stalls
   * every later write behind it (head-of-line poison pill). Defaults to 256 KiB
   * to match the reference relays; raise it only if your relay's MAX_EVENT_BYTES
   * is higher. A JSON column is the usual way to blow past it — prefer the blob
   * API for large values.
   */
  readonly maxEventBytes?: number;
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
  | {
      readonly type: "SyncStateIsSyncing";
      /**
       * Live counters, re-emitted after every push batch / pull page so a UI
       * can show movement during a large sync (a new-relay backfill moves
       * thousands of events — a status that only flips at the end of the
       * cycle is indistinguishable from a hang). Absent on the initial flip.
       */
      readonly progress?: {
        readonly pendingPush: number;
        readonly pulled: number;
        readonly applied: number;
      };
    }
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
  /**
   * True while this device is re-uploading the owner's rows because the relay
   * lost its data (wiped volume, fresh deploy, or a restore from an older
   * backup). Detected from a pull 404 on an owner we had already pulled, or a
   * reported `headSeq` behind our pull cursor. Pair with
   * `SyncStateIsSyncing.progress.pendingPush` for a "re-uploading N events"
   * banner: a plain "synced" would be a lie until the copy is rebuilt.
   *
   * Session-scoped: this flag is held in memory, not on disk, so a restart
   * part-way through a re-seed reports a healthy relay until the next probe
   * detects the loss again. The re-seed itself resumes from the durable
   * outbox, so no data is at risk — only the banner is briefly wrong.
   */
  readonly reseeding?: boolean;
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
  createQuery<O>(
    fn: (db: Kysely<Database<S>>) => Compilable<O>,
    options?: CreateQueryOptions,
  ): Query<O>;
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
   * Restore exactly the tombstone identified by `expectedUpdatedAt`. A missing,
   * live, or newer row returns a write-conflict failure.
   */
  restore<T extends keyof S & string>(
    table: T,
    id: Id,
    expectedUpdatedAt: string,
    options?: Omit<MutationOptions, "expectedUpdatedAt" | "expectedDeleted">,
  ): MutationResult;
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
   * than `olderThanMs` (default 30 days) in a database that has never used a
   * relay. Once relay history exists this returns `{ purged: 0 }`, even after
   * transports are detached, because no durable cross-device deletion
   * watermark exists yet. Returns the count purged.
   */
  purgeDeleted(options?: { olderThanMs?: number }): { purged: number };
  /**
   * Immediately hard-delete specific tombstoned rows ("Delete Permanently" /
   * "Empty Trash"), skipping the age window, for databases that have never
   * used a relay. Rows that aren't tombstones are skipped. Once relay history
   * exists this returns `{ purged: 0 }`; retaining the tombstone prevents a
   * long-offline peer from resurrecting the row.
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
   * Restore an owner from a native `sf1_` recovery key or BIP39 phrase. By
   * default this refuses to wipe local data unless the relay confirms the owner
   * has data (so a wrong credential or unreachable relay can't destroy the
   * current data). Pass
   * `{ force: true }` to switch to an empty/new owner intentionally.
   */
  restoreAppOwner(
    recoveryKey: string,
    options?: { force?: boolean },
  ): Promise<void>;
  /**
   * Mint a brand-new owner and REPLACE all local data with an empty database —
   * "erase everything". The most destructive call in the engine: anything not
   * already on a relay is unrecoverable afterwards.
   *
   * By default it refuses unless a relay is verified to hold a copy of the
   * current owner's data, and throws a message describing which condition
   * failed (unpushed changes, no relay reachable, no relay holding data, no
   * relay configured) so the app can offer the right next step — wait for sync,
   * or take an {@link SyncEngine.exportDatabase} backup first. Pass
   * `{ force: true }` once the user has confirmed.
   */
  resetAppOwner(options?: { force?: boolean }): Promise<void>;
  /**
   * Build an encrypted, portable full-database snapshot (every table + the
   * recovery key/phrase + sync cursors) — the file a user carries to a new main
   * device without relying on a relay. Pair with {@link importDatabase}.
   *
   * By default the file is encrypted with a key derived from the owner's
   * recovery credential: no extra secret to manage, and restoring just
   * requires that key or phrase (which the user already safeguards). Pass
   * `{ passphrase }` for the optional mode where a separate passphrase protects
   * the file instead — a second, independent secret that survives loss of the
   * recovery credential.
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
   * For a recovery-keyed file, pass `{ recoveryKey }` (defaults to the current
   * device's key/phrase if it matches). The legacy `{ recoveryPhrase }` alias is
   * also accepted. For a passphrase-keyed file, pass `{ passphrase }`.
   */
  importDatabase(
    envelope: EncryptedEnvelopeV1 | string,
    options?: {
      passphrase?: string;
      recoveryKey?: string;
      /** @deprecated Use `recoveryKey`; this alias remains wire/API compatible. */
      recoveryPhrase?: string;
    },
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
   *
   * NOT a pure read. This is also where relay data loss is detected, so a
   * status probe can decide the relay was wiped and re-seed it: clearing this
   * device's cursors and delivery rows for that relay and re-queueing every
   * row it holds. That is deliberate — recovery should be eager, and a caller
   * choosing a poll interval is choosing how promptly data loss is noticed —
   * but it means a "refresh" button can start a full re-upload.
   */
  getRelayStatuses(): Promise<RelayStatus[]>;
  setTransports(transports: readonly Transport[]): void;
  sync(): Promise<void>;
  reloadApp(): void;
  readonly ready: Promise<void>;
}
