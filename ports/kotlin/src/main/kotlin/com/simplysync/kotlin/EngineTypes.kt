package com.simplysync.kotlin

/** The result of a mutation — the Kotlin port of `MutationResult`. */
sealed class MutationResult {
    data class Ok(val value: String) : MutationResult()
    data class Failure(val message: String) : MutationResult()

    val isOk: Boolean get() = this is Ok
    val id: String? get() = (this as? Ok)?.value
    val errorMessage: String? get() = (this as? Failure)?.message
}

/** The result of an atomic `batch` — the Kotlin port of `BatchResult`. */
sealed class BatchResult {
    data class Ok(val values: List<String>) : BatchResult()
    data class Failure(val message: String) : BatchResult()

    val isOk: Boolean get() = this is Ok
    val ids: List<String> get() = (this as? Ok)?.values ?: emptyList()
    val errorMessage: String? get() = (this as? Failure)?.message
}

/**
 * The current owner — the Kotlin port of `AppOwner`. `recoveryKey` is the secret
 * to back up (an `sf1_` key or a 24-word phrase); `mnemonic` is non-null only when
 * the owner was derived from a phrase. `writeKey` is the relay bearer token.
 */
data class AppOwner(
    val id: String,
    val recoveryKey: String,
    val writeKey: String,
    val mnemonic: String?,
)

/** A relay endpoint — the Kotlin port of `Transport`. */
data class Transport(val url: String, val type: String = "Http")

/** Live sync status — the Kotlin port of `SyncState`. */
sealed class SyncState {
    data object Initial : SyncState()
    data object Syncing : SyncState()
    data class Synced(val lastSyncedAt: String) : SyncState()
    data class NotSynced(val error: String?, val terminal: Boolean, val status: Int?) : SyncState()
}

/**
 * The most recent failure talking to one relay (sync or status probe) — the
 * `RelayStatus.lastFailure` analog. `kind` uses the TS `SyncFailureKind` strings:
 * "authRejected" | "quotaExceeded" | "rateLimited" | "serverError" | "badRequest"
 * | "unreachable" | "unknown".
 */
data class RelayFailure(val kind: String, val message: String, val at: String)

/**
 * Per-relay status + storage usage — the Kotlin port of `RelayStatus`. The
 * account block (usedBytes…events) comes from the relay's `/v1/status` and is
 * null when the relay is unreachable or this owner has never pushed to it
 * (the relay answers 404 until then).
 */
data class RelayStatus(
    /** Relay base URL, normalized (wss:// → https://). */
    val url: String,
    /** True when the relay answered the status probe (even with no account). */
    val reachable: Boolean,
    /** Last successful sync with this relay this session (ISO8601). */
    val lastSyncedAt: String? = null,
    /** Most recent failure talking to this relay (sync or status probe). */
    val lastFailure: RelayFailure? = null,
    /** Relay software version (from /v1/status, or /health when no account). */
    val version: String? = null,
    /** Bytes of this owner's data the relay currently stores. */
    val usedBytes: Long? = null,
    /** The relay's per-owner storage limit in bytes. */
    val quotaBytes: Long? = null,
    /** usedBytes / quotaBytes × 100, as reported by the relay. */
    val usedPct: Double? = null,
    /** The relay's newest event sequence for this owner (pull-cursor head). */
    val headSeq: Long? = null,
    /** Distinct streams (≈ live rows) the relay holds for this owner. */
    val streams: Long? = null,
    /** Raw stored event count (shrinks when the relay compacts). */
    val events: Long? = null,
)

/** A secondary index to create on boot (the `indexes` config analog). */
data class Index(val name: String, val table: String, val columns: List<String>)

/** Engine configuration — the Kotlin port of `SyncEngineConfig`. */
data class SyncEngineConfig(
    val name: String,
    val transports: List<Transport> = emptyList(),
    val externalAppOwner: AppOwner? = null,
    val syncIntervalMs: Long = 5000,
    val indexes: List<Index> = emptyList(),
)

/**
 * Platform plumbing injected once — the Kotlin port of `SyncEngineDeps`. Provide a
 * SQLite driver factory and a secure store; `reloadApp` runs after restore/reset.
 */
class SyncEngineDeps(
    val makeDriver: (String) -> SqliteDriver,
    val secureStorage: SecureStorage,
    val reloadApp: (() -> Unit)? = null,
)

class EngineException(message: String) : Exception(message)
