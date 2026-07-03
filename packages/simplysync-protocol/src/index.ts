import {
  generateMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  base64UrlDecode,
  base64UrlEncode,
  canonicalJson,
  concatBytes,
  createSlip21,
  decodeUtf8,
  deriveBytes,
  encodeUtf8,
  getCrypto,
  hmacSha256,
  randomBytes,
  toArrayBuffer,
} from "./crypto";
import type {
  BlobChunkRef,
  BlobManifest,
  EncryptedBlob,
  EncryptedBlobChunk,
  LocalFirstIdentity,
  SyncEnvelope,
  SyncPayload,
} from "./types";

// The protocol data types live in ./types; the low-level crypto primitives
// (base64url, HKDF/HMAC/SLIP-21, byte helpers) live in ./crypto. This file is
// the public API: identity derivation, envelope encrypt/decrypt, the hybrid
// logical clock, and blob encryption.
export * from "./types";
export * from "./snapshot-crypto";
export { base64UrlEncode, base64UrlDecode } from "./crypto";

const RECOVERY_KEY_PREFIX = "sf1_";
const AES_GCM_NONCE_BYTES = 12;
const OWNER_ID_BYTES = 16;
const DERIVED_KEY_BYTES = 32;

// Owner keys derive from the mnemonic's BIP39 entropy using SLIP-21 with these
// fixed labels. The labels are part of the derivation, so they must never change
// once data exists — they pin a recovery phrase to a stable owner identity.
const OWNER_ID_PATH = ["SimplySync", "OwnerIdBytes"] as const;
const ENCRYPTION_KEY_PATH = ["SimplySync", "OwnerEncryptionKey"] as const;
const WRITE_KEY_PATH = ["SimplySync", "OwnerWriteKey"] as const;
const BACKUP_KEY_PATH = ["SimplySync", "BackupKey"] as const;
const WRITE_KEY_BYTES = 16;
const MNEMONIC_STRENGTH_BITS = 256;

const BLOB_ID_BYTES = 16;
/** Default plaintext bytes per blob chunk (256 KiB). */
export const DEFAULT_BLOB_CHUNK_BYTES = 256 * 1024;

export function normalizeRecoveryKey(recoveryKey: string): string {
  return recoveryKey.trim();
}

export async function createRecoveryKey(): Promise<string> {
  return `${RECOVERY_KEY_PREFIX}${base64UrlEncode(await randomBytes(32))}`;
}

/**
 * Generates a fresh 24-word BIP39 mnemonic (English wordlist). Use this instead
 * of {@link createRecoveryKey} when you want users to own a standard, portable
 * recovery phrase.
 */
export function createMnemonic(): string {
  return generateMnemonic(wordlist, MNEMONIC_STRENGTH_BITS);
}

/** Trims, lowercases, and collapses internal whitespace in a mnemonic. */
export function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** Returns true if the value is a valid BIP39 recovery mnemonic. */
export function isRecoveryMnemonic(value: string): boolean {
  const normalized = normalizeMnemonic(value);
  if (normalized.length === 0) return false;
  return validateMnemonic(normalized, wordlist);
}

/**
 * Derives an identity from either a native `sf1_` recovery key or a BIP39
 * mnemonic. Mnemonics are auto-detected so users can paste a standard recovery
 * phrase directly.
 */
export async function deriveIdentity(
  recoveryKey: string,
): Promise<LocalFirstIdentity> {
  const trimmed = recoveryKey.trim();
  if (!trimmed.startsWith(RECOVERY_KEY_PREFIX) && isRecoveryMnemonic(trimmed)) {
    return deriveIdentityFromMnemonic(trimmed);
  }

  const normalizedRecoveryKey = normalizeRecoveryKey(trimmed);
  const secret = decodeRecoveryKey(normalizedRecoveryKey);
  const ownerBytes = await deriveBytes(secret, "owner-id", OWNER_ID_BYTES);
  const dataKeyBytes = await deriveBytes(secret, "data-key", DERIVED_KEY_BYTES);
  const relayAuthBytes = await deriveBytes(
    secret,
    "relay-auth",
    DERIVED_KEY_BYTES,
  );
  const streamKey = await deriveBytes(secret, "stream-key", DERIVED_KEY_BYTES);
  const crypto = await getCrypto();
  const dataKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(dataKeyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    recoveryKey: normalizedRecoveryKey,
    ownerId: base64UrlEncode(ownerBytes),
    relayAuth: base64UrlEncode(relayAuthBytes),
    dataKey,
    streamKey,
    source: "recoveryKey",
  };
}

