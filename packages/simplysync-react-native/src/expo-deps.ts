import type { SyncEngineDeps } from "@simplysync/engine";
import * as SecureStore from "expo-secure-store";
import {
  openDatabaseSync,
  type SQLiteOpenOptions,
} from "expo-sqlite";
import { pbkdf2Sync } from "react-native-quick-crypto";
import {
  createExpoSecureStorage,
  type ExpoSecureStoreApi,
  type ExpoSecureStorageOptions,
} from "./secure-storage.js";
import {
  configureExpoSqlCipher,
  createExpoSqliteDriver,
} from "./sqlite-driver.js";

export type ExpoDatabaseKeyProvider = (
  engineName: string,
) => string | Promise<string>;

export interface ExpoSqliteDriverFactoryOptions {
  /**
   * Maps an engine name to a file name. The default keeps only portable file
   * name characters and appends `.db`.
   */
  readonly databaseName?: (engineName: string) => string;
  readonly directory?: string;
  readonly openOptions?: SQLiteOpenOptions;
  /**
   * SQLCipher passphrase applied before the engine reads the database. The
   * Expo app must also enable `expo-sqlite`'s `useSQLCipher` config plugin.
   */
  readonly databaseKey?: string | ExpoDatabaseKeyProvider;
}

export interface ExpoSqlCipherOptions {
  readonly secureStoreOptions?: ExpoSecureStorageOptions["secureStoreOptions"];
}

export interface ExpoSyncDepsOptions {
  readonly sqlite?: ExpoSqliteDriverFactoryOptions;
  readonly secureStorage?: ExpoSecureStorageOptions;
  /**
   * Generates and retains a different random SQLCipher passphrase per engine.
   * Requires `["expo-sqlite", { "useSQLCipher": true }]` in app config.
   */
  readonly sqlCipher?: ExpoSqlCipherOptions;
  readonly fetch?: typeof fetch;
  /**
   * Owner restore/reset needs an app-level reload. Pass Expo Updates'
   * `reloadAsync`, or another production-safe reload function.
   */
  readonly reloadApp?: () => void | Promise<void>;
}

function defaultDatabaseName(engineName: string): string {
  const safe = engineName.trim().replace(/[^a-zA-Z0-9._-]+/gu, "-");
  if (!safe) throw new Error("SimplySync database name must not be empty.");
  return safe.endsWith(".db") ? safe : `${safe}.db`;
}

/** Creates the driver factory expected by `createSync`. */
export function createExpoSqliteDriverFactory(
  options: ExpoSqliteDriverFactoryOptions = {},
): SyncEngineDeps["createSqliteDriver"] {
  const resolveName = options.databaseName ?? defaultDatabaseName;
  return async (engineName) => {
    const databaseKey = typeof options.databaseKey === "function"
      ? await options.databaseKey(engineName)
      : options.databaseKey;
    const database = openDatabaseSync(
      resolveName(engineName),
      options.openOptions,
      options.directory,
    );
    if (databaseKey !== undefined) {
      configureExpoSqlCipher(database, databaseKey);
    }
    return createExpoSqliteDriver(database);
  };
}

/** SecureStore-backed SQLCipher key provider: one random 32-byte key per engine. */
function createExpoSqlCipherKeyProvider(
  secureStore: ExpoSecureStoreApi,
  options: ExpoSqlCipherOptions = {},
): ExpoDatabaseKeyProvider {
  const storage = createExpoSecureStorage(secureStore, {
    keyPrefix: "simplysync.sqlcipher.",
    secureStoreOptions: options.secureStoreOptions,
  });

  return async (engineName) => {
    const storageKey = `database.${defaultDatabaseName(engineName)}`;
    const existing = await storage.getItem(storageKey);
    if (existing) return existing;

    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const generated = Array.from(
      bytes,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    await storage.setItem(storageKey, generated);
    return generated;
  };
}

/**
 * Complete Expo plumbing for the canonical engine: persistent SQLite,
 * Keychain/Keystore-backed owner credentials, native fetch, and native PBKDF2
 * for encrypted database exports.
 */
export function createExpoSyncDeps(
  options: ExpoSyncDepsOptions = {},
): SyncEngineDeps {
  if (options.sqlCipher && options.sqlite?.databaseKey !== undefined) {
    throw new Error(
      "Choose sqlCipher or sqlite.databaseKey; do not configure both.",
    );
  }
  const databaseKey = options.sqlCipher
    ? createExpoSqlCipherKeyProvider(SecureStore, options.sqlCipher)
    : options.sqlite?.databaseKey;

  return {
    createSqliteDriver: createExpoSqliteDriverFactory({
      ...options.sqlite,
      databaseKey,
    }),
    secureStorage: createExpoSecureStorage(
      SecureStore,
      options.secureStorage,
    ),
    fetch: options.fetch,
    reloadApp: options.reloadApp,
    deriveKeyFromPassphrase(
      passphrase,
      salt,
      iterations,
      keyBytes,
    ): Uint8Array {
      const result = pbkdf2Sync(
        passphrase,
        salt,
        iterations,
        keyBytes,
        "sha256",
      );
      return Uint8Array.from(result);
    },
  };
}
