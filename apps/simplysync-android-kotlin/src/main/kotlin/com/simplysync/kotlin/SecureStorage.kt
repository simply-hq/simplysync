package com.simplysync.kotlin

import java.util.concurrent.ConcurrentHashMap

/**
 * Stores the recovery secret in the OS secret store — the Kotlin port of the
 * engine's `SecureStorage`. On Android, back it with the Keystore /
 * EncryptedSharedPreferences; for tests use [InMemorySecureStorage].
 */
interface SecureStorage {
    fun getItem(key: String): String?
    fun setItem(key: String, value: String)
    fun removeItem(key: String)
}

/** A process-memory secure store — used by host tests and any non-Android context. */
class InMemorySecureStorage(seed: Map<String, String> = emptyMap()) : SecureStorage {
    private val items = ConcurrentHashMap<String, String>(seed)
    override fun getItem(key: String): String? = items[key]
    override fun setItem(key: String, value: String) { items[key] = value }
    override fun removeItem(key: String) { items.remove(key) }
}
