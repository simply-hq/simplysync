// Authenticated encryption for the encrypted DB-snapshot file (see the engine's
// exportDatabase / importDatabase). A self-describing envelope, AES-256-GCM in
// both cases, with two ways to derive the key:
//
//   keying: "recovery-phrase" — the historical wire name for a key derived from
//     the owner's recovery credential: either an `sf1_` key or BIP39 phrase (see
//     deriveBackupKeyBytes). The credential must be supplied to restore — the
//     file alone is useless, and it carries the ownerId so a wrong credential
//     fails fast.
//
//   keying: "passphrase" — the key is stretched from a user passphrase with
//     PBKDF2-HMAC-SHA256. Optional/advanced: a second, independent secret, so
//     the backup can be restored even if the recovery phrase is lost. The KDF is
//     injectable (RN should supply a native one; the default uses WebCrypto).

import {
  base64UrlDecode,
  base64UrlEncode,
  concatBytes,
  decodeUtf8,
  encodeUtf8,
  getCrypto,
  randomBytes,
  toArrayBuffer,
} from "./crypto.js";

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

interface EnvelopeBaseV1 {
  readonly format: typeof ENCRYPTED_SNAPSHOT_FORMAT;
  readonly version: typeof ENCRYPTED_SNAPSHOT_VERSION;
  readonly cipher: {
    readonly algo: "AES-256-GCM";
    readonly nonce: string; // base64url
    readonly tag: string; // base64url (16-byte GCM auth tag)
  };
  readonly ciphertext: string; // base64url
}

/**
 * A snapshot encrypted under a key derived from the owner's recovery key or
 * phrase. The `recovery-phrase` discriminator is retained for wire compatibility.
 */
export interface RecoveryPhraseEnvelopeV1 extends EnvelopeBaseV1 {
  readonly keying: "recovery-phrase";
  /** Owner the credential must derive to — lets a wrong key/phrase fail fast. */
  readonly ownerId: string;
}

/** A snapshot encrypted under a key stretched from a user passphrase. */
export interface PassphraseEnvelopeV1 extends EnvelopeBaseV1 {
  readonly keying: "passphrase";
  readonly kdf: {
    readonly algo: "PBKDF2";
    readonly hash: "SHA-256";
    readonly iterations: number;
    readonly salt: string; // base64url
  };
}

export type EncryptedEnvelopeV1 =
  | RecoveryPhraseEnvelopeV1
  | PassphraseEnvelopeV1;

/** Thrown when a snapshot can't be decrypted — wrong secret or corrupted file. */
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
    { name: "PBKDF2", hash: "SHA-256", salt: toArrayBuffer(salt), iterations },
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

interface SealedBytes {
  readonly nonce: string;
  readonly tag: string;
  readonly ciphertext: string;
}

// WebCrypto AES-GCM appends the 16-byte auth tag to the ciphertext; split it off
// so the envelope stores ciphertext and tag separately.
async function seal(
  keyBytes: Uint8Array,
  plaintext: string,
): Promise<SealedBytes> {
  const crypto = await getCrypto();
  const key = await importAesKey(keyBytes);
  const nonce = await randomBytes(NONCE_BYTES);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toArrayBuffer(nonce) },
      key,
      toArrayBuffer(encodeUtf8(plaintext)),
    ),
  );
  return {
    nonce: base64UrlEncode(nonce),
    tag: base64UrlEncode(sealed.subarray(sealed.length - GCM_TAG_BYTES)),
    ciphertext: base64UrlEncode(
      sealed.subarray(0, sealed.length - GCM_TAG_BYTES),
    ),
  };
}

async function open(keyBytes: Uint8Array, cipher: SealedBytes): Promise<string> {
  const key = await importAesKey(keyBytes);
  const nonce = base64UrlDecode(cipher.nonce);
  const tag = base64UrlDecode(cipher.tag);
  const ciphertext = base64UrlDecode(cipher.ciphertext);
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
    // GCM tag mismatch (wrong key / corruption) surfaces here.
    throw new PassphraseDecryptError();
  }
}

export interface PassphraseCryptoOptions {
  /** Override the key-derivation function (e.g. a native KDF on React Native). */
  readonly kdf?: PassphraseKdf;
  /** PBKDF2 iterations for encryption. Default 600,000. */
  readonly iterations?: number;
}

// ----- Recovery-phrase keying (default) -------------------------------------

/**
 * Encrypt a UTF-8 string under a key derived from the owner's recovery phrase
 * (see `deriveBackupKeyBytes`). `ownerId` is recorded in the clear so a restore
 * can reject a wrong phrase before attempting decryption.
 */
