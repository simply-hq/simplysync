import type { SecureStorage } from "@simplysync/engine";
import type { SecureStoreOptions } from "expo-secure-store";

export interface ExpoSecureStoreApi {
  getItemAsync(
    key: string,
    options?: SecureStoreOptions,
  ): Promise<string | null>;
  setItemAsync(
    key: string,
    value: string,
    options?: SecureStoreOptions,
  ): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
}

export interface ExpoSecureStorageOptions {
  /**
   * Namespaces engine credentials without changing the engine's own
   * per-database keys. Default: `simplysync.`.
   */
  readonly keyPrefix?: string;
  readonly secureStoreOptions?: SecureStoreOptions;
}

const secureStoreKeyPattern = /^[a-zA-Z0-9._-]+$/u;
const encodedKeyPrefix = "simplysync.encoded.";

function expoSecureStoreKey(value: string): string {
  if (
    secureStoreKeyPattern.test(value) &&
    !value.startsWith(encodedKeyPrefix)
  ) {
    return value;
  }

  // Expo SecureStore rejects `:` and every other character outside its small
  // portable key alphabet. Encode the full namespaced key without touching
  // already-valid keys (notably existing SQLCipher keys). Reserving the prefix
  // keeps an encoded key distinct from every valid raw key.
  const codePoints = Array.from(
    value,
    (character) => character.codePointAt(0)?.toString(16) ?? "0",
  );
  return `${encodedKeyPrefix}${codePoints.join(".")}`;
}

/** Adapts Expo SecureStore to the engine's platform-neutral storage contract. */
export function createExpoSecureStorage(
  secureStore: ExpoSecureStoreApi,
  options: ExpoSecureStorageOptions = {},
): SecureStorage {
  const prefix = options.keyPrefix ?? "simplysync.";
  const key = (value: string) => expoSecureStoreKey(`${prefix}${value}`);

  return {
    getItem(value) {
      return secureStore.getItemAsync(key(value), options.secureStoreOptions);
    },
    setItem(value, next) {
      return secureStore.setItemAsync(
        key(value),
        next,
        options.secureStoreOptions,
      );
    },
    removeItem(value) {
      return secureStore.deleteItemAsync(key(value), options.secureStoreOptions);
    },
  };
}
