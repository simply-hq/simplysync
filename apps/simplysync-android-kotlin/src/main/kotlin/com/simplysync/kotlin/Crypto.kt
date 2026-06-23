package com.simplysync.kotlin

import java.security.MessageDigest
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Low-level primitives that mirror @simplysync/protocol/src/crypto.ts and the
 * Swift SimplySyncKit `Crypto`: HMAC, the HKDF-style `deriveBytes`, SLIP-21,
 * AES-GCM, and PBKDF2.
 */
object Crypto {
    /** Matches the fixed protocol-v1 derivation salt bytes. */
    private val derivationSalt = byteArrayOf(
        115, 98, 116, 45, 108, 111, 99, 97, 108,
        45, 102, 105, 114, 115, 116, 45, 118, 49,
    )
    private val secureRandom = SecureRandom()

    // MARK: HMAC / hashing

    fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        // An all-zero / empty key is illegal for SecretKeySpec; keys here are
        // always non-empty in practice, but guard to mirror Swift's tolerance.
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA256"))
        return mac.doFinal(data)
    }

    fun hmacSha512(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA512")
        mac.init(SecretKeySpec(if (key.isEmpty()) ByteArray(1) else key, "HmacSHA512"))
        return mac.doFinal(data)
    }

    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    // MARK: deriveBytes (HKDF over HMAC-SHA256)

    /**
     * RFC 5869 HKDF with salt = `derivationSalt`, info = `label`, hash = SHA-256.
     * Byte-identical to the engine's `deriveBytes(secret, label, byteLength)`.
     */
    fun deriveBytes(secret: ByteArray, label: String, byteLength: Int): ByteArray {
        val prk = hmacSha256(derivationSalt, secret)
        val info = label.toByteArray(Charsets.UTF_8)
        val output = ArrayList<Byte>(byteLength + 32)
        var previous = ByteArray(0)
        var blockIndex = 1
        while (output.size < byteLength) {
            val input = previous + info + byteArrayOf(blockIndex.toByte())
            previous = hmacSha256(prk, input)
            for (b in previous) output.add(b)
            blockIndex = (blockIndex + 1) and 0xFF
        }
        return output.subList(0, byteLength).toByteArray()
    }

    // MARK: SLIP-21

    /**
     * SLIP-21 hierarchical symmetric derivation. Returns the lower 32 bytes of
     * the final node, matching `createSlip21(seed, path)`.
     */
    fun slip21(seed: ByteArray, path: List<String>): ByteArray {
        var node = hmacSha512("Symmetric key seed".toByteArray(Charsets.UTF_8), seed)
        for (label in path) {
            val message = byteArrayOf(0x00) + label.toByteArray(Charsets.UTF_8)
            val key = node.copyOfRange(0, 32)
            node = hmacSha512(key, message)
        }
        return node.copyOfRange(32, 64)
    }

    // MARK: AES-GCM (WebCrypto-compatible: ciphertext on the wire is ct‖tag)

    fun aesGcmSeal(key: ByteArray, nonce: ByteArray, plaintext: ByteArray, aad: ByteArray): ByteArray {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        if (aad.isNotEmpty()) cipher.updateAAD(aad)
        return cipher.doFinal(plaintext) // returns ct || tag
    }

    fun aesGcmOpen(key: ByteArray, nonce: ByteArray, ciphertextAndTag: ByteArray, aad: ByteArray): ByteArray {
        require(ciphertextAndTag.size >= 16) { "ciphertext too short" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        if (aad.isNotEmpty()) cipher.updateAAD(aad)
        return cipher.doFinal(ciphertextAndTag)
    }

    fun randomBytes(count: Int): ByteArray {
        val bytes = ByteArray(count)
        secureRandom.nextBytes(bytes)
        return bytes
    }

    // MARK: PBKDF2-HMAC-SHA256 (snapshot passphrase keying)

    /**
     * PBKDF2-HMAC-SHA256, implemented over HMAC so it works on minSdk 24 (the
     * SecretKeyFactory "PBKDF2WithHmacSHA256" requires API 26+). NFKC
     * normalization matches the JS/Swift implementations.
     */
    fun pbkdf2(passphrase: String, salt: ByteArray, iterations: Int, keyBytes: Int): ByteArray {
        val normalized = Normalizer.normalize(passphrase, Normalizer.Form.NFKC)
        val password = normalized.toByteArray(Charsets.UTF_8)
        val hLen = 32 // SHA-256 output size
        val blocks = (keyBytes + hLen - 1) / hLen
        val out = ByteArray(blocks * hLen)
        for (i in 1..blocks) {
            val intBlock = byteArrayOf(
                ((i ushr 24) and 0xFF).toByte(),
                ((i ushr 16) and 0xFF).toByte(),
                ((i ushr 8) and 0xFF).toByte(),
                (i and 0xFF).toByte(),
            )
            var u = hmacSha256(password, salt + intBlock)
            val t = u.copyOf()
            for (iter in 2..iterations) {
                u = hmacSha256(password, u)
                for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
            }
            t.copyInto(out, (i - 1) * hLen)
        }
        return out.copyOf(keyBytes)
    }
}
