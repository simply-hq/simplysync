// In-memory stand-ins for the browser's IndexedDB + localStorage, shared by
// the web contract/smoke tests and the e2e web-host runner.
import type { SnapshotStore } from "@simplysync/browser";
import type { SecureStorage } from "@simplysync/engine";

export function memorySnapshotStore(): SnapshotStore & {
  snapshots: Map<string, Uint8Array>;
} {
  const snapshots = new Map<string, Uint8Array>();
  return {
    snapshots,
    async load(name) {
      return snapshots.get(name) ?? null;
    },
    async save(name, bytes) {
      snapshots.set(name, bytes);
    },
  };
}

export function memorySecureStorage(
  entries?: Iterable<[string, string]>,
): SecureStorage {
  const values = new Map<string, string>(entries);
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}
