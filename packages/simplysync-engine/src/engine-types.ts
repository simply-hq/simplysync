// Types for the sync engine: the schema-to-Kysely-Database derivation, the
// mutation/query shapes, the platform plumbing each app injects (SQLite driver,
// secure storage), and the public {@link SyncEngine} surface. The runtime lives
// in ./engine.

import { type Kysely, type Compilable } from "kysely";
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
