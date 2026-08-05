import type { SecureStorage } from "@simplysync/engine";
import { createIndexedDbKeyValueStore, type BrowserKeyValueStore } from "./indexed-db.js";

interface EncryptedValue {
  readonly version: 1;
  readonly iv: ArrayBuffer;
  readonly ciphertext: ArrayBuffer;
}

export interface EncryptedSecureStorageOptions {
  readonly databaseName?: string;
  readonly keyName?: string;
  readonly store?: BrowserKeyValueStore;
  readonly crypto?: Crypto;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createEncryptedSecureStorage(
  options: EncryptedSecureStorageOptions = {},
): SecureStorage {
  const store =
    options.store ??
    createIndexedDbKeyValueStore(options.databaseName ?? "simplysync-browser");
  const crypto = options.crypto ?? globalThis.crypto;
  const keyName = options.keyName ?? "simplysync-browser-master-key";
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
    async getItem(key) {
      const encrypted = await store.get<EncryptedValue>("secrets", key);
      if (!encrypted) return null;
      if (encrypted.version !== 1) {
        throw new Error(`Unsupported encrypted browser storage version for ${key}.`);
      }

      try {
        const plaintext = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: encrypted.iv,
            additionalData: encoder.encode(key),
          },
          await encryptionKey(),
          encrypted.ciphertext,
        );
        return decoder.decode(plaintext);
      } catch (error) {
        throw new Error(`Could not decrypt secure browser storage for ${key}.`, {
          cause: error,
        });
      }
    },

    async setItem(key, value) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: "AES-GCM",
          iv,
          additionalData: encoder.encode(key),
        },
        await encryptionKey(),
        encoder.encode(value),
      );
      await store.set("secrets", key, {
        version: 1,
        iv: iv.buffer.slice(iv.byteOffset, iv.byteOffset + iv.byteLength),
        ciphertext,
      } satisfies EncryptedValue);
    },

    removeItem(key) {
      return store.delete("secrets", key);
    },
  };
}
