import Foundation

/// Minimal BIP39 (English) codec: normalize, validate, recover entropy, and
/// generate — the inputs the protocol's SLIP-21 identity derivation needs.
/// Mirrors @scure/bip39's `mnemonicToEntropy` / `validateMnemonic` /
/// `generateMnemonic`.
public enum BIP39 {
    private static let indexByWord: [String: Int] = {
        var map = [String: Int](minimumCapacity: 2048)
        for (i, w) in BIP39Wordlist.words.enumerated() { map[w] = i }
        return map
    }()

    /// The exact character set JavaScript's /\s/u matches, so a phrase normalizes
    /// byte-identically to `normalizeMnemonic` (TS). A phrase pasted with
    /// non-breaking or thin spaces (from a PDF or password manager) must derive
    /// the same identity here as on web, or "works on one device" is
    /// indistinguishable from a lost recovery phrase.
    private static let mnemonicWhitespace: Set<Unicode.Scalar> = [
        "\u{0009}", "\u{000A}", "\u{000B}", "\u{000C}", "\u{000D}", "\u{0020}",
        "\u{00A0}", "\u{1680}", "\u{2000}", "\u{2001}", "\u{2002}", "\u{2003}",
        "\u{2004}", "\u{2005}", "\u{2006}", "\u{2007}", "\u{2008}", "\u{2009}",
        "\u{200A}", "\u{2028}", "\u{2029}", "\u{202F}", "\u{205F}", "\u{3000}",
        "\u{FEFF}",
    ]

    /// Trim, lowercase, collapse internal whitespace — matches `normalizeMnemonic`.
    public static func normalize(_ mnemonic: String) -> String {
        let parts = mnemonic.lowercased().split(whereSeparator: { char in
            char.unicodeScalars.count == 1
                && mnemonicWhitespace.contains(char.unicodeScalars.first!)
        })
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

    /// Generates a fresh phrase: 128 bits → 12 words by default, matching the
    /// TS `createMnemonic` and the Kotlin `Bip39.generate`. Longer phrases stay
    /// valid on the way back in (`entropy(from:)` accepts 12/15/18/21/24), so
    /// existing 24-word owners are untouched — this bounds only new phrases.
    public static func createMnemonic(strengthBits: Int = 128) -> String {
        fromEntropy(Crypto.randomBytes(strengthBits / 8))
    }

    /// Standard BIP39 entropy → mnemonic: entropy bits followed by the first
    /// `entropyBits / 32` bits of SHA-256(entropy), read as 11-bit word indices.
    /// The exact inverse of `entropy(from:)` above.
    public static func fromEntropy(_ entropy: Data) -> String {
        let entropyBits = entropy.count * 8
        let checksumBits = entropyBits / 32
        let hash = Crypto.sha256(entropy)

        var bits = [UInt8]()
        bits.reserveCapacity(entropyBits + checksumBits)
        for byte in entropy {
            for shift in stride(from: 7, through: 0, by: -1) {
                bits.append((byte >> UInt8(shift)) & 1)
            }
        }
        for i in 0..<checksumBits {
            bits.append((hash[i / 8] >> (7 - (i % 8))) & 1)
        }

        var words = [String]()
        words.reserveCapacity(bits.count / 11)
        for start in stride(from: 0, to: bits.count, by: 11) {
            var index = 0
            for offset in 0..<11 { index = (index << 1) | Int(bits[start + offset]) }
            words.append(BIP39Wordlist.words[index])
        }
        return words.joined(separator: " ")
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
