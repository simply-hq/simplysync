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

  test("a chunk list that does not match the manifest is rejected", async () => {
    // The manifest replicates through the change log; the bytes come from a
    // relay separately and may arrive short, reordered by a caller, or padded.
    // Reassembling anyway would hand the app a silently truncated file.
    const identity = await freshIdentity();
    const blob = await encryptBlob(identity, randomBytes(700_000), {
      mimeType: "application/octet-stream",
    });
    const chunks = storedChunks(blob);
    expect(chunks.length).toBeGreaterThan(2);

    expect(
      decryptBlob(identity, blob.manifest, chunks.slice(0, -1)),
    ).rejects.toThrow(/chunk count/u);
    expect(
      decryptBlob(identity, blob.manifest, [...chunks, chunks[0]!]),
    ).rejects.toThrow(/chunk count/u);
    // Right count, wrong order: each chunk is AEAD-bound to its index, so the
    // hash check fires before any plaintext is produced.
    expect(
      decryptBlob(identity, blob.manifest, [chunks[1]!, chunks[0]!, ...chunks.slice(2)]),
    ).rejects.toThrow(/hash mismatch/u);
    // An index the manifest never described is named, not silently skipped.
    expect(
      decryptBlobChunk(identity, blob.manifest, chunks.length, chunks[0]!),
    ).rejects.toThrow(/no chunk at index/u);
  });

  test("a chunk size that cannot produce a manifest is refused", async () => {
    // encryptBlob steps `offset += chunkSize`. A zero or negative size never
    // advances, so the loop would run until the process died; a fractional one
    // produces chunk boundaries no reader can reproduce from the manifest.
    const identity = await freshIdentity();
    const data = randomBytes(64);
    for (const chunkSize of [0, -1, 1.5, Number.NaN]) {
      expect(
        encryptBlob(identity, data, {
          mimeType: "application/octet-stream",
          chunkSize,
        }),
      ).rejects.toThrow(/positive integer/u);
    }
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

describe("whole-blob integrity", () => {
  test("chunks that each verify but do not add up to this blob are rejected", async () => {
    // Every chunk is content-addressed and index-bound, so a set of chunks can
    // be individually valid and still not be the file the manifest describes —
    // a truncated upload, or chunks recombined from two blobs of equal shape.
    // The whole-blob size and digest are the last check before bytes are handed
    // back to the app.
    const identity = await freshIdentity();
    const data = randomBytes(600_000);
    const blob = await encryptBlob(identity, data, {
      mimeType: "application/octet-stream",
    });

    const wrongSize = { ...blob.manifest, byteSize: blob.manifest.byteSize + 1 };
    expect(
      decryptBlob(identity, wrongSize, storedChunks(blob)),
    ).rejects.toThrow(/size does not match/u);

    const wrongDigest = { ...blob.manifest, sha256: "AAAAAAAAAAAAAAAAAAAAAA" };
    expect(
      decryptBlob(identity, wrongDigest, storedChunks(blob)),
    ).rejects.toThrow(/integrity check failed/u);
  });
});
