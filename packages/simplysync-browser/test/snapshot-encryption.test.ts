import { describe, expect, test } from "bun:test";
import type { BrowserKeyValueStore, BrowserStoreName } from "../src/indexed-db";
import { createEncryptedSecureStorage } from "../src/secure-storage";
import { createIndexedDbSnapshotStore } from "../src/snapshot-store";

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

// What sql.js hands the store: a SQLite image, whose header doubles as the
// plaintext marker the loader relies on.
const snapshot = (): Uint8Array =>
  new TextEncoder().encode("SQLite format 3\0 plus some row bytes 0123456789");

const stored = (backing: MemoryStore, name: string): Uint8Array =>
  backing.values.get(`snapshots:${name}`) as Uint8Array;

const containsPlaintext = (bytes: Uint8Array): boolean =>
  new TextDecoder().decode(bytes).includes("SQLite format 3");

describe("encrypted snapshot store", () => {
  test("round-trips, and the stored bytes are not the plaintext", async () => {
    const backing = new MemoryStore();
    const snapshots = createIndexedDbSnapshotStore({ store: backing });
    await snapshots.save("app", snapshot());

    expect(containsPlaintext(stored(backing, "app"))).toBe(false);
    expect(await snapshots.load("app")).toEqual(snapshot());
    // A fresh store instance reopens the persisted non-extractable key.
    expect(
      await createIndexedDbSnapshotStore({ store: backing }).load("app"),
    ).toEqual(snapshot());
  });

  test("a legacy plaintext snapshot loads, and the next save encrypts it", async () => {
    const backing = new MemoryStore();
    await backing.set("snapshots", "app", snapshot());
    const snapshots = createIndexedDbSnapshotStore({ store: backing });

    expect(await snapshots.load("app")).toEqual(snapshot());
    await snapshots.save("app", snapshot());
    expect(containsPlaintext(stored(backing, "app"))).toBe(false);
    expect(await snapshots.load("app")).toEqual(snapshot());
  });

  test("encrypt: false keeps the plaintext layout", async () => {
    const backing = new MemoryStore();
    const snapshots = createIndexedDbSnapshotStore({ store: backing, encrypt: false });
    await snapshots.save("app", snapshot());
    expect(stored(backing, "app")).toEqual(snapshot());
    expect(await snapshots.load("app")).toEqual(snapshot());
  });

  test("shares the master key with the encrypted secure storage", async () => {
    const backing = new MemoryStore();
    await createEncryptedSecureStorage({ store: backing }).setItem("k", "v");
    await createIndexedDbSnapshotStore({ store: backing }).save("app", snapshot());
    const keys = [...backing.values.keys()].filter((k) => k.startsWith("keys:"));
    expect(keys).toEqual(["keys:simplysync-browser-master-key"]);
  });

  test("a snapshot saved under one name does not decrypt under another", async () => {
    const backing = new MemoryStore();
    const snapshots = createIndexedDbSnapshotStore({ store: backing });
    await snapshots.save("app", snapshot());
    await backing.set("snapshots", "other", stored(backing, "app"));
    await expect(snapshots.load("other")).rejects.toThrow(/Could not decrypt/);
  });
});
