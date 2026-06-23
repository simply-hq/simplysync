package com.simplysync.kotlin

import java.util.Base64

/**
 * base64url (RFC 4648 §5, no padding) — the only encoding simplysync puts on the
 * wire. Mirrors @simplysync/protocol's base64UrlEncode/Decode and the Swift
 * Base64URL helper exactly.
 */
object Base64Url {
    private val encoder: Base64.Encoder = Base64.getUrlEncoder().withoutPadding()
    private val decoder: Base64.Decoder = Base64.getUrlDecoder()

    fun encode(data: ByteArray): String = encoder.encodeToString(data)

    /** Returns null on malformed input (matches the Swift `Data?` contract). */
    fun decode(value: String): ByteArray? = try {
        // Tolerate standard-alphabet (+/) and stray padding the same way the
        // Swift/JS decoders do: normalize to the url alphabet, strip '='.
        val normalized = value.replace('+', '-').replace('/', '_').replace("=", "")
        decoder.decode(normalized)
    } catch (_: IllegalArgumentException) {
        null
    }
}
