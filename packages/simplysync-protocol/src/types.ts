// Public data types for the local-first sync protocol: the derived identity, the
// envelope/payload that travel through a relay, and the blob manifest/chunk
// shapes. Pure type declarations — no runtime.

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
