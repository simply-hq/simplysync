package com.simplysync.kotlin

/**
 * base64url (RFC 4648 §5, no padding) — the only encoding simplysync puts on the
 * wire. Uses no platform codec: java.util.Base64 is absent on Android API 24–25.
 */
object Base64Url {
    private const val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    private val decoding = IntArray(128) { -1 }.also { values ->
        alphabet.forEachIndexed { index, char -> values[char.code] = index }
    }

    fun encode(data: ByteArray): String = buildString {
        var buffer = 0
        var bits = 0
        for (byte in data) {
            buffer = (buffer shl 8) or (byte.toInt() and 255)
            bits += 8
            while (bits >= 6) {
                bits -= 6
                append(alphabet[(buffer ushr bits) and 63])
            }
        }
        if (bits > 0) append(alphabet[(buffer shl (6 - bits)) and 63])
    }

    /** Returns null on malformed input, retaining the existing padding tolerance. */
    fun decode(value: String): ByteArray? {
        // Accept the standard alphabet and stray padding as before.
        val normalized = value.replace('+', '-').replace('/', '_').replace("=", "")
        val remainder = normalized.length % 4
        if (remainder == 1) return null
        val output = ByteArray((normalized.length / 4) * 3 + when (remainder) {
            2 -> 1
            3 -> 2
            else -> 0
        })
        var buffer = 0
        var bits = 0
        var written = 0
        for (char in normalized) {
            val digit = if (char.code < decoding.size) decoding[char.code] else -1
            if (digit < 0) return null
            buffer = (buffer shl 6) or digit
            bits += 6
            if (bits >= 8) {
                bits -= 8
                output[written++] = (buffer ushr bits).toByte()
            }
        }
        return output
    }
}
