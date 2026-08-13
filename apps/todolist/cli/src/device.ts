// A todo "device": the engine wired to Bun's SQLite and a file-backed secret
// store. This is the whole platform-integration surface — everything else in
// this directory is ordinary app code that would be identical in a browser or
// on a phone.

import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  createSync,
  type Query,
  type SecureStorage,
  type SqliteDriver,
  type SyncEngine,
} from "@simplysync/engine";
import { deriveIdentity } from "@simplysync/protocol";
import { todoSchema, type TodoRow, type TodoSchema } from "./schema";

export type TodoEngine = SyncEngine<TodoSchema>;

function bunSqliteDriver(path: string): SqliteDriver {
  const db = new Database(path, { create: true });
  return {
    exec(sql, params) {
      db.prepare(sql).run(...((params ?? []) as never[]));
    },
    select(sql, params) {
      return db.prepare(sql).all(...((params ?? []) as never[])) as never;
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}

/**
 * A JSON file standing in for the OS keychain, so a CLI device survives restarts.
 * Real apps use the platform secret store (`expo-secure-store`,
 * `@simplysync/browser`'s encrypted storage) — a plain file is fine for a local
 * demo and nowhere else: it holds the key that decrypts everything.
 */
function fileSecureStorage(path: string): SecureStorage {
  const read = (): Record<string, string> => {
    if (!existsSync(path)) return {};
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.values(parsed).some((value) => typeof value !== "string")
      ) {
        throw new Error("expected an object of string values");
      }
      return parsed as Record<string, string>;
    } catch (error) {
      throw new Error(
        `cannot read device secrets at ${path}; refusing to mint a replacement owner`,
        { cause: error },
      );
    }
  };
  const write = (values: Record<string, string>): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(values, null, 2), { mode: 0o600 });
  };
  return {
    getItem: (key) => read()[key] ?? null,
    setItem: (key, value) => {
      write({ ...read(), [key]: value });
    },
    removeItem: (key) => {
      const values = read();
      delete values[key];
      write(values);
    },
  };
}

export interface DeviceOptions {
  readonly name: string;
  readonly dataDir: string;
  readonly relayUrl?: string;
  /**
   * Join an existing owner instead of minting a new one. Seeded directly into
   * secure storage under the engine's own key, which is how every platform
   * adopts a shared owner (see the Kotlin live test for the same trick).
   */
  readonly recoveryKey?: string;
}

export async function openDevice(options: DeviceOptions): Promise<TodoEngine> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(options.name)) {
    throw new Error(
      "device names may contain only letters, numbers, hyphens, and underscores",
    );
  }
  mkdirSync(options.dataDir, { recursive: true });
  const secureStorage = fileSecureStorage(
    `${options.dataDir}/${options.name}.secrets.json`,
  );
  const mnemonicKey = `${options.name}:mnemonic`;
  const databasePath = `${options.dataDir}/${options.name}.db`;
  const existing = await secureStorage.getItem(mnemonicKey);
  if (existsSync(databasePath) && !existing) {
    throw new Error(
      `device ${options.name} has local data but no recovery key; choose a new --device name`,
    );
  }
  if (options.recoveryKey) {
    const suppliedIdentity = await deriveIdentity(options.recoveryKey);
    if (existing) {
      const existingIdentity = await deriveIdentity(existing);
      if (existingIdentity.ownerId !== suppliedIdentity.ownerId) {
        throw new Error(
          `device ${options.name} already belongs to another owner; choose a new --device name`,
        );
      }
    }
    await secureStorage.setItem(mnemonicKey, suppliedIdentity.recoveryKey);
  }

  const engine = createSync({
    createSqliteDriver: (name) =>
      bunSqliteDriver(`${options.dataDir}/${name}.db`),
    secureStorage,
  })(todoSchema, {
    name: options.name,
    ...(options.relayUrl
      ? { transports: [{ type: "Http" as const, url: options.relayUrl }] }
      : {}),
    syncIntervalMs: 1000,
  });

  await engine.ready;
  return engine;
}

/**
 * Stop the background sync poller so a short-lived process (a CLI, a script, a
 * test) can exit. The poller is the engine's only long-lived timer, and clearing
 * the transports is what stops it — the disposer `useOwner()` returns does the
 * same thing. Long-running UIs never need this.
 */
export function closeDevice(engine: TodoEngine): void {
  engine.setTransports([]);
}

/** Live, non-deleted todos, newest edit first. Same SQL as Swift and Kotlin. */
const todosQuery = (engine: TodoEngine): Query<TodoRow> =>
  engine.createQuery((db) =>
    db
      .selectFrom("todo")
      .select(["id", "title", "done", "updatedAt"])
      .where("isDeleted", "=", 0)
      .orderBy("updatedAt", "desc"),
  );

export const listTodos = (engine: TodoEngine): Promise<readonly TodoRow[]> =>
  engine.loadQuery(todosQuery(engine));

/**
 * Sync until `predicate` holds, or give up. The engine also polls on its own —
 * this just makes a script deterministic instead of sleep-and-hope.
 */
export async function syncUntil(
  engine: TodoEngine,
  predicate: (rows: readonly TodoRow[]) => boolean,
  attempts = 10,
): Promise<readonly TodoRow[]> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await engine.sync();
    const rows = await listTodos(engine);
    if (predicate(rows)) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return listTodos(engine);
}
