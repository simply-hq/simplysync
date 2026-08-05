import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
} from "node:sqlite";
import type {
  SecureStorage,
  SqliteDriver,
  SyncEngineDeps,
} from "@simplysync/engine";

export interface NodeSqliteDriver extends SqliteDriver {
  readonly path: string;
  close(): void;
}

export interface NodeSqliteDriverOptions {
  /** Milliseconds SQLite waits for another process to release a write lock. */
  readonly busyTimeoutMs?: number;
  /** Enable WAL for file-backed databases. Defaults to true. */
  readonly wal?: boolean;
}

function bindValue(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (ArrayBuffer.isView(value)) return value as SQLInputValue;
  throw new TypeError(`Unsupported SQLite bind value: ${Object.prototype.toString.call(value)}`);
}

/** Open one synchronous `node:sqlite` connection as a SimplySync driver. */
export function createNodeSqliteDriver(
  path: string,
  options: NodeSqliteDriverOptions = {},
): NodeSqliteDriver {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const database = new DatabaseSync(path, {
    enableDoubleQuotedStringLiterals: false,
    enableForeignKeyConstraints: true,
  });
  const timeout = Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000));
  database.exec(`pragma busy_timeout = ${timeout}`);
  if (path !== ":memory:" && options.wal !== false) {
    database.exec("pragma journal_mode = WAL");
  }

  let transactionDepth = 0;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new Error(`SQLite database is closed: ${path}`);
  };

  return {
    path,
    exec(sql, params) {
      assertOpen();
      if (!params?.length) {
        database.exec(sql);
        return;
      }
      database.prepare(sql).run(...params.map(bindValue));
    },
    select<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): R[] {
      assertOpen();
      return database
        .prepare(sql)
        .all(...(params ?? []).map(bindValue))
        .map((row) => ({ ...row })) as R[];
    },
    transaction<T>(fn: () => T): T {
      assertOpen();
      const level = transactionDepth;
      const savepoint = `simplysync_nested_${level}`;
      database.exec(level === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
      transactionDepth += 1;
      try {
        const result = fn();
        database.exec(level === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        if (level === 0) {
          database.exec("ROLLBACK");
        } else {
          database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
        throw error;
      } finally {
        transactionDepth -= 1;
      }
    },
    close() {
      if (closed) return;
      database.close();
      closed = true;
    },
  };
}

export interface NodeSqliteDriverFactoryOptions extends NodeSqliteDriverOptions {
  /** Directory that owns this app's SQLite files. */
  readonly directory: string;
  /** Defaults to `<directory>/<engine-name>.sqlite`. */
  readonly pathForName?: (name: string, directory: string) => string;
}

export interface NodeSqliteDriverFactory {
  (name: string): NodeSqliteDriver;
  close(name?: string): void;
}

/** Build a named-database factory and lifecycle handle for Node/Raycast/CLI apps. */
export function createNodeSqliteDriverFactory(
  options: NodeSqliteDriverFactoryOptions,
): NodeSqliteDriverFactory {
  const directory = resolve(options.directory);
  mkdirSync(directory, { recursive: true });
  const drivers = new Map<string, NodeSqliteDriver>();

  const factory = ((name: string) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(name)) {
      throw new Error(
        "SimplySync engine names may contain only letters, numbers, underscores, and hyphens.",
      );
    }
    const existing = drivers.get(name);
    if (existing) return existing;
    const path = options.pathForName?.(name, directory) ?? join(directory, `${name}.sqlite`);
    const driver = createNodeSqliteDriver(path, options);
    drivers.set(name, driver);
    return driver;
  }) as NodeSqliteDriverFactory;

  factory.close = (name?: string) => {
    if (name) {
      drivers.get(name)?.close();
      drivers.delete(name);
      return;
    }
    for (const driver of drivers.values()) driver.close();
    drivers.clear();
  };

  return factory;
}

/**
 * Minimal encrypted key/value shape used by Raycast LocalStorage and similar
 * host-owned secret stores. The host must encrypt values at rest.
 */
export interface EncryptedStringStore {
  getItem(key: string): unknown | Promise<unknown>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem(key: string): void | Promise<void>;
}

/** Validate a host encrypted key/value store before exposing it to the engine. */
export function createKeyValueSecureStorage(
  storage: EncryptedStringStore,
): SecureStorage {
  return {
    async getItem(key) {
      const value = await storage.getItem(key);
      if (value === undefined || value === null) return null;
      if (typeof value !== "string") {
        throw new Error(`Secure storage value for "${key}" is not a string.`);
      }
      return value;
    },
    async setItem(key, value) {
      await storage.setItem(key, value);
    },
    async removeItem(key) {
      await storage.removeItem(key);
    },
  };
}

export interface NodeSyncDepsOptions extends NodeSqliteDriverFactoryOptions {
  readonly secureStorage: SecureStorage;
  readonly fetch?: typeof fetch;
  readonly reloadApp?: () => void | Promise<void>;
  readonly deriveKeyFromPassphrase?: SyncEngineDeps["deriveKeyFromPassphrase"];
}

export interface NodeSyncDeps extends SyncEngineDeps {
  /** Close one named database, or every database opened through these deps. */
  close(name?: string): void;
}

/** Complete engine plumbing for Node.js 22.13+, including Raycast commands. */
export function createNodeSyncDeps(options: NodeSyncDepsOptions): NodeSyncDeps {
  const createSqliteDriver = createNodeSqliteDriverFactory(options);
  return {
    createSqliteDriver,
    secureStorage: options.secureStorage,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.reloadApp ? { reloadApp: options.reloadApp } : {}),
    ...(options.deriveKeyFromPassphrase
      ? { deriveKeyFromPassphrase: options.deriveKeyFromPassphrase }
      : {}),
    close: createSqliteDriver.close,
  };
}