/**
 * Derives an identity from a BIP39 mnemonic — the owner id, encryption key, and
 * write key — via SLIP-21. The derivation is deterministic, so the same phrase
 * always resolves to the same {@link LocalFirstIdentity.ownerId} on any device
 * or platform.
 */
export async function deriveIdentityFromMnemonic(
  mnemonic: string,
): Promise<LocalFirstIdentity> {
  const normalizedMnemonic = normalizeMnemonic(mnemonic);
  if (!validateMnemonic(normalizedMnemonic, wordlist)) {
    throw new Error("Invalid BIP39 mnemonic.");
  }

  const entropy = mnemonicToEntropy(normalizedMnemonic, wordlist);
  const ownerIdBytes = (await createSlip21(entropy, OWNER_ID_PATH)).slice(
    0,
    OWNER_ID_BYTES,
  );
  const encryptionKeyBytes = await createSlip21(
    entropy,
    ENCRYPTION_KEY_PATH,
  );
  const writeKeyBytes = (
    await createSlip21(entropy, WRITE_KEY_PATH)
  ).slice(0, WRITE_KEY_BYTES);
  // Derived from the encryption key so it's stable across devices/platforms for
  // the same recovery phrase.
  const streamKey = await deriveBytes(
    encryptionKeyBytes,
    "stream-key",
    DERIVED_KEY_BYTES,
  );

  const crypto = await getCrypto();
  const dataKey = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(encryptionKeyBytes),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  return {
    recoveryKey: normalizedMnemonic,
    mnemonic: normalizedMnemonic,
    ownerId: base64UrlEncode(ownerIdBytes),
    relayAuth: base64UrlEncode(writeKeyBytes),
    dataKey,
    streamKey,
    source: "mnemonic",
  };
}

/**
 * Derives a dedicated 32-byte key for encrypting a full DB backup from a
 * recovery phrase (BIP39 mnemonic or native `sf1_` key). A distinct
 * SLIP-21/HKDF label keeps backup ciphertext from being confused with row
 * ciphertext. This is the key behind the default, passphrase-free
 * `exportDatabase()` — stretching this already-high-entropy secret with PBKDF2
 * would add nothing, so it doesn't.
 */
export async function deriveBackupKeyBytes(
  recoveryKey: string,
): Promise<Uint8Array> {
  const trimmed = recoveryKey.trim();
  if (!trimmed.startsWith(RECOVERY_KEY_PREFIX) && isRecoveryMnemonic(trimmed)) {
    const entropy = mnemonicToEntropy(normalizeMnemonic(trimmed), wordlist);
    return createSlip21(entropy, BACKUP_KEY_PATH);
  }
  const secret = decodeRecoveryKey(normalizeRecoveryKey(trimmed));
  return deriveBytes(secret, "backup-key", DERIVED_KEY_BYTES);
}

export async function createDeviceId(): Promise<string> {
  return base64UrlEncode(await randomBytes(8));
}

export function createHlc(deviceId: string, now = Date.now(), counter = 0): string {
  return [
    now.toString(36).padStart(10, "0"),
    counter.toString(36).padStart(4, "0"),
    deviceId,
  ].join("-");
}

export function compareHlc(left: string | null | undefined, right: string): number {
  if (!left) return -1;
  return left.localeCompare(right);
}

/**
 * Encrypts `payload` into a {@link SyncEnvelope} using an explicit `nonce`
 * instead of generating one. This is the deterministic core of
 * {@link encryptPayload}, split out so tests and cross-language conformance
 * vector generators can seal with a fixed nonce and assert exact ciphertext.
 * Production code should use {@link encryptPayload}, which always generates a
 * fresh random nonce.
 */
