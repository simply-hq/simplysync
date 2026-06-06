// A tiny IndexedDB key/value store, just enough to snapshot the sql.js database
// between page loads. One object store ("snapshots"); the key is the database
// name and the value is the raw `db.export()` bytes. No dependencies.

const DB_NAME = "simplysync-playground";
const STORE = "snapshots";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Loads a previously saved database snapshot, or null if there is none. */
export async function load(name: string): Promise<Uint8Array | null> {
  const db = await openDb();
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const request = db.transaction(STORE, "readonly").objectStore(STORE).get(name);
      request.onsuccess = () => {
        const value = request.result as Uint8Array | undefined;
        resolve(value ?? null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

/** Saves (overwrites) the snapshot for a database name. */
export async function save(name: string, bytes: Uint8Array): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(bytes, name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
