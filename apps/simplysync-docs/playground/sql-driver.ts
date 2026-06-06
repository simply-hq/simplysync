// Backs the engine's synchronous `SqliteDriver` (see
// packages/simplysync-engine/src/engine.ts) with sql.js — a synchronous WASM
// build of SQLite, the one browser SQLite whose API matches the engine's sync
// exec/select/transaction contract. The shape mirrors the bun:sqlite test
// wrapper in packages/simplysync-engine/test/engine.test.ts.
//
// Persistence: sql.js is in-memory, so after every write we snapshot
// `db.export()` into a pluggable store (IndexedDB in the browser; an in-memory
// store in the headless tests) so data survives reloads.
//
// The playground runs TWO engines (two simulated devices), so databases are
// tracked in a registry keyed by name. The no-argument forms of getActiveDb()
// and persistNow() still work (last-opened / all) for single-engine callers.

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

interface OpenDb {
  readonly db: Database;
  readonly store: SnapshotStore;
}

const registry = new Map<string, OpenDb>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let lastOpened: string | null = null;
let sqlStaticPromise: Promise<SqlJsStatic> | null = null;

/**
 * The live sql.js handle for `name` (default: the last-opened database), for
 * reading engine-internal tables (e.g. the outbox).
 */
export function getActiveDb(name?: string): Database | null {
  const key = name ?? lastOpened;
  return key ? (registry.get(key)?.db ?? null) : null;
}

/**
 * Flushes a database to its store immediately (awaitable). With no name, flushes
 * every open database.
 */
export async function persistNow(name?: string): Promise<void> {
  const names = name ? [name] : [...registry.keys()];
  for (const key of names) {
    const timer = debounceTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
    const open = registry.get(key);
    if (open) await open.store.save(key, open.db.export());
  }
}

function schedulePersist(name: string, debounceMs: number): void {
  const existing = debounceTimers.get(name);
  if (existing !== undefined) clearTimeout(existing);
  debounceTimers.set(
    name,
    setTimeout(() => {
      debounceTimers.delete(name);
      void persistNow(name);
    }, debounceMs),
  );
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
    registry.set(name, { db, store: options.store });
    lastOpened = name;

    return {
      exec(sql, params) {
        db.run(sql, (params ?? []) as BindParams);
        schedulePersist(name, debounceMs);
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
          schedulePersist(name, debounceMs);
          return result;
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
      },
    };
  };
}
