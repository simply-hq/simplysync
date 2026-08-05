import Foundation

/// Minimal BIP39 (English) decoder: normalize, validate, and recover entropy —
/// the inputs the protocol's SLIP-21 identity derivation needs. Mirrors
/// @scure/bip39's `mnemonicToEntropy` / `validateMnemonic`.
public enum BIP39 {
    private static let indexByWord: [String: Int] = {
        var map = [String: Int](minimumCapacity: 2048)
        for (i, w) in BIP39Wordlist.words.enumerated() { map[w] = i }
        return map
    }()

    /// Trim, lowercase, collapse internal whitespace — matches `normalizeMnemonic`.
    public static func normalize(_ mnemonic: String) -> String {
        let lowered = mnemonic.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let parts = lowered.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "\n" || $0 == "\r" })
        return parts.joined(separator: " ")
    }

    public static func isValid(_ mnemonic: String) -> Bool {
        (try? entropy(from: mnemonic)) != nil
    }

    /// Recovers the entropy bytes, validating the BIP39 checksum. Throws on any
    /// invalid phrase.
    public static func entropy(from mnemonic: String) throws -> Data {
        let words = normalize(mnemonic).split(separator: " ").map(String.init)
        guard [12, 15, 18, 21, 24].contains(words.count) else { throw Error.wordCount }

        var bits = [UInt8]()
        bits.reserveCapacity(words.count * 11)
        for word in words {
            guard let index = indexByWord[word] else { throw Error.unknownWord(word) }
            for shift in stride(from: 10, through: 0, by: -1) {
                bits.append(UInt8((index >> shift) & 1))
            }
        }

        let totalBits = bits.count
        let checksumBits = totalBits / 33
        let entropyBits = totalBits - checksumBits

        let entropy = pack(bits[0..<entropyBits])
        let expected = Crypto.sha256(entropy)
        // The checksum is the first `checksumBits` bits of SHA-256(entropy).
        for i in 0..<checksumBits {
            let expectedBit = (expected[i / 8] >> (7 - (i % 8))) & 1
            if bits[entropyBits + i] != expectedBit { throw Error.checksum }
        }
        return entropy
    }

    private static func pack(_ bits: ArraySlice<UInt8>) -> Data {
        var bytes = [UInt8]()
        var current: UInt8 = 0
        var count = 0
        for bit in bits {
            current = (current << 1) | bit
            count += 1
            if count == 8 {
                bytes.append(current)
                current = 0
                count = 0
            }
        }
        return Data(bytes)
    }

    public enum Error: Swift.Error, Equatable {
        case wordCount
        case unknownWord(String)
        case checksum
    }
}
