import initSqlJs, {
  type BindParams,
  type Database,
  type SqlJsStatic,
} from "sql.js";
import type { SqliteDriver } from "@simplysync/engine";
import type { SnapshotStore } from "./snapshot-store.js";
import {
  acquireBrowserWriterLock,
  type BrowserWriterLockResult,
} from "./writer-lock.js";

export type WriterLockMode = "required" | "disabled";

export interface SqlJsDriverOptions {
  readonly store: SnapshotStore;
  readonly locateFile?: (file: string) => string;
  readonly debounceMs?: number;
  /**
   * Ceiling on how long a write can sit only in memory. The debounce coalesces
   * bursts, but a continuous write stream (a streaming AI reply, a bulk import,
   * a multi-page pull) shorter than `debounceMs` between writes would otherwise
   * starve the persist indefinitely. Once the oldest un-persisted write is this
   * old, a snapshot is forced even while writes continue. Default 2000ms.
   */
  readonly maxWaitMs?: number;
  readonly onPersistError?: (error: unknown) => void;
  /**
   * Whole-database snapshots require one writer. Browser consumers should keep
   * the default ("required"); tests and non-browser tooling may opt out.
   */
  readonly writerLock?: WriterLockMode;
  /** Test seam for the Web Locks API. */
  readonly acquireWriterLock?: (
    name: string,
  ) => Promise<BrowserWriterLockResult>;
}

interface OpenDb {
  readonly db: Database;
  readonly store: SnapshotStore;
  readonly onPersistError?: (error: unknown) => void;
  readonly releaseWriterLock?: () => Promise<void>;
}

const registry = new Map<string, OpenDb>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
// When the oldest un-persisted write for each db happened, so the debounce can
// be capped at a max-wait ceiling instead of being re-armed forever.
const firstDirtyAt = new Map<string, number>();
const persistQueues = new Map<string, Promise<void>>();
let lastOpened: string | null = null;
let sqlStaticPromise: Promise<SqlJsStatic> | null = null;
let hideFlushRegistered = false;

// Flush every open db to its snapshot store when the page is hidden or being
// unloaded, so a tab closed inside the debounce window doesn't lose the row
// (and its outbox marker) that only lived in memory. Best-effort: the browser
// may not finish an async IndexedDB write during unload — visibilitychange
// (hidden) fires earlier and more reliably than pagehide, so both are wired.
function registerHideFlush(): void {
  if (hideFlushRegistered) return;
  if (typeof document === "undefined" || typeof document.addEventListener !== "function") {
    return;
  }
  hideFlushRegistered = true;
  const flush = () => {
    if (registry.size === 0) return;
    void persistNow().catch(() => undefined);
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
  if (typeof addEventListener === "function") {
    addEventListener("pagehide", flush);
  }
}

export function getActiveDb(name?: string): Database | null {
  const key = name ?? lastOpened;
  return key ? (registry.get(key)?.db ?? null) : null;
}

export async function persistNow(name?: string): Promise<void> {
  const names = name ? [name] : [...registry.keys()];
  for (const key of names) {
    const timer = debounceTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      debounceTimers.delete(key);
    }
    firstDirtyAt.delete(key);
    const open = registry.get(key);
    if (!open) continue;

    // Capture at call time, then serialize saves so an older async IndexedDB
    // write can never finish after (and overwrite) a newer snapshot.
    const bytes = open.db.export();
    const prior = persistQueues.get(key) ?? Promise.resolve();
    const queued = prior.then(() => open.store.save(key, bytes));
    persistQueues.set(key, queued);
    try {
      await queued;
    } finally {
      if (persistQueues.get(key) === queued) persistQueues.delete(key);
    }
  }
}

export async function closeSqlJsDatabases(name?: string): Promise<void> {
  const names = name ? [name] : [...registry.keys()];
  await persistNow(name);
  for (const key of names) {
    registry.get(key)?.db.close();
    await registry.get(key)?.releaseWriterLock?.();
    registry.delete(key);
    debounceTimers.delete(key);
    firstDirtyAt.delete(key);
    persistQueues.delete(key);
    if (lastOpened === key) lastOpened = null;
  }
}

