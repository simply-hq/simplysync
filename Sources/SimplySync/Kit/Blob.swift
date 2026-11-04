import Foundation

/// One encrypted chunk in a blob manifest — mirrors `BlobChunkRef`.
public struct BlobChunkRef: Codable, Equatable {
    /// base64url SHA-256 of the stored bytes (`nonce ‖ ciphertext`): the relay key.
    public let hash: String
    public let size: Int
    public let plaintextSize: Int
}

/// The small syncable record describing a blob — mirrors `BlobManifest` in
/// @simplysync/protocol field for field, so manifests cross ports as JSON.
public struct BlobManifest: Codable, Equatable {
    public let version: Int
    public let ownerId: String
    public let blobId: String
    public let mimeType: String
    public let byteSize: Int
    public let chunkSize: Int
    public let chunks: [BlobChunkRef]
    /// base64url SHA-256 of the whole plaintext.
    public let sha256: String
    public let createdAt: String
}

/// A manifest plus the stored chunk bytes to upload — mirrors `EncryptedBlob`.
public struct EncryptedBlob {
    public let manifest: BlobManifest
    public let chunks: [(hash: String, bytes: Data)]
}

public enum BlobError: Error, Equatable {
    case badChunkSize, ownerMismatch, noChunk(Int), chunkHashMismatch,
         chunkCountMismatch, sizeMismatch, integrity
}

/// Port of `encryptBlob` / `decryptBlobChunk` / `decryptBlob`. Each chunk is
/// AES-GCM sealed with AAD `canonicalJson({v:1, ownerId, blobId, index})` and
/// stored as `nonce ‖ ciphertext‖tag`, content-addressed by its SHA-256.
public enum Blob {
    public static let defaultChunkBytes = 256 * 1024
    private static let nonceBytes = 12

    public static func encrypt(
        _ data: Data, identity: Identity, mimeType: String,
        chunkSize: Int = defaultChunkBytes, blobId: String? = nil, createdAt: String? = nil
    ) throws -> EncryptedBlob {
        guard chunkSize > 0 else { throw BlobError.badChunkSize }
        let blobId = blobId ?? Base64URL.encode(Crypto.randomBytes(16))
        var chunks: [(hash: String, bytes: Data)] = []
        var refs: [BlobChunkRef] = []
        var offset = 0
        while offset < data.count {
            let plaintext = data.subdata(in: data.startIndex + offset ..< data.startIndex + min(offset + chunkSize, data.count))
            let nonce = Crypto.randomBytes(nonceBytes)
            let stored = nonce + (try Crypto.aesGcmSeal(
                key: identity.dataKey, nonce: nonce, plaintext: plaintext,
                aad: aad(identity.ownerId, blobId, chunks.count)))
            let hash = Base64URL.encode(Crypto.sha256(stored))
            chunks.append((hash, stored))
            refs.append(BlobChunkRef(hash: hash, size: stored.count, plaintextSize: plaintext.count))
            offset += chunkSize
        }
        let manifest = BlobManifest(
            version: 1, ownerId: identity.ownerId, blobId: blobId, mimeType: mimeType,
            byteSize: data.count, chunkSize: chunkSize, chunks: refs,
            sha256: Base64URL.encode(Crypto.sha256(data)),
            createdAt: createdAt ?? isoNow())
        return EncryptedBlob(manifest: manifest, chunks: chunks)
    }

    /// One stored chunk, hash-verified before decrypting.
    public static func decryptChunk(_ stored: Data, index: Int, manifest: BlobManifest,
                                    identity: Identity) throws -> Data {
        guard manifest.ownerId == identity.ownerId else { throw BlobError.ownerMismatch }
        guard manifest.chunks.indices.contains(index) else { throw BlobError.noChunk(index) }
        guard Base64URL.encode(Crypto.sha256(stored)) == manifest.chunks[index].hash else {
            throw BlobError.chunkHashMismatch
        }
        let bytes = Data(stored)
        return try Crypto.aesGcmOpen(
            key: identity.dataKey, nonce: bytes.prefix(nonceBytes),
            ciphertextAndTag: bytes.dropFirst(nonceBytes),
            aad: aad(manifest.ownerId, manifest.blobId, index))
    }

    /// The whole blob from its stored chunks in manifest order.
    public static func decrypt(_ stored: [Data], manifest: BlobManifest, identity: Identity) throws -> Data {
        guard stored.count == manifest.chunks.count else { throw BlobError.chunkCountMismatch }
        var data = Data()
        for (index, chunk) in stored.enumerated() {
            data += try decryptChunk(chunk, index: index, manifest: manifest, identity: identity)
        }
        guard data.count == manifest.byteSize else { throw BlobError.sizeMismatch }
        guard Base64URL.encode(Crypto.sha256(data)) == manifest.sha256 else { throw BlobError.integrity }
        return data
    }

    private static func aad(_ ownerId: String, _ blobId: String, _ index: Int) -> Data {
        JSONValue.object(["v": .int(1), "ownerId": .string(ownerId), "blobId": .string(blobId),
                          "index": .int(index)]).canonicalData()
    }

    private static func isoNow() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }
}
