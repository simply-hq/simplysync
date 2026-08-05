package com.simplysync.kotlin

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncKitTest {
    private val abandonMnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    @Test
    fun base64urlRoundTrips() {
        val bytes = ByteArray(20) { it.toByte() }
        val encoded = Base64Url.encode(bytes)
        assertTrue(!encoded.contains('+') && !encoded.contains('/') && !encoded.contains('='))
        assertArrayEquals(bytes, Base64Url.decode(encoded))
    }

    @Test
    fun bip39AbandonVectorIsAllZeroEntropy() {
        // The canonical BIP39 test phrase has 16 bytes of zero entropy.
        assertTrue(Bip39.isValid(abandonMnemonic))
        assertArrayEquals(ByteArray(16), Bip39.entropy(abandonMnemonic))
    }

    @Test
    fun bip39RejectsBadChecksum() {
        assertTrue(!Bip39.isValid("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon"))
    }

    @Test
    fun canonicalJsonSortsKeysAndEscapes() {
        val obj = JsonValue.Obj(linkedMapOf(
            "b" to JsonValue.IntVal(2),
            "a" to JsonValue.Str("x\"y"),
        ))
        assertEquals("{\"a\":\"x\\\"y\",\"b\":2}", obj.canonical())
    }

    @Test
    fun hlcOrdersLexicographicallyAndMonotonic() {
        var t = 1000L
        val clock = HlcClock("dev1", nowMillis = { t })
        val a = clock.next()
        val b = clock.next() // same millis -> counter bumps
        t = 1001L
        val c = clock.next()
        assertTrue(Hlc.compare(a, b) < 0)
        assertTrue(Hlc.compare(b, c) < 0)
        assertEquals(0, Hlc.compare(a, a))
        assertEquals(-1, Hlc.compare(null, a))
    }

    @Test
    fun identityUsesSimplySyncPathsAndIsStable() {
        // Regression: mnemonic-derived identity is stable and cross-language
        // compatible via the SLIP-21 "SimplySync" paths (matching TS/Swift) —
        // reconciled from the old "Evolu" pin (PROTO-01). The exact
        // cross-language ownerId/ciphertext is asserted in ConformanceTest
        // against the shared corpus; this just checks stability + shape.
        val id1 = IdentityDeriver.fromMnemonic(abandonMnemonic)
        val id2 = IdentityDeriver.derive(abandonMnemonic)
        assertEquals(id1.ownerId, id2.ownerId)
        assertEquals(id1.relayAuth, id2.relayAuth)
        assertEquals(Identity.Source.MNEMONIC, id2.source)
        assertEquals(32, id1.dataKey.size)
        // ownerId is base64url of 16 bytes -> 22 chars, no padding.
        assertEquals(22, id1.ownerId.length)
    }

    @Test
    fun legacyMnemonicIdentityProfileRemainsStableForUpgrades() {
        val current = IdentityDeriver.derive(abandonMnemonic)
        val explicitCurrent = IdentityDeriver.derive(
            abandonMnemonic,
            MnemonicIdentityProfile.SIMPLYSYNC_V1,
        )
        val legacy = IdentityDeriver.derive(
            abandonMnemonic,
            MnemonicIdentityProfile.EVOLU_LEGACY_V1,
        )

        assertEquals("the one-argument API remains cross-platform", current, explicitCurrent)
        assertNotEquals("legacy Android data keeps its distinct owner", current.ownerId, legacy.ownerId)
        assertEquals(
            "the legacy owner is pinned so upgrades cannot silently orphan data",
            "F0xh0HpiAx5shgCgtGENww",
            legacy.ownerId,
        )
        assertEquals(
            "legacy derivation is deterministic across both entry points",
            legacy,
            IdentityDeriver.fromMnemonic(
                abandonMnemonic,
                MnemonicIdentityProfile.EVOLU_LEGACY_V1,
            ),
        )

        val recoveryKey = IdentityDeriver.createRecoveryKey()
        assertEquals(
            "`sf1_` keys never depend on the mnemonic profile",
            IdentityDeriver.derive(recoveryKey, MnemonicIdentityProfile.SIMPLYSYNC_V1),
            IdentityDeriver.derive(recoveryKey, MnemonicIdentityProfile.EVOLU_LEGACY_V1),
        )
    }

    @Test
    fun nativeRecoveryKeyDerivesAndRoundTrips() {
        val key = IdentityDeriver.createRecoveryKey()
        assertTrue(key.startsWith("sf1_"))
        val id = IdentityDeriver.derive(key)
        assertEquals(Identity.Source.RECOVERY_KEY, id.source)
        assertEquals(IdentityDeriver.fromRecoveryKey(key).ownerId, id.ownerId)
    }

    @Test
    fun envelopeRoundTripsAndRejectsOtherOwner() {
        val identity = IdentityDeriver.fromMnemonic(abandonMnemonic)
        val payload = SyncPayload(
            schemaVersion = 1, table = "account", op = "upsert", rowId = "row1",
            hlc = "0000000abc-0000-dev1",
            value = linkedMapOf(
                "name" to JsonValue.Str("Checking"),
                "order" to JsonValue.IntVal(0),
                "isDeleted" to JsonValue.IntVal(0),
            ),
        )
        val env = Envelope.encrypt(identity, payload.hlc, "dev1", "2026-01-01T00:00:00.000Z", payload)
        assertEquals(identity.ownerId, env.ownerId)
        assertEquals(22, env.streamId!!.length)
        val decrypted = Envelope.decrypt(identity, env)
        assertEquals(payload.table, decrypted.table)
        assertEquals(payload.rowId, decrypted.rowId)
        assertEquals(JsonValue.Str("Checking"), decrypted.value["name"])
        assertEquals(JsonValue.IntVal(0), decrypted.value["order"])

        // A different identity must not decrypt it (owner mismatch / GCM failure).
        val other = IdentityDeriver.createRecoveryKey().let { IdentityDeriver.derive(it) }
        var failed = false
        try { Envelope.decrypt(other, env) } catch (_: Exception) { failed = true }
        assertTrue(failed)
    }

    @Test
    fun snapshotRecoveryPhraseAndPassphraseRoundTrip() {
        val identity = IdentityDeriver.fromMnemonic(abandonMnemonic)
        val key = SnapshotCrypto.deriveBackupKeyBytes(identity.recoveryKey)
        val plaintext = "{\"format\":\"simplysync-db-snapshot\",\"hello\":\"world\"}"
        val env = SnapshotCrypto.encryptStringWithKey(key, plaintext, identity.ownerId)
        assertTrue(env.isValid)
        assertEquals(plaintext, SnapshotCrypto.decryptStringWithKey(key, env))

        val passEnv = SnapshotCrypto.encryptStringWithPassphrase("hunter2", plaintext, iterations = 1000)
        assertEquals(plaintext, SnapshotCrypto.decryptStringWithPassphrase("hunter2", passEnv))
    }

    @Test
    fun pbkdf2MatchesKnownLength() {
        val out = Crypto.pbkdf2("password", "salt".toByteArray(), 1, 32)
        assertEquals(32, out.size)
        // Different iteration counts produce different keys.
        assertNotEquals(
            out.toList(),
            Crypto.pbkdf2("password", "salt".toByteArray(), 2, 32).toList(),
        )
    }
}
