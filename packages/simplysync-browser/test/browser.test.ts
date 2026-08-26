import { describe, expect, test } from "bun:test";
import type { SecureStorage } from "@simplysync/engine";
import { createMnemonic } from "@simplysync/protocol";
import type {
  BrowserKeyValueStore,
  BrowserStoreName,
} from "../src/indexed-db";
import {
  createBrowserOwnerStore,
  deriveBrowserAppOwner,
} from "../src/owner";
import { createEncryptedSecureStorage } from "../src/secure-storage";
import { createIndexedDbSnapshotStore } from "../src/snapshot-store";
import {
  closeSqlJsDatabases,
  createSqlJsDriverFactory,
  persistNow,
} from "../src/sql-js-driver";
import { acquireWriterLock } from "../src/writer-lock";

class MemoryStore implements BrowserKeyValueStore {
  readonly values = new Map<string, unknown>();

  private id(store: BrowserStoreName, key: string): string {
    return `${store}:${key}`;
  }

  async get<T>(store: BrowserStoreName, key: string): Promise<T | null> {
    return (this.values.get(this.id(store, key)) as T | undefined) ?? null;
  }

  async set(store: BrowserStoreName, key: string, value: unknown): Promise<void> {
    this.values.set(this.id(store, key), structuredClone(value));
  }

  async delete(store: BrowserStoreName, key: string): Promise<void> {
    this.values.delete(this.id(store, key));
  }

  async clear(store: BrowserStoreName): Promise<void> {
    for (const key of this.values.keys()) {
      if (key.startsWith(`${store}:`)) this.values.delete(key);
    }
  }
}

class FakeLockManager {
  private held = false;

  request(
    _name: string,
    _options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<void>,
  ): Promise<void> {
    if (this.held) return callback(null);
    this.held = true;
    return callback({}).finally(() => {
      this.held = false;
    });
  }
}

function memorySecureStorage(): SecureStorage & {
  readonly values: Map<string, string>;
} {
  const values = new Map<string, string>();
  return {
    values,
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };
}

describe("browser owner recovery", () => {
  test("creates a stable sf1_ key and derives an app owner", async () => {
    const secureStorage = memorySecureStorage();
    const ownerStore = createBrowserOwnerStore(secureStorage);

    const first = await ownerStore.loadOrCreateRecoveryKey();
    const second = await ownerStore.loadOrCreateRecoveryKey();
    expect(first.startsWith("sf1_")).toBe(true);
    expect(second).toBe(first);

    const owner = await deriveBrowserAppOwner(first);
    expect(owner.recoveryKey).toBe(first);
    expect(owner.id.length).toBeGreaterThan(0);
    expect(owner.writeKey.length).toBeGreaterThan(0);
  });

  test("accepts both recovery forms and never replaces invalid stored data", async () => {
    const secureStorage = memorySecureStorage();
    const ownerStore = createBrowserOwnerStore(secureStorage, {
      key: "test:recovery",
    });
    const phrase = createMnemonic();

    expect(await ownerStore.setRecoveryKey(phrase)).toBe(phrase);
    expect((await deriveBrowserAppOwner(phrase)).mnemonic).toBe(phrase);

    await secureStorage.setItem("test:recovery", "corrupted owner credential");
    await expect(ownerStore.loadOrCreateRecoveryKey()).rejects.toThrow(
      "refusing to replace its owner",
    );
    expect(await secureStorage.getItem("test:recovery")).toBe(
      "corrupted owner credential",
    );
  });
});

describe("encrypted browser storage", () => {
  test("round-trips without storing plaintext", async () => {
    const store = new MemoryStore();
    const secure = createEncryptedSecureStorage({ store });

    await secure.setItem("finance:mnemonic", "secret recovery words");

    expect(await secure.getItem("finance:mnemonic")).toBe("secret recovery words");
    expect(JSON.stringify(store.values.get("secrets:finance:mnemonic"))).not.toContain(
      "secret recovery words",
    );

    await secure.removeItem("finance:mnemonic");
    expect(await secure.getItem("finance:mnemonic")).toBeNull();
  });
});

describe("snapshot-backed sql.js", () => {
  test("persists committed writes and rolls back failed transactions", async () => {
    const backing = new MemoryStore();
    const snapshots = createIndexedDbSnapshotStore({ store: backing });
    const createDriver = createSqlJsDriverFactory({
      store: snapshots,
      debounceMs: 0,
      writerLock: "disabled",
    });
    const first = await createDriver("finance-test");

    first.exec("create table entry (id text primary key, amount integer not null)");
    first.exec("insert into entry values (?, ?)", ["one", 100]);
    expect(() =>
      first.transaction(() => {
        first.exec("insert into entry values (?, ?)", ["two", 200]);
        throw new Error("stop");
      }),
    ).toThrow("stop");
    await persistNow("finance-test");
    await closeSqlJsDatabases("finance-test");

    const reopened = await createDriver("finance-test");
    expect(reopened.select("select * from entry order by id")).toEqual([
      { id: "one", amount: 100 },
    ]);
    await closeSqlJsDatabases("finance-test");
  });

  test("forces a persist under a continuous write stream (max-wait ceiling)", async () => {
    // A long debounce that, on its own, would never fire while writes keep
    // coming — so any save proves the max-wait ceiling forced one, i.e. a burst
    // of writes can't be starved out of durable storage indefinitely.
    let saves = 0;
    const store = {
      load: async () => null,
      save: async () => {
        saves += 1;
      },
    };
    const createDriver = createSqlJsDriverFactory({
      store,
      debounceMs: 1000,
      maxWaitMs: 40,
      writerLock: "disabled",
    });
    const d = await createDriver("maxwait-test");
    d.exec("create table t (id integer primary key)");
    const start = Date.now();
    let i = 0;
    while (Date.now() - start < 160) {
      d.exec("insert into t values (?)", [i]);
      i += 1;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(saves).toBeGreaterThan(0);
    await closeSqlJsDatabases("maxwait-test");
  });

  test("requires an exclusive browser writer lock by default", async () => {
    const backing = new MemoryStore();
    const snapshots = createIndexedDbSnapshotStore({ store: backing });
    const createDriver = createSqlJsDriverFactory({
      store: snapshots,
      acquireWriterLock: async () => ({ acquired: false, reason: "held" }),
    });

    await expect(createDriver("locked-finance")).rejects.toThrow(
      "another tab or window",
    );
  });
});

describe("single-writer lock", () => {
  test("rejects a second writer until the first releases", async () => {
    const manager = new FakeLockManager();
    const first = await acquireWriterLock("finance", manager);
    expect(first.acquired).toBe(true);
    expect(await acquireWriterLock("finance", manager)).toEqual({
      acquired: false,
      reason: "held",
    });

    if (first.acquired) await first.release();
    const third = await acquireWriterLock("finance", manager);
    expect(third.acquired).toBe(true);
    if (third.acquired) await third.release();
  });
});
