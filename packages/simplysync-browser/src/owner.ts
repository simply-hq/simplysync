import type { AppOwner, SecureStorage } from "@simplysync/engine";
import {
  createMnemonic,
  createRecoveryKey,
  deriveIdentity,
  isRecoveryMnemonic,
  normalizeMnemonic,
} from "@simplysync/protocol";

export interface BrowserOwnerStore {
  /** Loads an sf1_ key or mnemonic, creating a new sf1_ key when absent. */
  loadOrCreateRecoveryKey(): Promise<string>;
  /** Validates and stores either cross-platform recovery credential form. */
  setRecoveryKey(recoveryKey: string): Promise<string>;
  /** Replaces the credential with a newly generated sf1_ key. */
  rotateRecoveryKey(): Promise<string>;
  /** @deprecated Prefer loadOrCreateRecoveryKey for new cross-platform apps. */
  loadOrCreateMnemonic(): Promise<string>;
  /** @deprecated Prefer setRecoveryKey, which also accepts sf1_ keys. */
  setMnemonic(mnemonic: string): Promise<string>;
  /** @deprecated Prefer rotateRecoveryKey for new cross-platform apps. */
  rotateMnemonic(): Promise<string>;
  clear(): Promise<void>;
}

export interface BrowserOwnerStoreOptions {
  readonly key?: string;
}

/**
 * Recovery-credential storage backed by the caller's encrypted SecureStorage.
 * This deliberately has no localStorage fallback.
 */
export function createBrowserOwnerStore(
  secureStorage: SecureStorage,
  options: BrowserOwnerStoreOptions = {},
): BrowserOwnerStore {
  // Retain the historical key name so upgrades find their existing mnemonic.
  const key = options.key ?? "simplysync:mnemonic";

  return {
    async loadOrCreateRecoveryKey() {
      const stored = await secureStorage.getItem(key);
      if (stored) {
        try {
          return (await deriveIdentity(stored)).recoveryKey;
        } catch (error) {
          throw new Error(
            "The stored browser recovery credential is invalid; refusing to replace its owner.",
            { cause: error },
          );
        }
      }
      const recoveryKey = await createRecoveryKey();
      await secureStorage.setItem(key, recoveryKey);
      return recoveryKey;
    },

    async setRecoveryKey(recoveryKey) {
      let normalized: string;
      try {
        normalized = (await deriveIdentity(recoveryKey)).recoveryKey;
      } catch (error) {
        throw new Error("That is not a valid SimplySync recovery key or phrase.", {
          cause: error,
        });
      }
      await secureStorage.setItem(key, normalized);
      return normalized;
    },

    async rotateRecoveryKey() {
      const recoveryKey = await createRecoveryKey();
      await secureStorage.setItem(key, recoveryKey);
      return recoveryKey;
    },

    async loadOrCreateMnemonic() {
      const stored = await secureStorage.getItem(key);
      if (stored && isRecoveryMnemonic(stored)) return normalizeMnemonic(stored);
      if (stored) {
        throw new Error(
          "This browser owner uses an sf1_ recovery key; load it with loadOrCreateRecoveryKey().",
        );
      }
      const mnemonic = createMnemonic();
      await secureStorage.setItem(key, mnemonic);
      return mnemonic;
    },

    async setMnemonic(mnemonic) {
      const normalized = normalizeMnemonic(mnemonic);
      if (!isRecoveryMnemonic(normalized)) {
        throw new Error("That is not a valid BIP39 recovery phrase.");
      }
      await secureStorage.setItem(key, normalized);
      return normalized;
    },

    async rotateMnemonic() {
      const mnemonic = createMnemonic();
      await secureStorage.setItem(key, mnemonic);
      return mnemonic;
    },

    async clear() {
      await secureStorage.removeItem(key);
    },
  };
}

export async function deriveBrowserAppOwner(
  recoveryKey: string,
): Promise<AppOwner> {
  try {
    const identity = await deriveIdentity(recoveryKey);
    return {
      id: identity.ownerId,
      recoveryKey: identity.recoveryKey,
      mnemonic: identity.mnemonic,
      writeKey: identity.relayAuth,
    };
  } catch (error) {
    throw new Error("That is not a valid SimplySync recovery key or phrase.", {
      cause: error,
    });
  }
}
