package com.simplysync.kotlin

/**
 * Minimal BIP39 (English) decoder: normalize, validate, and recover entropy —
 * the inputs the protocol's SLIP-21 identity derivation needs. Mirrors
 * @scure/bip39's `mnemonicToEntropy` / `validateMnemonic` and the Swift BIP39.
 */
object Bip39 {
    private val indexByWord: Map<String, Int> by lazy {
        HashMap<String, Int>(2048 * 2).apply {
            Bip39Wordlist.words.forEachIndexed { i, w -> put(w, i) }
        }
    }

    class Bip39Exception(message: String) : Exception(message)

    // The exact character set JavaScript's /\s/u matches, so this normalizes a
    // phrase byte-identically to `normalizeMnemonic` (TS). A phrase pasted with
    // non-breaking or thin spaces (from a PDF or password manager) must derive
    // the same identity here as on web, or "works on one device" is
    // indistinguishable from a lost recovery phrase. Only the whitespace class
    // is widened — a standard space-separated phrase is unaffected.
    private val MNEMONIC_WS = Regex(
        "[\\u0009\\u000A\\u000B\\u000C\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+"
    )

    /** Trim, lowercase, collapse internal whitespace — matches `normalizeMnemonic`. */
    fun normalize(mnemonic: String): String =
        MNEMONIC_WS.replace(mnemonic, " ").trim().lowercase()

    fun isValid(mnemonic: String): Boolean = try {
        entropy(normalize(mnemonic)); true
    } catch (_: Exception) {
        false
    }

    /** Recovers the entropy bytes, validating the BIP39 checksum. Throws on any invalid phrase. */
    fun entropy(mnemonic: String): ByteArray {
        val words = normalize(mnemonic).split(" ").filter { it.isNotEmpty() }
        if (words.size !in intArrayOf(12, 15, 18, 21, 24)) throw Bip39Exception("wordCount")

        val bits = ArrayList<Int>(words.size * 11)
        for (word in words) {
            val index = indexByWord[word] ?: throw Bip39Exception("unknownWord:$word")
            for (shift in 10 downTo 0) bits.add((index shr shift) and 1)
        }

        val totalBits = bits.size
        val checksumBits = totalBits / 33
        val entropyBits = totalBits - checksumBits

        val entropy = pack(bits, 0, entropyBits)
        val expected = Crypto.sha256(entropy)
        for (i in 0 until checksumBits) {
            val expectedBit = (expected[i / 8].toInt() shr (7 - (i % 8))) and 1
            if (bits[entropyBits + i] != expectedBit) throw Bip39Exception("checksum")
        }
        return entropy
    }

    /**
      * Generates a fresh mnemonic from random entropy (128 bits → 12 words by
      * default, matching the TS `createMnemonic`). Longer phrases stay valid —
      * [entropy] accepts 12/15/18/21/24 — so existing 24-word owners are
      * unaffected; this only bounds what new phrases look like.
      */
    fun generate(strengthBits: Int = 128): String = fromEntropy(Crypto.randomBytes(strengthBits / 8))

    /** Standard BIP39 entropy → mnemonic (entropy bits + checksum bits → 11-bit word indices). */
    fun fromEntropy(entropy: ByteArray): String {
        val entropyBits = entropy.size * 8
        val checksumBits = entropyBits / 32
        val hash = Crypto.sha256(entropy)
        val bits = ArrayList<Int>(entropyBits + checksumBits)
        for (b in entropy) for (shift in 7 downTo 0) bits.add((b.toInt() shr shift) and 1)
        for (i in 0 until checksumBits) bits.add((hash[i / 8].toInt() shr (7 - (i % 8))) and 1)
        val words = ArrayList<String>(bits.size / 11)
        var i = 0
        while (i < bits.size) {
            var index = 0
            for (j in 0 until 11) index = (index shl 1) or bits[i + j]
            words.add(Bip39Wordlist.words[index])
            i += 11
        }
        return words.joinToString(" ")
    }

    private fun pack(bits: List<Int>, start: Int, end: Int): ByteArray {
        val bytes = ArrayList<Byte>((end - start) / 8 + 1)
        var current = 0
        var count = 0
        for (i in start until end) {
            current = (current shl 1) or bits[i]
            count++
            if (count == 8) {
                bytes.add(current.toByte())
                current = 0
                count = 0
            }
        }
        return bytes.toByteArray()
    }
}
