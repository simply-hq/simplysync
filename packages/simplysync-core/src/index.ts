import {
  generateMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const RECOVERY_KEY_PREFIX = "sf1_";
const DERIVATION_SALT = new Uint8Array([
  115, 98, 116, 45, 108, 111, 99, 97, 108,
  45, 102, 105, 114, 115, 116, 45, 118, 49,
]);
const AES_GCM_NONCE_BYTES = 12;
const OWNER_ID_BYTES = 16;
const DERIVED_KEY_BYTES = 32;

// Owner keys derive from the mnemonic's BIP39 entropy using SLIP-21 with these
// fixed labels. The labels are part of the derivation, so they must never change
// once data exists — they pin a recovery phrase to a stable owner identity.
const OWNER_ID_PATH = ["SimplySync", "OwnerIdBytes"] as const;
const ENCRYPTION_KEY_PATH = ["SimplySync", "OwnerEncryptionKey"] as const;
const WRITE_KEY_PATH = ["SimplySync", "OwnerWriteKey"] as const;
const WRITE_KEY_BYTES = 16;
const MNEMONIC_STRENGTH_BITS = 256;

const BLOB_ID_BYTES = 16;
/** Default plaintext bytes per blob chunk (256 KiB). */
export const DEFAULT_BLOB_CHUNK_BYTES = 256 * 1024;

/** How a {@link LocalFirstIdentity} was derived from its recovery credential. */
export type IdentitySource = "recoveryKey" | "mnemonic";

export interface LocalFirstIdentity {
  readonly recoveryKey: string;
  readonly ownerId: string;
  readonly relayAuth: string;
  readonly dataKey: CryptoKey;
  /**
   * Secret HMAC key used to derive a per-row {@link SyncEnvelope.streamId}. Lets
   * a relay group an owner's events by logical row (for log compaction) without
   * being able to reverse the id back to the table/row it came from.
   */
  readonly streamKey?: Uint8Array;
  /** How this identity was derived. */
  readonly source: IdentitySource;
  /**
   * The BIP39 mnemonic when the identity was derived from one (a recovery
   * phrase). Absent for native `sf1_` recovery keys.
   */
  readonly mnemonic?: string;
}

export interface SyncEnvelope {
  readonly version: 1;
  readonly ownerId: string;
  readonly eventId: string;
  readonly deviceId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly createdAt: string;
  /**
   * Pseudonymous, stable per-(table,row) id = HMAC(streamKey, table‖rowId).
   * Present when the writer's identity has a {@link LocalFirstIdentity.streamKey}.
   * A relay groups events by `(ownerId, streamId)` and keeps only the
   * highest-`eventId` (= highest HLC = last writer) per group when compacting.
   * Opaque to the relay: it can't recover the table or row id from it.
   */
  readonly streamId?: string;
}

export interface SyncPayload<T = unknown> {
  readonly schemaVersion: 1;
  readonly table: string;
  readonly op: "upsert" | "delete";
  readonly rowId: string;
  readonly hlc: string;
  readonly value: T;
}

/** A content-addressed reference to one encrypted blob chunk. */
export interface BlobChunkRef {
  /** base64url SHA-256 of the stored object (nonce ‖ ciphertext). */
  readonly hash: string;
  /** Stored (encrypted) byte length, what the relay accounts for. */
  readonly size: number;
  /** Plaintext byte length of this chunk. */
  readonly plaintextSize: number;
}

/**
 * Small, syncable description of an encrypted binary blob. The manifest travels
 * through the normal sync log as a {@link SyncPayload} so every device learns
 * the blob exists; the chunk *bytes* are fetched lazily, by hash, on demand.
 */
export interface BlobManifest {
  readonly version: 1;
  readonly ownerId: string;
  readonly blobId: string;
  readonly mimeType: string;
  /** Total plaintext size in bytes. */
  readonly byteSize: number;
  /** Plaintext chunk size used when splitting. */
  readonly chunkSize: number;
  /** Chunks in order; concatenating their plaintext rebuilds the blob. */
  readonly chunks: readonly BlobChunkRef[];
  /** base64url SHA-256 of the whole plaintext (end-to-end integrity). */
  readonly sha256: string;
  readonly createdAt: string;
}

/** One encrypted chunk ready to upload: `bytes` is `nonce ‖ ciphertext`. */
export interface EncryptedBlobChunk {
  readonly hash: string;
  readonly bytes: Uint8Array;
}

/** Result of {@link encryptBlob}: a syncable manifest plus uploadable chunks. */
export interface EncryptedBlob {
  readonly manifest: BlobManifest;
  readonly chunks: readonly EncryptedBlobChunk[];
}

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
 * always resolves to the same {@link ownerId} on any device or platform.
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

export async function encryptPayload<T>(
  identity: LocalFirstIdentity,
  event: {
    readonly eventId: string;
    readonly deviceId: string;
    readonly createdAt?: string;
  },
  payload: SyncPayload<T>,
): Promise<SyncEnvelope> {
  const crypto = await getCrypto();
  const nonce = await randomBytes(AES_GCM_NONCE_BYTES);
  const createdAt = event.createdAt ?? new Date().toISOString();
  // Group key for compaction: same (table,row) => same streamId, but the relay
  // can't reverse it. Included in the AAD header so it's tamper-evident.
  const streamId = identity.streamKey
    ? base64UrlEncode(
        await hmacSha256(
          identity.streamKey,
          encodeUtf8(`${payload.table} ${payload.rowId}`),
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

function blobChunkAad(
  ownerId: string,
  blobId: string,
  index: number,
): ArrayBuffer {
  return toArrayBuffer(
    encodeUtf8(canonicalJson({ v: 1, ownerId, blobId, index })),
  );
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  if (typeof btoa !== "function") {
    throw new Error("base64 encoding requires btoa in this runtime.");
  }

  const base64 = btoa(binary);

  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

  if (typeof atob !== "function") {
    throw new Error("base64 decoding requires atob in this runtime.");
  }

  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

async function deriveBytes(
  secret: Uint8Array,
  label: string,
  byteLength: number,
): Promise<Uint8Array> {
  const info = encodeUtf8(label);
  const prk = await hmacSha256(DERIVATION_SALT, secret);
  const output = new Uint8Array(byteLength);
  let previous: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let offset = 0;
  let blockIndex = 1;

  while (offset < byteLength) {
    const blockInput = concatBytes(
      previous,
      info,
      new Uint8Array([blockIndex]),
    );
    previous = await hmacSha256(prk, blockInput);
    output.set(previous.slice(0, byteLength - offset), offset);
    offset += previous.length;
    blockIndex += 1;
  }

  return output;
}

async function randomBytes(length: number): Promise<Uint8Array> {
  const crypto = await getCrypto();
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

async function getCrypto(): Promise<Crypto> {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }

  throw new Error("WebCrypto is required for local-first encryption.");
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function digestBytes(
  hash: "SHA-256" | "SHA-512",
  data: Uint8Array,
): Promise<Uint8Array> {
  const crypto = await getCrypto();
  return new Uint8Array(await crypto.subtle.digest(hash, toArrayBuffer(data)));
}

// HMAC implemented on top of subtle.digest (RFC 2104) rather than
// subtle.sign/importKey. subtle.digest is universally supported, whereas some
// runtimes (react-native-quick-crypto) have a broken subtle HMAC sign path.
async function hmac(
  hash: "SHA-256" | "SHA-512",
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const blockSize = hash === "SHA-512" ? 128 : 64;
  let key = keyBytes;
  if (key.length > blockSize) key = await digestBytes(hash, key);
  if (key.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    padded.set(key);
    key = padded;
  }
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    ipad[i] = key[i] ^ 0x36;
    opad[i] = key[i] ^ 0x5c;
  }
  const inner = await digestBytes(hash, concatBytes(ipad, data));
  return digestBytes(hash, concatBytes(opad, inner));
}

function hmacSha256(keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return hmac("SHA-256", keyBytes, data);
}

/**
 * SLIP-21 hierarchical symmetric key derivation. Returns the lower 32 bytes of
 * the final node.
 */
async function createSlip21(
  seed: Uint8Array,
  path: readonly string[],
): Promise<Uint8Array> {
  let node = await hmac("SHA-512", encodeUtf8("Symmetric key seed"), seed);
  for (const label of path) {
    const labelBytes = encodeUtf8(label);
    const message = new Uint8Array(labelBytes.length + 1);
    message[0] = 0;
    message.set(labelBytes, 1);
    node = await hmac("SHA-512", node.slice(0, 32), message);
  }
  return node.slice(32, 64);
}

function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
    );
  }

  return value;
}