export async function encryptStringWithKey(
  keyBytes: Uint8Array,
  plaintext: string,
  meta: { readonly ownerId: string },
): Promise<RecoveryPhraseEnvelopeV1> {
  const sealed = await seal(keyBytes, plaintext);
  return {
    format: ENCRYPTED_SNAPSHOT_FORMAT,
    version: ENCRYPTED_SNAPSHOT_VERSION,
    keying: "recovery-phrase",
    ownerId: meta.ownerId,
    cipher: { algo: "AES-256-GCM", nonce: sealed.nonce, tag: sealed.tag },
    ciphertext: sealed.ciphertext,
  };
}

/** Decrypt a recovery-phrase envelope with the phrase-derived key. */
export async function decryptStringWithKey(
  keyBytes: Uint8Array,
  envelope: unknown,
): Promise<string> {
  if (!isEncryptedEnvelope(envelope) || envelope.keying !== "recovery-phrase") {
    throw new InvalidBackupEnvelopeError();
  }
  return open(keyBytes, {
    nonce: envelope.cipher.nonce,
    tag: envelope.cipher.tag,
    ciphertext: envelope.ciphertext,
  });
}

// ----- Passphrase keying (optional) -----------------------------------------

/** Encrypt a UTF-8 string under a user passphrase into a self-describing envelope. */
export async function encryptStringWithPassphrase(
  passphrase: string,
  plaintext: string,
  options?: PassphraseCryptoOptions,
): Promise<PassphraseEnvelopeV1> {
  if (passphrase.length === 0) {
    throw new Error("A passphrase is required.");
  }

  const kdf = options?.kdf ?? subtlePbkdf2;
  const iterations = options?.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = await randomBytes(SALT_BYTES);
  const key = await kdf(passphrase, salt, iterations, KEY_BYTES);
  const sealed = await seal(key, plaintext);

  return {
    format: ENCRYPTED_SNAPSHOT_FORMAT,
    version: ENCRYPTED_SNAPSHOT_VERSION,
    keying: "passphrase",
    kdf: {
      algo: "PBKDF2",
      hash: "SHA-256",
      iterations,
      salt: base64UrlEncode(salt),
    },
    cipher: { algo: "AES-256-GCM", nonce: sealed.nonce, tag: sealed.tag },
    ciphertext: sealed.ciphertext,
  };
}

/**
 * Decrypt a passphrase envelope back to its UTF-8 plaintext. Throws
 * {@link InvalidBackupEnvelopeError} for an unrecognized shape and
 * {@link PassphraseDecryptError} for a wrong passphrase / tampered ciphertext.
 */
export async function decryptStringWithPassphrase(
  passphrase: string,
  envelope: unknown,
  options?: PassphraseCryptoOptions,
): Promise<string> {
  if (!isEncryptedEnvelope(envelope) || envelope.keying !== "passphrase") {
    throw new InvalidBackupEnvelopeError();
  }

  const kdf = options?.kdf ?? subtlePbkdf2;
  const salt = base64UrlDecode(envelope.kdf.salt);
  const key = await kdf(passphrase, salt, envelope.kdf.iterations, KEY_BYTES);
  return open(key, {
    nonce: envelope.cipher.nonce,
    tag: envelope.cipher.tag,
    ciphertext: envelope.ciphertext,
  });
}

/** Validate that an arbitrary parsed value is a supported encrypted envelope. */
export function isEncryptedEnvelope(
  value: unknown,
): value is EncryptedEnvelopeV1 {
  if (!value || typeof value !== "object") return false;
  const env = value as Partial<EncryptedEnvelopeV1>;
  if (
    env.format !== ENCRYPTED_SNAPSHOT_FORMAT ||
    env.version !== ENCRYPTED_SNAPSHOT_VERSION ||
    env.cipher?.algo !== "AES-256-GCM" ||
    typeof env.cipher?.nonce !== "string" ||
    typeof env.cipher?.tag !== "string" ||
    typeof env.ciphertext !== "string"
  ) {
    return false;
  }
  if (env.keying === "recovery-phrase") {
    return typeof (env as RecoveryPhraseEnvelopeV1).ownerId === "string";
  }
  if (env.keying === "passphrase") {
    const kdf = (env as PassphraseEnvelopeV1).kdf;
    return (
      kdf?.algo === "PBKDF2" &&
      typeof kdf?.iterations === "number" &&
      typeof kdf?.salt === "string"
    );
  }
  return false;
}
