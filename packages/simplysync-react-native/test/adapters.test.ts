import { describe, expect, test } from "bun:test";
import {
  configureExpoSqlCipher,
  createExpoSqliteDriver,
  type ExpoSqliteDatabase,
} from "../src/sqlite-driver";
import {
  createExpoSecureStorage,
  type ExpoSecureStoreApi,
} from "../src/secure-storage";

describe("Expo SQLite adapter", () => {
  test("keys and validates a SQLCipher database before use", () => {
    const calls: unknown[][] = [];
    const database = {
      execSync(sql: string) {
        calls.push(["exec", sql]);
      },
      getAllSync(sql: string, params: unknown[]) {
        calls.push(["select", sql, params]);
        return [{ count: 0 }];
      },
    } as ExpoSqliteDatabase;

    configureExpoSqlCipher(database, "device's key");

    expect(calls).toEqual([
      ["exec", "pragma key = 'device''s key';"],
      ["select", "select count(*) as count from sqlite_master", []],
    ]);
  });

  test("routes statements, queries, and transactions through the sync API", () => {
    const calls: unknown[][] = [];
    const database = {
      execSync(sql: string) {
        calls.push(["exec", sql]);
      },
      runSync(sql: string, params: unknown[]) {
        calls.push(["run", sql, params]);
        return { changes: 1, lastInsertRowId: 0 };
      },
      getAllSync<R>(sql: string, params: unknown[]): R[] {
        calls.push(["select", sql, params]);
        return [{ value: "saved" }] as R[];
      },
      withTransactionSync(fn: () => void) {
        calls.push(["begin"]);
        fn();
        calls.push(["commit"]);
      },
    } as ExpoSqliteDatabase;

    const driver = createExpoSqliteDriver(database);
    driver.exec("pragma journal_mode = WAL;");
    driver.exec("insert into item (value) values (?)", ["saved"]);
    expect(driver.select<{ value: string }>(
      "select value from item where id = ?",
      [1],
    )).toEqual([{ value: "saved" }]);
    expect(driver.transaction(() => 42)).toBe(42);

    expect(calls).toEqual([
      ["exec", "pragma journal_mode = WAL;"],
      ["run", "insert into item (value) values (?)", ["saved"]],
      ["select", "select value from item where id = ?", [1]],
      ["begin"],
      ["commit"],
    ]);
  });

  test("rejects values Expo SQLite cannot bind", () => {
    const database = {
      execSync() {},
      runSync() {
        return { changes: 0, lastInsertRowId: 0 };
      },
      getAllSync() {
        return [];
      },
      withTransactionSync(fn: () => void) {
        fn();
      },
    } as unknown as ExpoSqliteDatabase;
    const driver = createExpoSqliteDriver(database);

    expect(() => driver.exec("select ?", [{ unsafe: true }])).toThrow(
      "cannot bind",
    );
  });
});

describe("Expo SecureStore adapter", () => {
  test("namespaces keys and forwards secure-store options", async () => {
    const calls: unknown[][] = [];
    const secureStore: ExpoSecureStoreApi = {
      async getItemAsync(key, options) {
        calls.push(["get", key, options]);
        return "secret";
      },
      async setItemAsync(key, value, options) {
        calls.push(["set", key, value, options]);
      },
      async deleteItemAsync(key, options) {
        calls.push(["delete", key, options]);
      },
    };
    const options = { requireAuthentication: true };
    const storage = createExpoSecureStorage(secureStore, {
      keyPrefix: "app.",
      secureStoreOptions: options,
    });

    expect(await storage.getItem("owner")).toBe("secret");
    await storage.setItem("owner", "next");
    await storage.removeItem("owner");

    expect(calls).toEqual([
      ["get", "app.owner", options],
      ["set", "app.owner", "next", options],
      ["delete", "app.owner", options],
    ]);
  });

  test("encodes engine keys that Expo SecureStore rejects", async () => {
    const keys: string[] = [];
    const secureStore: ExpoSecureStoreApi = {
      async getItemAsync(key) {
        keys.push(key);
        return null;
      },
      async setItemAsync(key) {
        keys.push(key);
      },
      async deleteItemAsync(key) {
        keys.push(key);
      },
    };
    const storage = createExpoSecureStorage(secureStore);

    await storage.getItem("my-notes:mnemonic");
    await storage.setItem("my-notes:mnemonic", "secret");
    await storage.removeItem("my-notes:mnemonic");

    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(/^[a-zA-Z0-9._-]+$/u);
    expect(keys[0]?.startsWith("simplysync.encoded.")).toBe(true);
  });
});