export async function sealPayload<T>(
  identity: LocalFirstIdentity,
  event: {
    readonly eventId: string;
    readonly deviceId: string;
    readonly createdAt?: string;
  },
  payload: SyncPayload<T>,
  nonce: Uint8Array,
): Promise<SyncEnvelope> {
  const crypto = await getCrypto();
  const createdAt = event.createdAt ?? new Date().toISOString();
  // Group key for compaction: same (table,row) => same streamId, but the relay
  // can't reverse it. Included in the AAD header so it's tamper-evident.
  const streamId = identity.streamKey
    ? base64UrlEncode(
        await hmacSha256(
          identity.streamKey,
          encodeUtf8(`${payload.table} ${payload.rowId}`),
        ),
      ).slice(0, 22)
    : undefined;
  const envelopeHeader = {
    version: 1 as const,
    ownerId: identity.ownerId,
    eventId: event.eventId,
    deviceId: event.deviceId,
    createdAt,
    ...(streamId ? { streamId } : {}),
  };

  const encrypted = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(encodeUtf8(canonicalJson(envelopeHeader))),
    },
    identity.dataKey,
    toArrayBuffer(encodeUtf8(canonicalJson(payload))),
  );

  return {
    ...envelopeHeader,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(encrypted)),
  };
}

export async function encryptPayload<T>(
  identity: LocalFirstIdentity,
  event: {
    readonly eventId: string;
    readonly deviceId: string;
    readonly createdAt?: string;
  },
  payload: SyncPayload<T>,
): Promise<SyncEnvelope> {
  const nonce = await randomBytes(AES_GCM_NONCE_BYTES);
  return sealPayload(identity, event, payload, nonce);
}

export async function decryptEnvelope<T>(
  identity: LocalFirstIdentity,
  envelope: SyncEnvelope,
): Promise<SyncPayload<T>> {
  if (envelope.ownerId !== identity.ownerId) {
    throw new Error("Envelope owner does not match this recovery key.");
  }

  const crypto = await getCrypto();
  const envelopeHeader = {
    version: envelope.version,
    ownerId: envelope.ownerId,
    eventId: envelope.eventId,
    deviceId: envelope.deviceId,
    createdAt: envelope.createdAt,
    // Only part of the AAD when the writer included it (backward compatible:
    // envelopes written before streamId existed reconstruct the same header).
    ...(envelope.streamId ? { streamId: envelope.streamId } : {}),
  };
  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(base64UrlDecode(envelope.nonce)),
      additionalData: toArrayBuffer(encodeUtf8(canonicalJson(envelopeHeader))),
    },
    identity.dataKey,
    toArrayBuffer(base64UrlDecode(envelope.ciphertext)),
  );

  return JSON.parse(decodeUtf8(new Uint8Array(decrypted))) as SyncPayload<T>;
}

export async function sha256Base64Url(value: string): Promise<string> {
  return sha256Base64UrlBytes(encodeUtf8(value));
}

export async function sha256Base64UrlBytes(bytes: Uint8Array): Promise<string> {
  const crypto = await getCrypto();
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Generates a random blob id (base64url, 16 bytes). */
export async function createBlobId(): Promise<string> {
  return base64UrlEncode(await randomBytes(BLOB_ID_BYTES));
}

/**
 * Splits `data` into chunks and encrypts each with the owner's data key
 * (AES-GCM, fresh nonce per chunk). Each chunk is bound by AEAD to its owner,
 * blob, and index, then content-addressed by the SHA-256 of `nonce ‖ ciphertext`
 * so a relay can store and dedupe opaque bytes. Returns a small syncable
 * {@link BlobManifest} plus the encrypted chunks to upload.
 */
export async function encryptBlob(
  identity: LocalFirstIdentity,
  data: Uint8Array,
  options: {
    readonly mimeType: string;
    readonly chunkSize?: number;
    readonly blobId?: string;
    readonly createdAt?: string;
  },
): Promise<EncryptedBlob> {
  const chunkSize = options.chunkSize ?? DEFAULT_BLOB_CHUNK_BYTES;
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("Blob chunkSize must be a positive integer.");
  }

  const crypto = await getCrypto();
  const blobId = options.blobId ?? (await createBlobId());
  const createdAt = options.createdAt ?? new Date().toISOString();

  const chunks: EncryptedBlobChunk[] = [];
  const chunkRefs: BlobChunkRef[] = [];
  let index = 0;

  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const plaintext = data.subarray(offset, offset + chunkSize);
    const nonce = await randomBytes(AES_GCM_NONCE_BYTES);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: toArrayBuffer(nonce),
        additionalData: blobChunkAad(identity.ownerId, blobId, index),
      },
      identity.dataKey,
      toArrayBuffer(plaintext),
    );
    const stored = concatBytes(nonce, new Uint8Array(ciphertext));
    const hash = await sha256Base64UrlBytes(stored);

    chunks.push({ hash, bytes: stored });
    chunkRefs.push({ hash, size: stored.length, plaintextSize: plaintext.length });
    index += 1;
  }

  const manifest: BlobManifest = {
    version: 1,
    ownerId: identity.ownerId,
    blobId,
    mimeType: options.mimeType,
    byteSize: data.length,
    chunkSize,
    chunks: chunkRefs,
    sha256: await sha256Base64UrlBytes(data),
    createdAt,
  };

  return { manifest, chunks };
}

