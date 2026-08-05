import Foundation

/// A derived sync identity — the Swift port of `LocalFirstIdentity`. `ownerId`
/// and `relayAuth` are base64url; `dataKey`/`streamKey` are raw bytes.
public struct Identity {
    public enum Source { case recoveryKey, mnemonic }

    public let recoveryKey: String
    public let ownerId: String
    public let relayAuth: String
    public let dataKey: Data
    public let streamKey: Data
    public let source: Source
    public let mnemonic: String?
}

public enum IdentityError: Error {
    case badRecoveryKeyPrefix
    case badRecoveryKeyLength
    case invalidInput
}

public enum IdentityDeriver {
    public static let recoveryKeyPrefix = "sf1_"
    private static let ownerIdBytes = 16
    private static let derivedKeyBytes = 32
    private static let writeKeyBytes = 16

    private static let ownerIdPath = ["SimplySync", "OwnerIdBytes"]
    private static let encryptionKeyPath = ["SimplySync", "OwnerEncryptionKey"]
    private static let writeKeyPath = ["SimplySync", "OwnerWriteKey"]

    /// Auto-detects an `sf1_` recovery key vs a BIP39 phrase, exactly like the
    /// TypeScript `deriveIdentity`.
    public static func derive(from recoveryKey: String) throws -> Identity {
        let trimmed = recoveryKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.hasPrefix(recoveryKeyPrefix) && BIP39.isValid(trimmed) {
            return try fromMnemonic(trimmed)
        }
        return try fromRecoveryKey(trimmed)
    }

    public static func fromRecoveryKey(_ recoveryKey: String) throws -> Identity {
        let normalized = recoveryKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let secret = try decodeRecoveryKey(normalized)
        let owner = Crypto.deriveBytes(secret: secret, label: "owner-id", byteLength: ownerIdBytes)
        let dataKey = Crypto.deriveBytes(secret: secret, label: "data-key", byteLength: derivedKeyBytes)
        let relayAuth = Crypto.deriveBytes(secret: secret, label: "relay-auth", byteLength: derivedKeyBytes)
        let streamKey = Crypto.deriveBytes(secret: secret, label: "stream-key", byteLength: derivedKeyBytes)
        return Identity(
            recoveryKey: normalized,
            ownerId: Base64URL.encode(owner),
            relayAuth: Base64URL.encode(relayAuth),
            dataKey: dataKey,
            streamKey: streamKey,
            source: .recoveryKey,
            mnemonic: nil
        )
    }

    public static func fromMnemonic(_ mnemonic: String) throws -> Identity {
        let normalized = BIP39.normalize(mnemonic)
        let entropy = try BIP39.entropy(from: normalized)
        let owner = Crypto.slip21(seed: entropy, path: ownerIdPath).prefix(ownerIdBytes)
        let encryptionKey = Crypto.slip21(seed: entropy, path: encryptionKeyPath)
        let writeKey = Crypto.slip21(seed: entropy, path: writeKeyPath).prefix(writeKeyBytes)
        let streamKey = Crypto.deriveBytes(secret: encryptionKey, label: "stream-key", byteLength: derivedKeyBytes)
        return Identity(
            recoveryKey: normalized,
            ownerId: Base64URL.encode(Data(owner)),
            relayAuth: Base64URL.encode(Data(writeKey)),
            dataKey: encryptionKey,
            streamKey: streamKey,
            source: .mnemonic,
            mnemonic: normalized
        )
    }

    /// Generates a fresh native recovery key (`sf1_` + 32 random bytes).
    public static func createRecoveryKey() -> String {
        recoveryKeyPrefix + Base64URL.encode(Crypto.randomBytes(32))
    }

    private static func decodeRecoveryKey(_ recoveryKey: String) throws -> Data {
        guard recoveryKey.hasPrefix(recoveryKeyPrefix) else { throw IdentityError.badRecoveryKeyPrefix }
        let body = String(recoveryKey.dropFirst(recoveryKeyPrefix.count))
        guard let secret = Base64URL.decode(body), secret.count == derivedKeyBytes else {
            throw IdentityError.badRecoveryKeyLength
        }
        return secret
    }
}
