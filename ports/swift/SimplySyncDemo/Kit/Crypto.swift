import Foundation
import CryptoKit

/// Low-level primitives that mirror @simplysync/protocol/src/crypto.ts:
/// HMAC, the HKDF-style `deriveBytes`, SLIP-21, canonical JSON, and AES-GCM.
enum Crypto {
    /// Matches the fixed protocol-v1 derivation salt bytes.
    static let derivationSalt = Data([
        115, 98, 116, 45, 108, 111, 99, 97, 108,
        45, 102, 105, 114, 115, 116, 45, 118, 49,
    ])

    // MARK: HMAC / hashing

    static func hmacSHA256(key: Data, data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    static func hmacSHA512(key: Data, data: Data) -> Data {
        Data(HMAC<SHA512>.authenticationCode(for: data, using: SymmetricKey(data: key)))
    }

    static func sha256(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

    // MARK: deriveBytes (HKDF over HMAC-SHA256)

    /// RFC 5869 HKDF with salt = `derivationSalt`, info = `label`, hash = SHA-256.
    /// Byte-identical to the engine's `deriveBytes(secret, label, byteLength)`.
    static func deriveBytes(secret: Data, label: String, byteLength: Int) -> Data {
        let prk = hmacSHA256(key: derivationSalt, data: secret)
        let info = Data(label.utf8)
        var output = Data()
        var previous = Data()
        var blockIndex: UInt8 = 1
        while output.count < byteLength {
            var input = Data()
            input.append(previous)
            input.append(info)
            input.append(blockIndex)
            previous = hmacSHA256(key: prk, data: input)
            output.append(previous)
            blockIndex &+= 1
        }
        return output.prefix(byteLength)
    }

    // MARK: SLIP-21

    /// SLIP-21 hierarchical symmetric derivation. Returns the lower 32 bytes of
    /// the final node, matching `createSlip21(seed, path)`.
    static func slip21(seed: Data, path: [String]) -> Data {
        var node = hmacSHA512(key: Data("Symmetric key seed".utf8), data: seed)
        for label in path {
            var message = Data([0x00])
            message.append(Data(label.utf8))
            let key = node.prefix(32)
            node = hmacSHA512(key: Data(key), data: message)
        }
        return Data(node.suffix(32))
    }

    // MARK: AES-GCM (WebCrypto-compatible: ciphertext on the wire is ct‖tag)

    static func aesGcmSeal(key: Data, nonce: Data, plaintext: Data, aad: Data) throws -> Data {
        let box = try AES.GCM.seal(
            plaintext,
            using: SymmetricKey(data: key),
            nonce: try AES.GCM.Nonce(data: nonce),
            authenticating: aad
        )
        return box.ciphertext + box.tag
    }

    static func aesGcmOpen(key: Data, nonce: Data, ciphertextAndTag: Data, aad: Data) throws -> Data {
        guard ciphertextAndTag.count >= 16 else { throw CryptoError.malformed }
        let tag = ciphertextAndTag.suffix(16)
        let ciphertext = ciphertextAndTag.prefix(ciphertextAndTag.count - 16)
        let box = try AES.GCM.SealedBox(
            nonce: try AES.GCM.Nonce(data: nonce),
            ciphertext: ciphertext,
            tag: tag
        )
        return try AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }

    static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        for i in 0..<count { bytes[i] = UInt8.random(in: 0...255) }
        return Data(bytes)
    }

    enum CryptoError: Error { case malformed }
}