/**
 * Decrypts a single stored chunk (`nonce ‖ ciphertext`). Verifies the chunk's
 * content hash before decrypting, so a corrupted or substituted chunk is
 * rejected. Use this for streaming/lazy reads.
 */
export async function decryptBlobChunk(
  identity: LocalFirstIdentity,
  manifest: BlobManifest,
  index: number,
  storedBytes: Uint8Array,
): Promise<Uint8Array> {
  if (manifest.ownerId !== identity.ownerId) {
    throw new Error("Blob owner does not match this recovery key.");
  }
  const ref = manifest.chunks[index];
  if (!ref) throw new Error(`Blob has no chunk at index ${index}.`);

  const actualHash = await sha256Base64UrlBytes(storedBytes);
  if (actualHash !== ref.hash) {
    throw new Error("Blob chunk hash mismatch (corrupted or tampered).");
  }

  const crypto = await getCrypto();
  const nonce = storedBytes.subarray(0, AES_GCM_NONCE_BYTES);
  const ciphertext = storedBytes.subarray(AES_GCM_NONCE_BYTES);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: blobChunkAad(manifest.ownerId, manifest.blobId, index),
    },
    identity.dataKey,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

/**
 * Reassembles a blob from its (ordered) stored chunk bytes, verifying each
 * chunk hash and the whole-blob SHA-256. `storedChunks` must be in manifest
 * order and complete.
 */
export async function decryptBlob(
  identity: LocalFirstIdentity,
  manifest: BlobManifest,
  storedChunks: readonly Uint8Array[],
): Promise<Uint8Array> {
  if (storedChunks.length !== manifest.chunks.length) {
    throw new Error("Blob chunk count does not match manifest.");
  }

  const parts: Uint8Array[] = [];
  for (let index = 0; index < manifest.chunks.length; index += 1) {
    parts.push(
      await decryptBlobChunk(identity, manifest, index, storedChunks[index]),
    );
  }

  const data = concatBytes(...parts);
  if (data.length !== manifest.byteSize) {
    throw new Error("Decrypted blob size does not match manifest.");
  }
  if ((await sha256Base64UrlBytes(data)) !== manifest.sha256) {
    throw new Error("Blob integrity check failed.");
  }
  return data;
}

function decodeRecoveryKey(recoveryKey: string): Uint8Array {
  if (!recoveryKey.startsWith(RECOVERY_KEY_PREFIX)) {
    throw new Error(`Recovery key must start with ${RECOVERY_KEY_PREFIX}.`);
  }

  const secret = base64UrlDecode(recoveryKey.slice(RECOVERY_KEY_PREFIX.length));
  if (secret.length !== DERIVED_KEY_BYTES) {
    throw new Error("Recovery key must contain 32 bytes of entropy.");
  }
  return secret;
}

function blobChunkAad(
  ownerId: string,
  blobId: string,
  index: number,
): ArrayBuffer {
  return toArrayBuffer(
    encodeUtf8(canonicalJson({ v: 1, ownerId, blobId, index })),
  );
}
