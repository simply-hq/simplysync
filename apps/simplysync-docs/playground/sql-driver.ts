// Backs the engine's synchronous `SqliteDriver` (see
// packages/simplysync-engine/src/engine.ts) with sql.js — a synchronous WASM build
// of SQLite, the one browser SQLite whose API matches the engine's sync
// exec/select/transaction contract. The shape mirrors the bun:sqlite test
// wrapper in packages/simplysync-engine/test/engine.test.ts.
//
// Persistence: sql.js is in-memory, so after every write we snapshot
// `db.export()` into a pluggable store (IndexedDB in the browser; an in-memory
// store in the headless smoke test) so data survives reloads.

import initSqlJs, {
  type BindParams,
  type Database,
  type SqlJsStatic,
} from "sql.js";
import type { SqliteDriver } from "@simplysync/engine";

/** Where database snapshots are persisted between loads. */
export interface SnapshotStore {
  load(name: string): Promise<Uint8Array | null>;
  save(name: string, bytes: Uint8Array): Promise<void>;
}

export interface SqlJsDriverOptions {
  readonly store: SnapshotStore;
  /** Tells sql.js where to fetch its `.wasm`. Omit to use its default. */
  readonly locateFile?: (file: string) => string;
  /** Debounce window before a write is snapshotted. Default 250ms. */
  readonly debounceMs?: number;
}

// Single active database — the playground only ever opens one. Kept at module
// scope so the UI can read the internal `_sync_outbox` table and force a flush.
let active: { name: string; db: Database; store: SnapshotStore } | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let sqlStaticPromise: Promise<SqlJsStatic> | null = null;

/** The live sql.js handle, for reading engine-internal tables (e.g. outbox). */
export function getActiveDb(): Database | null {
  return active?.db ?? null;
}

/** Flushes the current database to its store immediately (awaitable). */
export async function persistNow(): Promise<void> {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  if (!active) return;
  await active.store.save(active.name, active.db.export());
}

function schedulePersist(debounceMs: number): void {
  if (debounceTimer !== null) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void persistNow();
  }, debounceMs);
}

/**
 * Returns a `createSqliteDriver(name)` for the engine's `SyncEngineDeps`. Loads
 * any prior snapshot, opens the sql.js database, and wraps it as a SqliteDriver
 * that snapshots after each write.
 */
export function createSqlJsDriverFactory(
  options: SqlJsDriverOptions,
): (name: string) => Promise<SqliteDriver> {
  const debounceMs = options.debounceMs ?? 250;

  return async (name: string): Promise<SqliteDriver> => {
    sqlStaticPromise ??= initSqlJs(
      options.locateFile ? { locateFile: options.locateFile } : undefined,
    );
    const SQL = await sqlStaticPromise;
    const prior = await options.store.load(name);
    const db = prior ? new SQL.Database(prior) : new SQL.Database();
    active = { name, db, store: options.store };

    return {
      exec(sql, params) {
        db.run(sql, (params ?? []) as BindParams);
        schedulePersist(debounceMs);
      },
      select<R = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): R[] {
        const stmt = db.prepare(sql);
        try {
          if (params && params.length > 0) stmt.bind(params as BindParams);
          const rows: Record<string, unknown>[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          return rows as R[];
        } finally {
          stmt.free();
        }
      },
      transaction<T>(fn: () => T): T {
        db.run("BEGIN");
        try {
          const result = fn();
          db.run("COMMIT");
          schedulePersist(debounceMs);
          return result;
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
      },
    };
  };
}
