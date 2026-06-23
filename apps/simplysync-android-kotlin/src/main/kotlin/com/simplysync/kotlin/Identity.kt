package com.simplysync.kotlin

/**
 * A derived sync identity — the Kotlin port of `LocalFirstIdentity` /
 * SimplySyncKit's `Identity`. `ownerId` and `relayAuth` are base64url;
 * `dataKey`/`streamKey` are raw bytes.
 */
data class Identity(
    val recoveryKey: String,
    val ownerId: String,
    val relayAuth: String,
    val dataKey: ByteArray,
    val streamKey: ByteArray,
    val source: Source,
    val mnemonic: String?,
) {
    enum class Source { RECOVERY_KEY, MNEMONIC }

    // ByteArray fields need structural equality for tests/round-trips.
    override fun equals(other: Any?): Boolean {
        if (this === other) return true
        if (other !is Identity) return false
        return recoveryKey == other.recoveryKey && ownerId == other.ownerId &&
            relayAuth == other.relayAuth && dataKey.contentEquals(other.dataKey) &&
            streamKey.contentEquals(other.streamKey) && source == other.source &&
            mnemonic == other.mnemonic
    }

    override fun hashCode(): Int {
        var result = recoveryKey.hashCode()
        result = 31 * result + ownerId.hashCode()
        result = 31 * result + relayAuth.hashCode()
        result = 31 * result + dataKey.contentHashCode()
        result = 31 * result + streamKey.contentHashCode()
        result = 31 * result + source.hashCode()
        result = 31 * result + (mnemonic?.hashCode() ?: 0)
        return result
    }
}

class IdentityException(message: String) : Exception(message)

object IdentityDeriver {
    const val RECOVERY_KEY_PREFIX = "sf1_"
    private const val OWNER_ID_BYTES = 16
    private const val DERIVED_KEY_BYTES = 32
    private const val WRITE_KEY_BYTES = 16

    // PINNED to "Evolu" (NOT "SimplySync"): the app migrated from Evolu, so a
    // recovery phrase must resolve to the SAME ownerId / encryption key / write
    // key (= relayAuth) the existing data and relay use. (The export/import-only
    // BackupKey path stays "SimplySync" — see SnapshotCrypto.)
    private val ownerIdPath = listOf("Evolu", "OwnerIdBytes")
    private val encryptionKeyPath = listOf("Evolu", "OwnerEncryptionKey")
    private val writeKeyPath = listOf("Evolu", "OwnerWriteKey")

    /** Auto-detects an `sf1_` recovery key vs a BIP39 phrase, like the TS `deriveIdentity`. */
    fun derive(recoveryKey: String): Identity {
        val trimmed = recoveryKey.trim()
        return if (!trimmed.startsWith(RECOVERY_KEY_PREFIX) && Bip39.isValid(trimmed)) {
            fromMnemonic(trimmed)
        } else {
            fromRecoveryKey(trimmed)
        }
    }

    fun fromRecoveryKey(recoveryKey: String): Identity {
        val normalized = recoveryKey.trim()
        val secret = decodeRecoveryKey(normalized)
        val owner = Crypto.deriveBytes(secret, "owner-id", OWNER_ID_BYTES)
        val dataKey = Crypto.deriveBytes(secret, "data-key", DERIVED_KEY_BYTES)
        val relayAuth = Crypto.deriveBytes(secret, "relay-auth", DERIVED_KEY_BYTES)
        val streamKey = Crypto.deriveBytes(secret, "stream-key", DERIVED_KEY_BYTES)
        return Identity(
            recoveryKey = normalized,
            ownerId = Base64Url.encode(owner),
            relayAuth = Base64Url.encode(relayAuth),
            dataKey = dataKey,
            streamKey = streamKey,
            source = Identity.Source.RECOVERY_KEY,
            mnemonic = null,
        )
    }

    fun fromMnemonic(mnemonic: String): Identity {
        val normalized = Bip39.normalize(mnemonic)
        val entropy = Bip39.entropy(normalized)
        val owner = Crypto.slip21(entropy, ownerIdPath).copyOf(OWNER_ID_BYTES)
        val encryptionKey = Crypto.slip21(entropy, encryptionKeyPath)
        val writeKey = Crypto.slip21(entropy, writeKeyPath).copyOf(WRITE_KEY_BYTES)
        val streamKey = Crypto.deriveBytes(encryptionKey, "stream-key", DERIVED_KEY_BYTES)
        return Identity(
            recoveryKey = normalized,
            ownerId = Base64Url.encode(owner),
            relayAuth = Base64Url.encode(writeKey),
            dataKey = encryptionKey,
            streamKey = streamKey,
            source = Identity.Source.MNEMONIC,
            mnemonic = normalized,
        )
    }

    /** Generates a fresh native recovery key (`sf1_` + 32 random bytes). */
    fun createRecoveryKey(): String = RECOVERY_KEY_PREFIX + Base64Url.encode(Crypto.randomBytes(32))

    private fun decodeRecoveryKey(recoveryKey: String): ByteArray {
        if (!recoveryKey.startsWith(RECOVERY_KEY_PREFIX)) throw IdentityException("badRecoveryKeyPrefix")
        val body = recoveryKey.substring(RECOVERY_KEY_PREFIX.length)
        val secret = Base64Url.decode(body)
        if (secret == null || secret.size != DERIVED_KEY_BYTES) throw IdentityException("badRecoveryKeyLength")
        return secret
    }
}