function schedulePersist(name: string, debounceMs: number, maxWaitMs: number): void {
  const now = Date.now();
  let dirtySince = firstDirtyAt.get(name);
  if (dirtySince === undefined) {
    dirtySince = now;
    firstDirtyAt.set(name, now);
  }
  const existing = debounceTimers.get(name);
  if (existing !== undefined) clearTimeout(existing);
  // Debounce to coalesce a burst, but never past the max-wait ceiling measured
  // from the oldest un-persisted write — otherwise a continuous stream re-arms
  // the timer forever and the writes never reach durable storage.
  const delay = Math.max(0, Math.min(debounceMs, dirtySince + maxWaitMs - now));
  debounceTimers.set(
    name,
    setTimeout(() => {
      debounceTimers.delete(name);
      const open = registry.get(name);
      void persistNow(name).catch((error) => {
        open?.onPersistError?.(error);
      });
    }, delay),
  );
}

/**
 * Creates the synchronous SQLite driver required by SimplySync using sql.js.
 *
 * ponytail: this snapshots the whole database to IndexedDB after writes; move to
 * an async OPFS driver only when measured database size or write latency demands
 * an engine-wide async storage API.
 */
export function createSqlJsDriverFactory(
  options: SqlJsDriverOptions,
): (name: string) => Promise<SqliteDriver> {
  const debounceMs = options.debounceMs ?? 250;
  const maxWaitMs = options.maxWaitMs ?? 2000;
  const writerLock = options.writerLock ?? "required";
  const acquireWriterLock =
    options.acquireWriterLock ?? acquireBrowserWriterLock;

  return async (name: string): Promise<SqliteDriver> => {
    if (registry.has(name)) {
      throw new Error(`SimplySync database ${name} is already open in this page.`);
    }

    let releaseWriterLock: (() => Promise<void>) | undefined;
    if (writerLock !== "disabled") {
      const lock = await acquireWriterLock(name);
      if (lock.acquired) {
        releaseWriterLock = lock.release;
      } else {
        const detail =
          lock.reason === "held"
            ? "another tab or window is already using it"
            : "this browser does not provide the Web Locks API";
        throw new Error(
          `Cannot open SimplySync database ${name}: ${detail}.`,
        );
      }
    }

    sqlStaticPromise ??= initSqlJs(
      options.locateFile ? { locateFile: options.locateFile } : undefined,
    );
    let db: Database;
    try {
      const SQL = await sqlStaticPromise;
      const prior = await options.store.load(name);
      db = prior ? new SQL.Database(prior) : new SQL.Database();
      registry.set(name, {
        db,
        store: options.store,
        onPersistError: options.onPersistError,
        releaseWriterLock,
      });
      lastOpened = name;
      registerHideFlush();
    } catch (error) {
      await releaseWriterLock?.();
      throw error;
    }

    return {
      exec(sql, params) {
        db.run(sql, (params ?? []) as BindParams);
        schedulePersist(name, debounceMs, maxWaitMs);
      },
      select<R = Record<string, unknown>>(
        sql: string,
        params?: readonly unknown[],
      ): R[] {
        const statement = db.prepare(sql);
        try {
          if (params && params.length > 0) statement.bind(params as BindParams);
          const rows: Record<string, unknown>[] = [];
          while (statement.step()) rows.push(statement.getAsObject());
          return rows as R[];
        } finally {
          statement.free();
        }
      },
      transaction<T>(fn: () => T): T {
        db.run("BEGIN");
        try {
          const result = fn();
          db.run("COMMIT");
          schedulePersist(name, debounceMs, maxWaitMs);
          return result;
        } catch (error) {
          db.run("ROLLBACK");
          throw error;
        }
      },
    };
  };
}
