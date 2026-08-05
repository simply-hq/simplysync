import type { SqliteDriver } from "@simplysync/engine";
import type {
  SQLiteBindParams,
  SQLiteBindValue,
  SQLiteDatabase,
} from "expo-sqlite";

/**
 * The synchronous subset of expo-sqlite used by the engine. Keeping this
 * structural makes the adapter independently testable and lets advanced apps
 * wrap an already-open Expo database.
 */
export type ExpoSqliteDatabase = Pick<
  SQLiteDatabase,
  "execSync" | "getAllSync" | "runSync" | "withTransactionSync"
>;

/**
 * Keys an Expo database built with the `useSQLCipher` config-plugin option.
 * The validation read fails immediately for a wrong key instead of surfacing
 * later as a misleading schema/init error.
 */
export function configureExpoSqlCipher(
  database: ExpoSqliteDatabase,
  key: string,
): void {
  if (!key) throw new Error("SimplySync SQLCipher key must not be empty.");
  database.execSync(`pragma key = '${key.replaceAll("'", "''")}';`);
  database.getAllSync("select count(*) as count from sqlite_master", []);
}

function bindParams(params: readonly unknown[]): SQLiteBindParams {
  return params.map((value): SQLiteBindValue => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError(
      `SimplySync cannot bind ${Object.prototype.toString.call(value)} to Expo SQLite.`,
    );
  });
}

/** Adapts an open Expo SQLite database to the canonical engine driver. */
export function createExpoSqliteDriver(
  database: ExpoSqliteDatabase,
): SqliteDriver {
  return {
    exec(sql, params = []) {
      if (params.length === 0) {
        database.execSync(sql);
        return;
      }
      database.runSync(sql, bindParams(params));
    },
    select<R>(sql: string, params: readonly unknown[] = []): R[] {
      return database.getAllSync<R>(sql, bindParams(params));
    },
    transaction<T>(fn: () => T): T {
      let result!: T;
      database.withTransactionSync(() => {
        result = fn();
      });
      return result;
    },
  };
}
