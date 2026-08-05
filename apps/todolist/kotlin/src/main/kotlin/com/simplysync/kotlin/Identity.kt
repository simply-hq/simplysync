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

/**
 * Versioned SLIP-21 profile for mnemonic-derived identities.
 *
 * `sf1_` recovery keys do not use these paths and are identical under either
 * profile. The legacy profile exists so Android apps that previously inherited
 * Evolu's paths can upgrade without silently switching owners.
 */
enum class MnemonicIdentityProfile(val storageValue: String) {
    SIMPLYSYNC_V1("simplysync-v1"),
    EVOLU_LEGACY_V1("evolu-v1"),
    ;

    companion object {
        fun fromStorage(value: String?): MnemonicIdentityProfile? =
            entries.firstOrNull { it.storageValue == value }
    }
}

object IdentityDeriver {
    const val RECOVERY_KEY_PREFIX = "sf1_"
    private const val OWNER_ID_BYTES = 16
    private const val DERIVED_KEY_BYTES = 32
    private const val WRITE_KEY_BYTES = 16

    /** Auto-detects an `sf1_` recovery key vs a BIP39 phrase, like the TS `deriveIdentity`. */
    fun derive(recoveryKey: String): Identity =
        derive(recoveryKey, MnemonicIdentityProfile.SIMPLYSYNC_V1)

    /**
     * Derive with an explicit mnemonic profile. Existing one-argument callers
     * keep the cross-platform SimplySync behavior; only BIP39 phrases consult
     * [mnemonicProfile].
     */
    fun derive(
        recoveryKey: String,
        mnemonicProfile: MnemonicIdentityProfile,
    ): Identity {
        val trimmed = recoveryKey.trim()
        return if (!trimmed.startsWith(RECOVERY_KEY_PREFIX) && Bip39.isValid(trimmed)) {
            fromMnemonic(trimmed, mnemonicProfile)
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

    fun fromMnemonic(mnemonic: String): Identity =
        fromMnemonic(mnemonic, MnemonicIdentityProfile.SIMPLYSYNC_V1)

    fun fromMnemonic(
        mnemonic: String,
        profile: MnemonicIdentityProfile,
    ): Identity {
        val normalized = Bip39.normalize(mnemonic)
        val entropy = Bip39.entropy(normalized)
        val prefix = when (profile) {
            MnemonicIdentityProfile.SIMPLYSYNC_V1 -> "SimplySync"
            MnemonicIdentityProfile.EVOLU_LEGACY_V1 -> "Evolu"
        }
        val owner = Crypto.slip21(entropy, listOf(prefix, "OwnerIdBytes")).copyOf(OWNER_ID_BYTES)
        val encryptionKey = Crypto.slip21(entropy, listOf(prefix, "OwnerEncryptionKey"))
        val writeKey = Crypto.slip21(entropy, listOf(prefix, "OwnerWriteKey")).copyOf(WRITE_KEY_BYTES)
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
