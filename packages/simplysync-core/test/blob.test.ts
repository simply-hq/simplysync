import { describe, expect, test } from "bun:test";

import {
  createRecoveryKey,
  decryptBlob,
  decryptBlobChunk,
  deriveIdentity,
  encryptBlob,
  type EncryptedBlob,
} from "../src/index.ts";

async function freshIdentity() {
  return deriveIdentity(await createRecoveryKey());
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function storedChunks(blob: EncryptedBlob): Uint8Array[] {
  return blob.chunks.map((chunk) => chunk.bytes);
}

describe("encrypted blobs", () => {
  test("round-trips a multi-chunk blob", async () => {
    const identity = await freshIdentity();
    const data = randomBytes(700_000); // > 2 chunks at 256 KiB

    const blob = await encryptBlob(identity, data, {
      mimeType: "image/png",
    });

    expect(blob.manifest.byteSize).toBe(700_000);
    expect(blob.manifest.mimeType).toBe("image/png");
    expect(blob.manifest.ownerId).toBe(identity.ownerId);
    expect(blob.manifest.chunks).toHaveLength(3); // ceil(700000 / 262144)
    expect(blob.chunks).toHaveLength(3);

    const restored = await decryptBlob(identity, blob.manifest, storedChunks(blob));
    expect(restored).toEqual(data);
  });

  test("honors a custom chunk size and exposes content hashes", async () => {
    const identity = await freshIdentity();
    const data = randomBytes(1000);

    const blob = await encryptBlob(identity, data, {
      mimeType: "application/octet-stream",
      chunkSize: 256,
    });

    expect(blob.manifest.chunks).toHaveLength(4); // ceil(1000 / 256)
    // Stored bytes = 12-byte nonce + ciphertext + 16-byte GCM tag.
    expect(blob.manifest.chunks[0].size).toBe(256 + 12 + 16);
    expect(blob.manifest.chunks[0].plaintextSize).toBe(256);
    // The manifest's content hash matches the actual uploaded chunk.
    expect(blob.chunks[0].hash).toBe(blob.manifest.chunks[0].hash);

    const restored = await decryptBlob(identity, blob.manifest, storedChunks(blob));
    expect(restored).toEqual(data);
  });

  test("decrypts a single chunk lazily", async () => {
    const identity = await freshIdentity();
    const data = randomBytes(600);
    const blob = await encryptBlob(identity, data, {
      mimeType: "text/plain",
      chunkSize: 256,
    });

    const chunk0 = await decryptBlobChunk(identity, blob.manifest, 0, blob.chunks[0].bytes);
    expect(chunk0).toEqual(data.subarray(0, 256));
  });

  test("rejects a tampered chunk before decrypting", async () => {
    const identity = await freshIdentity();
    const blob = await encryptBlob(identity, randomBytes(500), {
      mimeType: "text/plain",
      chunkSize: 256,
    });

    const tampered = Uint8Array.from(blob.chunks[0].bytes);
    tampered[tampered.length - 1] ^= 0xff;

    expect(
      decryptBlobChunk(identity, blob.manifest, 0, tampered),
    ).rejects.toThrow(/hash mismatch/u);
  });

  test("rejects a blob from a different owner", async () => {
    const owner = await freshIdentity();
    const other = await freshIdentity();
    const blob = await encryptBlob(owner, randomBytes(300), {
      mimeType: "text/plain",
    });

    expect(
      decryptBlob(other, blob.manifest, storedChunks(blob)),
    ).rejects.toThrow(/owner does not match/u);
  });

  test("handles an empty blob", async () => {
    const identity = await freshIdentity();
    const blob = await encryptBlob(identity, new Uint8Array(0), {
      mimeType: "application/octet-stream",
    });

    expect(blob.manifest.chunks).toHaveLength(0);
    expect(blob.manifest.byteSize).toBe(0);
    const restored = await decryptBlob(identity, blob.manifest, []);
    expect(restored).toEqual(new Uint8Array(0));
  });
});
