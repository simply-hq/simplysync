package com.simplysync.kotlin

import kotlinx.serialization.Serializable

/**
 * Encrypted DB-snapshot envelope — port of the protocol's snapshot-crypto.ts.
 * Two keyings:
 *   "recovery-phrase" — key = deriveBackupKeyBytes(phrase) (default)
 *   "passphrase"      — key = PBKDF2-HMAC-SHA256(passphrase, salt, iterations)
 * AES-256-GCM with ciphertext and 16-byte tag stored separately (base64url).
 */
@Serializable
data class EncryptedEnvelopeV1(
    val format: String,
    val version: Int,
    val keying: String,
    val ownerId: String? = null,
    val kdf: Kdf? = null,
    val cipher: Cipher,
    val ciphertext: String,
) {
    @Serializable
    data class Cipher(val algo: String, val nonce: String, val tag: String)

    @Serializable
    data class Kdf(val algo: String, val hash: String, val iterations: Int, val salt: String)

    val isValid: Boolean
        get() {
            if (format != SnapshotCrypto.FORMAT || version != 1 || cipher.algo != "AES-256-GCM") return false
            if (keying == "recovery-phrase") return ownerId != null
            if (keying == "passphrase") return kdf?.algo == "PBKDF2"
            return false
        }
}

class SnapshotCryptoException(message: String) : Exception(message)

object SnapshotCrypto {
    const val FORMAT = "simplysync-db-snapshot"
    const val DEFAULT_ITERATIONS = 600_000
    // Upper bound on the iteration count read from an untrusted backup file, so
    // a tampered envelope can't pin a restore to an arbitrarily large KDF cost
    // (a denial-of-restore / foreground hang). Matches the TypeScript port.
    private const val MAX_ITERATIONS = 10_000_000
    private const val SALT_BYTES = 16
    private const val NONCE_BYTES = 12
    private const val KEY_BYTES = 32

    private val backupKeyPath = listOf("SimplySync", "BackupKey")

    /** mnemonic → SLIP-21 [SimplySync, BackupKey]; native sf1_ key → HKDF label "backup-key". */
    fun deriveBackupKeyBytes(recoveryKey: String): ByteArray {
        val trimmed = recoveryKey.trim()
        if (!trimmed.startsWith(IdentityDeriver.RECOVERY_KEY_PREFIX) && Bip39.isValid(trimmed)) {
            val entropy = Bip39.entropy(Bip39.normalize(trimmed))
            return Crypto.slip21(entropy, backupKeyPath)
        }
        if (!trimmed.startsWith(IdentityDeriver.RECOVERY_KEY_PREFIX)) throw IdentityException("badRecoveryKeyLength")
        val secret = Base64Url.decode(trimmed.substring(IdentityDeriver.RECOVERY_KEY_PREFIX.length))
        if (secret == null || secret.size != 32) throw IdentityException("badRecoveryKeyLength")
        return Crypto.deriveBytes(secret, "backup-key", 32)
    }

    private data class Sealed(val nonce: String, val tag: String, val ciphertext: String)

    private fun seal(key: ByteArray, plaintext: String): Sealed {
        val nonce = Crypto.randomBytes(NONCE_BYTES)
        val sealed = Crypto.aesGcmSeal(key, nonce, plaintext.toByteArray(Charsets.UTF_8), ByteArray(0))
        val tag = sealed.copyOfRange(sealed.size - 16, sealed.size)
        val body = sealed.copyOfRange(0, sealed.size - 16)
        return Sealed(Base64Url.encode(nonce), Base64Url.encode(tag), Base64Url.encode(body))
    }

    private fun open(key: ByteArray, nonce: String, tag: String, ciphertext: String): String {
        val nonceData = Base64Url.decode(nonce) ?: throw SnapshotCryptoException("invalidEnvelope")
        val tagData = Base64Url.decode(tag) ?: throw SnapshotCryptoException("invalidEnvelope")
        val bodyData = Base64Url.decode(ciphertext) ?: throw SnapshotCryptoException("invalidEnvelope")
        return try {
            String(Crypto.aesGcmOpen(key, nonceData, bodyData + tagData, ByteArray(0)), Charsets.UTF_8)
        } catch (_: Exception) {
            throw SnapshotCryptoException("decryptFailed")
        }
    }

    fun encryptStringWithKey(key: ByteArray, plaintext: String, ownerId: String): EncryptedEnvelopeV1 {
        val sealed = seal(key, plaintext)
        return EncryptedEnvelopeV1(
            format = FORMAT, version = 1, keying = "recovery-phrase", ownerId = ownerId, kdf = null,
            cipher = EncryptedEnvelopeV1.Cipher("AES-256-GCM", sealed.nonce, sealed.tag),
            ciphertext = sealed.ciphertext,
        )
    }

    fun decryptStringWithKey(key: ByteArray, envelope: EncryptedEnvelopeV1): String {
        if (!envelope.isValid || envelope.keying != "recovery-phrase") throw SnapshotCryptoException("invalidEnvelope")
        return open(key, envelope.cipher.nonce, envelope.cipher.tag, envelope.ciphertext)
    }

    fun encryptStringWithPassphrase(
        passphrase: String,
        plaintext: String,
        iterations: Int = DEFAULT_ITERATIONS,
    ): EncryptedEnvelopeV1 {
        if (passphrase.isEmpty()) throw SnapshotCryptoException("emptyPassphrase")
        val salt = Crypto.randomBytes(SALT_BYTES)
        val key = Crypto.pbkdf2(passphrase, salt, iterations, KEY_BYTES)
        val sealed = seal(key, plaintext)
        return EncryptedEnvelopeV1(
            format = FORMAT, version = 1, keying = "passphrase", ownerId = null,
            kdf = EncryptedEnvelopeV1.Kdf("PBKDF2", "SHA-256", iterations, Base64Url.encode(salt)),
            cipher = EncryptedEnvelopeV1.Cipher("AES-256-GCM", sealed.nonce, sealed.tag),
            ciphertext = sealed.ciphertext,
        )
    }

    fun decryptStringWithPassphrase(passphrase: String, envelope: EncryptedEnvelopeV1): String {
        val kdf = envelope.kdf
        if (!envelope.isValid || envelope.keying != "passphrase" || kdf == null) throw SnapshotCryptoException("invalidEnvelope")
        if (kdf.iterations <= 0 || kdf.iterations > MAX_ITERATIONS) throw SnapshotCryptoException("invalidEnvelope")
        val salt = Base64Url.decode(kdf.salt) ?: throw SnapshotCryptoException("invalidEnvelope")
        val key = Crypto.pbkdf2(passphrase, salt, kdf.iterations, KEY_BYTES)
        return open(key, envelope.cipher.nonce, envelope.cipher.tag, envelope.ciphertext)
    }
}
