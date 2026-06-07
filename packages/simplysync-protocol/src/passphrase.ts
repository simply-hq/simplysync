// Passphrase-based authenticated encryption for the encrypted DB-snapshot file
// (see the engine's exportDatabase/importDatabase). A self-describing envelope:
// PBKDF2-HMAC-SHA256 stretches the passphrase into a 32-byte key, which then
// encrypts the plaintext with AES-256-GCM.
//
// The KDF is injectable. The default uses WebCrypto `subtle.deriveBits`, which
// is fast and available in browsers / Bun / Node / Workers. React Native's
// subtle PBKDF2 path is unreliable, so RN callers should inject a native KDF
// (e.g. react-native-quick-crypto's `pbkdf2Sync`) via the engine deps.

import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  decodeUtf8,
  encodeUtf8,
  getCrypto,
  randomBytes,
  toArrayBuffer,
} from "./crypto";

export const ENCRYPTED_SNAPSHOT_FORMAT = "simplysync-db-snapshot";
export const ENCRYPTED_SNAPSHOT_VERSION = 1;

const DEFAULT_PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const KEY_BYTES = 32;
const GCM_TAG_BYTES = 16;

/**
 * Stretches a passphrase into a symmetric key. `salt` and `iterations` come from
 * the envelope so an injected implementation must honour them exactly (a wrong
 * key just fails the GCM tag check on decrypt). Returns `keyBytes` bytes.
 */
export type PassphraseKdf = (
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
  keyBytes: number,
) => Uint8Array | Promise<Uint8Array>;

export interface EncryptedEnvelopeV1 {
  readonly format: typeof ENCRYPTED_SNAPSHOT_FORMAT;
  readonly version: typeof ENCRYPTED_SNAPSHOT_VERSION;
  readonly kdf: {
    readonly algo: "PBKDF2";
    readonly hash: "SHA-256";
    readonly iterations: number;
    readonly salt: string; // base64url
  };
  readonly cipher: {
    readonly algo: "AES-256-GCM";
    readonly nonce: string; // base64url
    readonly tag: string; // base64url (16-byte GCM auth tag)
  };
  readonly ciphertext: string; // base64url
}

/** Thrown when a snapshot can't be decrypted — almost always a wrong passphrase. */
export class PassphraseDecryptError extends Error {
  constructor(message = "Incorrect passphrase or corrupted backup file.") {
    super(message);
    this.name = "PassphraseDecryptError";
  }
}

/** Thrown when the file isn't a recognizable encrypted envelope. */
export class InvalidBackupEnvelopeError extends Error {
  constructor(message = "This file is not a recognized encrypted backup.") {
    super(message);
    this.name = "InvalidBackupEnvelopeError";
  }
}

/** Default KDF: WebCrypto PBKDF2-HMAC-SHA256 via `subtle.deriveBits`. */
const subtlePbkdf2: PassphraseKdf = async (
  passphrase,
  salt,
  iterations,
  keyBytes,
) => {
  const crypto = await getCrypto();
  // NFKC so visually identical passphrases derive the same key across keyboards.
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encodeUtf8(passphrase.normalize("NFKC"))),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toArrayBuffer(salt),
      iterations,
    },
    keyMaterial,
    keyBytes * 8,
  );
  return new Uint8Array(bits);
};

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  const crypto = await getCrypto();
  return crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface PassphraseCryptoOptions {
  /** Override the key-derivation function (e.g. a native KDF on React Native). */
  readonly kdf?: PassphraseKdf;
  /** PBKDF2 iterations for encryption. Default 600,000. */
  readonly iterations?: number;
}

/** Encrypt a UTF-8 string under a passphrase into a self-describing envelope. */
export async function encryptStringWithPassphrase(
  passphrase: string,
  plaintext: string,
  options?: PassphraseCryptoOptions,
): Promise<EncryptedEnvelopeV1> {
  if (passphrase.length === 0) {
    throw new Error("A passphrase is required.");
  }

  const kdf = options?.kdf ?? subtlePbkdf2;
  const iterations = options?.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = await randomBytes(SALT_BYTES);
  const nonce = await randomBytes(NONCE_BYTES);
  const key = await importAesKey(await kdf(passphrase, salt, iterations, KEY_BYTES));

  const crypto = await getCrypto();
  // WebCrypto AES-GCM appends the 16-byte auth tag to the ciphertext; split it
  // off so the envelope stores ciphertext and tag separately.
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      key,
      toArrayBuffer(encodeUtf8(plaintext)),
    ),
  );
  const ciphertext = sealed.subarray(0, sealed.length - GCM_TAG_BYTES);
  const tag = sealed.subarray(sealed.length - GCM_TAG_BYTES);

  return {
    format: ENCRYPTED_SNAPSHOT_FORMAT,
    version: ENCRYPTED_SNAPSHOT_VERSION,
    kdf: {
      algo: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: base64UrlEncode(salt),
    },
    cipher: {
      algo: "AES-256-GCM",
      nonce: base64UrlEncode(nonce),
      tag: base64UrlEncode(tag),
    },
    ciphertext: base64UrlEncode(ciphertext),
  };
}

/** Validate that an arbitrary parsed value is a supported encrypted envelope. */
export function isEncryptedEnvelope(
  value: unknown,
): value is EncryptedEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const env = value as Partial<EncryptedEnvelopeV1>;
  return (
    env.format === ENCRYPTED_SNAPSHOT_FORMAT &&
    env.version === ENCRYPTED_SNAPSHOT_VERSION &&
    env.kdf?.algo === "PBKDF2" &&
    typeof env.kdf?.iterations === "number" &&
    typeof env.kdf?.salt === "string" &&
    env.cipher?.algo === "AES-256-GCM" &&
    typeof env.cipher?.nonce === "string" &&
    typeof env.cipher?.tag === "string" &&
    typeof env.ciphertext === "string"
  );
}

/**
 * Decrypt an envelope back to its UTF-8 plaintext. Throws
 * {@link InvalidBackupEnvelopeError} for an unrecognized shape and
 * {@link PassphraseDecryptError} for a wrong passphrase / tampered ciphertext.
 */
export async function decryptStringWithPassphrase(
  passphrase: string,
  envelope: unknown,
  options?: PassphraseCryptoOptions,
): Promise<string> {
  if (!isEncryptedEnvelope(envelope)) {
    throw new InvalidBackupEnvelopeError();
  }

  const kdf = options?.kdf ?? subtlePbkdf2;
  const salt = base64UrlDecode(envelope.kdf.salt);
  const nonce = base64UrlDecode(envelope.cipher.nonce);
  const tag = base64UrlDecode(envelope.cipher.tag);
  const ciphertext = base64UrlDecode(envelope.ciphertext);
  const key = await importAesKey(
    await kdf(passphrase, salt, envelope.kdf.iterations, KEY_BYTES),
  );

  try {
    const crypto = await getCrypto();
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      key,
      // Re-append the tag WebCrypto expects at the end of the ciphertext.
      toArrayBuffer(concatBytes(ciphertext, tag)),
    );
    return decodeUtf8(new Uint8Array(plaintext));
  } catch {
    // GCM tag mismatch (wrong passphrase / corruption) surfaces here.
    throw new PassphraseDecryptError();
  }
}
