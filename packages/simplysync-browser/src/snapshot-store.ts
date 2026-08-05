import { createIndexedDbKeyValueStore, type BrowserKeyValueStore } from "./indexed-db.js";

export interface SnapshotStore {
  load(name: string): Promise<Uint8Array | null>;
  save(name: string, bytes: Uint8Array): Promise<void>;
}

export interface IndexedDbSnapshotStore extends SnapshotStore {
  clear(name?: string): Promise<void>;
}

export interface IndexedDbSnapshotStoreOptions {
  readonly databaseName?: string;
  readonly store?: BrowserKeyValueStore;
}

export function createIndexedDbSnapshotStore(
  options: IndexedDbSnapshotStoreOptions = {},
): IndexedDbSnapshotStore {
  const store =
    options.store ??
    createIndexedDbKeyValueStore(options.databaseName ?? "simplysync-browser");

  return {
    async load(name) {
      const value = await store.get<Uint8Array | ArrayBuffer>("snapshots", name);
      if (!value) return null;
      return value instanceof Uint8Array
        ? value.slice()
        : new Uint8Array(value.slice(0));
    },
    save(name, bytes) {
      return store.set("snapshots", name, bytes.slice());
    },
    clear(name) {
      return name
        ? store.delete("snapshots", name)
        : store.clear("snapshots");
    },
  };
}
