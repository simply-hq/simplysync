export type BrowserStoreName = "snapshots" | "secrets" | "keys";

export interface BrowserKeyValueStore {
  get<T>(store: BrowserStoreName, key: string): Promise<T | null>;
  set(store: BrowserStoreName, key: string, value: unknown): Promise<void>;
  delete(store: BrowserStoreName, key: string): Promise<void>;
  clear(store: BrowserStoreName): Promise<void>;
}

const DB_VERSION = 2;
const STORES: readonly BrowserStoreName[] = ["snapshots", "secrets", "keys"];

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Could not open IndexedDB ${name}.`));
    request.onblocked = () => reject(new Error(`IndexedDB ${name} is blocked by another page.`));
  });
}

export function createIndexedDbKeyValueStore(name: string): BrowserKeyValueStore {
  return {
    async get<T>(store: BrowserStoreName, key: string) {
      const db = await openDatabase(name);
      try {
        return await new Promise<T | null>((resolve, reject) => {
          const request = db.transaction(store, "readonly").objectStore(store).get(key);
          request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
          request.onerror = () => reject(request.error);
        });
      } finally {
        db.close();
      }
    },

    async set(store: BrowserStoreName, key: string, value: unknown) {
      const db = await openDatabase(name);
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(store, "readwrite");
          transaction.objectStore(store).put(value, key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted."));
        });
      } finally {
        db.close();
      }
    },

    async delete(store: BrowserStoreName, key: string) {
      const db = await openDatabase(name);
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(store, "readwrite");
          transaction.objectStore(store).delete(key);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB delete aborted."));
        });
      } finally {
        db.close();
      }
    },

    async clear(store: BrowserStoreName) {
      const db = await openDatabase(name);
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(store, "readwrite");
          transaction.objectStore(store).clear();
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB clear aborted."));
        });
      } finally {
        db.close();
      }
    },
  };
}
