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
  /**
   * Encrypt the snapshot at rest (default `true`). The sql.js database is the
   * owner's whole plaintext dataset, so an unencrypted IndexedDB entry is
   * readable by anything with profile-directory access — the same exposure the
   * recovery key already gets protected from by `createEncryptedSecureStorage`.
   * Default-on means an existing app gains at-rest encryption on its next
   * release with no code change: a legacy plaintext snapshot still loads, and
   * the next save rewrites it encrypted. Set `false` to keep plaintext.
   */
  readonly encrypt?: boolean;
  /** Key name in the "keys" store; defaults to the secure storage's master key. */
  readonly keyName?: string;
}

// Encrypted snapshot layout: MAGIC ‖ 12-byte nonce ‖ AES-256-GCM ciphertext.
// A SQLite file starts with "SQLite format 3\0", so the magic also tells a
// legacy plaintext snapshot apart with no version column in IndexedDB.
const MAGIC = new TextEncoder().encode("SSSE1");
const NONCE_BYTES = 12;

function hasMagic(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length + NONCE_BYTES) return false;
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (bytes[i] !== MAGIC[i]) return false;
  }
  return true;
}

export function createIndexedDbSnapshotStore(
  options: IndexedDbSnapshotStoreOptions = {},
): IndexedDbSnapshotStore {
  const store =
    options.store ??
    createIndexedDbKeyValueStore(options.databaseName ?? "simplysync-browser");
  const encrypt = options.encrypt !== false;
  const crypto = globalThis.crypto;
  // Same non-extractable master key as createEncryptedSecureStorage, so one
  // key in the "keys" store covers both the secret and the snapshot.
  const keyName = options.keyName ?? "simplysync-browser-master-key";
  const encoder = new TextEncoder();
  let keyPromise: Promise<CryptoKey> | null = null;

  const encryptionKey = (): Promise<CryptoKey> => {
    keyPromise ??= (async () => {
      const existing = await store.get<CryptoKey>("keys", keyName);
      if (existing) return existing;

      const created = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      await store.set("keys", keyName, created);
      return created;
    })();
    return keyPromise;
  };

  return {
    async load(name) {
      const value = await store.get<Uint8Array | ArrayBuffer>("snapshots", name);
      if (!value) return null;
      const bytes =
        value instanceof Uint8Array ? value.slice() : new Uint8Array(value.slice(0));
      // Legacy plaintext snapshots load unchanged; the next save encrypts them.
      if (!hasMagic(bytes)) return bytes;
      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: bytes.subarray(MAGIC.length, MAGIC.length + NONCE_BYTES),
            additionalData: encoder.encode(name),
          },
          await encryptionKey(),
          bytes.subarray(MAGIC.length + NONCE_BYTES),
        );
        return new Uint8Array(plaintext);
      } catch (error) {
        throw new Error(`Could not decrypt the browser snapshot ${name}.`, {
          cause: error,
        });
      }
    },

    async save(name, bytes) {
      if (!encrypt) return store.set("snapshots", name, bytes.slice());
      const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(name) },
        await encryptionKey(),
        // A tight copy: sql.js may hand a view over a larger (or shared) buffer.
        bytes.slice().buffer as ArrayBuffer,
      );
      const sealed = new Uint8Array(MAGIC.length + NONCE_BYTES + ciphertext.byteLength);
      sealed.set(MAGIC, 0);
      sealed.set(nonce, MAGIC.length);
      sealed.set(new Uint8Array(ciphertext), MAGIC.length + NONCE_BYTES);
      return store.set("snapshots", name, sealed);
    },

    clear(name) {
      return name
        ? store.delete("snapshots", name)
        : store.clear("snapshots");
    },
  };
}
