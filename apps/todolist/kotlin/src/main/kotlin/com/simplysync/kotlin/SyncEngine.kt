package com.simplysync.kotlin

import java.time.Instant
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json

private const val MNEMONIC_PROFILE_META = "identity:mnemonicProfile"

/**
 * The local-first sync engine — the Kotlin port of `@simplysync/engine`. It owns
 * the local SQLite database, the HLC clock, the outbox, the reactive query cache,
 * and the sync loop, so app code calls `insert`/`update`/`upsert` and observes
 * reactive queries rather than touching the protocol directly.
 *
 * Single-threaded by design (like the TS engine): one reentrant lock serializes
 * all state + DB access, and network I/O happens between critical sections, never
 * while the lock is held. Reactive results are exposed as [StateFlow] (the
 * `useQuery` analog) — collect them from Compose.
 */
class SyncEngine(
    private val schema: Schema,
    private val config: SyncEngineConfig,
    private val deps: SyncEngineDeps,
) {
    private val store = Store(schema, config)
    private val cache = QueryCache(store, schema)
    private val lock = ReentrantLock()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    private var identity: Identity? = null
    private var clock: HlcClock? = null
    private var deviceId = "local"
    private var appOwnerValue: AppOwner? = null
    private var transports: List<Transport> = config.transports
    private var schemaReady = false

    private val mutableSyncState = MutableStateFlow<SyncState>(SyncState.Initial)
    /** Live sync status — collect from Compose. */
    val syncState: StateFlow<SyncState> get() = mutableSyncState.asStateFlow()
    private val mutableError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> get() = mutableError.asStateFlow()

    private var syncJob: Job? = null
    private var syncRequested = false
    private var pollJob: Job? = null
    private val defaultPollMs = if (config.syncIntervalMs > 0) config.syncIntervalMs else 60_000L
    private val backoffPollMs = 5 * 60_000L
    private var pollIntervalMs = defaultPollMs
    private val seenCap = 50_000
    private val deferredReplayLimit = 256
    private val deferredScanActiveKey = "deferred:opaque:activeSchema"
    private val deferredScanCompleteKey = "deferred:opaque:completeSchema"
    private val deferredScanCursorKey = "deferred:opaque:cursor"

    /** One relay's last-contact outcome, kept in [relayHealth]. */
    private data class RelayHealth(val lastSyncedAt: String? = null, val lastFailure: RelayFailure? = null)

    // Per-relay outcome of the last contact, keyed by base URL (parity with the TS
    // engine). SyncState collapses multi-relay results ("synced" as long as ANY
    // relay works — the data is safe somewhere); this map keeps the per-relay
    // truth so getRelayStatuses can show which relay is failing behind a green
    // state. Guarded by `lock`.
    private val relayHealth = HashMap<String, RelayHealth>()

    // Relays that lost their data and are being re-seeded from this device. Kept
    // out of relayHealth because that entry is replaced wholesale on every
    // contact, while a re-seed deliberately spans passes: the wipe is detected
    // during pull, the rebuilt outbox drains on the following pass. Guarded by
    // `lock`.
    private val reseedingRelays = HashSet<String>()

    private val mnemonicKey = "${config.name}:mnemonic"
    private val deviceKey = "${config.name}:deviceId"
    private val mnemonicProfileKey = "${config.name}:mnemonicIdentityProfile"
    private val liveFlows = HashMap<String, MutableStateFlow<List<Any?>>>()

    private val bootJob: Job = scope.launch { boot() }

    internal enum class Mode { INSERT, UPDATE, UPSERT, DELETE, RESTORE }

    /** Resolves once the DB is open and the owner is loaded — the `engine.ready` analog. */
    suspend fun ready() = bootJob.join()

    // ----- Boot -------------------------------------------------------------

    private suspend fun boot() {
        try {
            val driver = deps.makeDriver(config.name)
            lock.withLock {
                store.driver = driver
                store.ensureSchema()
                loadIdentity()
                cache.schemaReady = true
                schemaReady = true
                clock?.seed(
                    store.getMeta("hlc:time")?.toLongOrNull() ?: 0,
                    store.getMeta("hlc:counter")?.toIntOrNull() ?: 0,
                )
            }
            replayDeferredAtBoot()
            lock.withLock { cache.refreshAll() }
            if (transports.isNotEmpty()) {
                scope.launch { sync() }
                startPolling()
            }
        } catch (e: Exception) {
            setError(describe(e))
        }
    }

    private fun loadIdentity() {
        var secret = config.externalAppOwner?.recoveryKey ?: deps.secureStorage.getItem(mnemonicKey)
        if (secret == null || runCatching { IdentityDeriver.derive(secret!!) }.isFailure) {
            val fresh = IdentityDeriver.createRecoveryKey()
            deps.secureStorage.setItem(mnemonicKey, fresh)
            secret = fresh
        }
        val profile = resolveMnemonicProfile(secret!!)
        val derived = IdentityDeriver.derive(secret!!, profile)
        persistMnemonicProfile(profile)
        val device = deps.secureStorage.getItem(deviceKey)
            ?: Base64Url.encode(Crypto.randomBytes(8)).also { deps.secureStorage.setItem(deviceKey, it) }
        lock.withLock {
            identity = derived
            deviceId = device
            clock = HlcClock(device)
            appOwnerValue = AppOwner(derived.ownerId, derived.recoveryKey, derived.relayAuth, derived.mnemonic)
        }
    }

    /**
     * Pick the identity profile without reinterpreting an existing database.
     * Strong evidence wins first; the "rows imply legacy" fallback only applies
     * to an unmarked mnemonic database created by the pre-profile Android port.
     */
    private fun resolveMnemonicProfile(secret: String): MnemonicIdentityProfile {
        if (secret.trim().startsWith(IdentityDeriver.RECOVERY_KEY_PREFIX)) {
            return MnemonicIdentityProfile.SIMPLYSYNC_V1
        }
        config.mnemonicIdentityProfile?.let { return it }

        val simplySync = IdentityDeriver.derive(secret, MnemonicIdentityProfile.SIMPLYSYNC_V1)
        val legacy = IdentityDeriver.derive(secret, MnemonicIdentityProfile.EVOLU_LEGACY_V1)
        config.externalAppOwner?.id?.takeIf { it.isNotEmpty() }?.let { ownerId ->
            if (ownerId == legacy.ownerId) return MnemonicIdentityProfile.EVOLU_LEGACY_V1
            if (ownerId == simplySync.ownerId) return MnemonicIdentityProfile.SIMPLYSYNC_V1
        }

        MnemonicIdentityProfile.fromStorage(
            deps.secureStorage.getItem(mnemonicProfileKey),
        )?.let { return it }
        MnemonicIdentityProfile.fromStorage(
            store.getMeta(MNEMONIC_PROFILE_META),
        )?.let { return it }

        // An outbox envelope survives app restarts and carries only routing
        // metadata; its ownerId is enough to identify the prior derivation
        // without decrypting or rewriting any event.
        val envelopeOwner = store.driver?.select(
            "select envelope_json from \"${Store.OUTBOX}\" order by event_id asc limit 1",
        )?.firstOrNull()?.get("envelope_json")
            ?.let { it as? SqliteValue.Text }
            ?.value
            ?.let { encoded ->
                runCatching {
                    json.decodeFromString(SyncEnvelope.serializer(), encoded).ownerId
                }.getOrNull()
            }
        if (envelopeOwner == legacy.ownerId) return MnemonicIdentityProfile.EVOLU_LEGACY_V1
        if (envelopeOwner == simplySync.ownerId) return MnemonicIdentityProfile.SIMPLYSYNC_V1

        val hasRows = schema.tableNames.any { table ->
            store.driver?.select("select 1 from \"$table\" limit 1")?.isNotEmpty() == true
        }
        return if (hasRows) {
            MnemonicIdentityProfile.EVOLU_LEGACY_V1
        } else {
            MnemonicIdentityProfile.SIMPLYSYNC_V1
        }
    }

    private fun persistMnemonicProfile(profile: MnemonicIdentityProfile) {
        deps.secureStorage.setItem(mnemonicProfileKey, profile.storageValue)
        store.setMeta(MNEMONIC_PROFILE_META, profile.storageValue)
    }

    // ----- Owner ------------------------------------------------------------

    /** The current owner once boot has resolved. */
    suspend fun appOwner(): AppOwner? {
        bootJob.join()
        return lock.withLock { appOwnerValue }
    }

    /** The owner if already loaded (null before boot resolves). */
    val currentOwner: AppOwner? get() = lock.withLock { appOwnerValue }

    /**
     * Restore an owner from its recovery key or phrase. By default refuses to wipe
     * local data unless the relay confirms the owner has data; pass `force = true`
     * to switch to a new/empty owner intentionally.
     */
    suspend fun restoreAppOwner(recoveryKey: String, force: Boolean = false) {
        restoreAppOwnerInternal(recoveryKey, force, requestedProfile = null)
    }

    /**
     * Explicit-profile restore for a known legacy Android recovery phrase. The
     * existing `(String, Boolean)` overload remains unchanged for source/binary
     * compatibility and auto-detects the profile from relay data.
     */
    suspend fun restoreAppOwner(
        recoveryKey: String,
        mnemonicProfile: MnemonicIdentityProfile,
        force: Boolean = false,
    ) {
        restoreAppOwnerInternal(recoveryKey, force, requestedProfile = mnemonicProfile)
    }

    private suspend fun restoreAppOwnerInternal(
        recoveryKey: String,
        force: Boolean,
        requestedProfile: MnemonicIdentityProfile?,
    ) {
        val trimmed = recoveryKey.trim()
        val isMnemonic =
            !trimmed.startsWith(IdentityDeriver.RECOVERY_KEY_PREFIX) && Bip39.isValid(trimmed)
        val profiles = if (isMnemonic) {
            listOfNotNull(requestedProfile ?: config.mnemonicIdentityProfile)
                .ifEmpty {
                    listOf(
                        MnemonicIdentityProfile.SIMPLYSYNC_V1,
                        MnemonicIdentityProfile.EVOLU_LEGACY_V1,
                    )
                }
        } else {
            listOf(MnemonicIdentityProfile.SIMPLYSYNC_V1)
        }
        val candidates = profiles.map { profile ->
            profile to IdentityDeriver.derive(trimmed, profile)
        }
        var selected = candidates.first()
        if (!force) {
            val bases = lock.withLock { transports.map { normalizeBase(it.url) } }
            var found: Pair<MnemonicIdentityProfile, Identity>? = null
            for (candidate in candidates) {
                for (base in bases) {
                    val identity = candidate.second
                    val result = runCatching {
                        RelayTransportFactory.create(
                            base,
                            identity.ownerId,
                            identity.relayAuth,
                        ).pull("")
                    }.getOrNull()
                    if (result != null && result.events.isNotEmpty()) {
                        found = candidate
                        break
                    }
                }
                if (found != null) break
            }
            if (found == null) {
                throw EngineException(
                    "No backup found for this recovery phrase (the relay is empty or unreachable). " +
                        "Nothing was changed. Use force to switch to a new owner.",
                )
            }
            selected = found
        }
        switchOwner(selected.second.recoveryKey, selected.second, selected.first)
        if (lock.withLock { transports }.isNotEmpty()) scope.launch { sync() }
        deps.reloadApp?.invoke()
    }

    /**
     * Mint a brand-new owner and wipe local data — the `resetAppOwner` analog.
     *
     * Strictly more destructive than [restoreAppOwner]: it wipes local data AND
     * adopts an owner nothing has ever synced, so there is no relay to pull the
     * data back from. It therefore refuses unless a relay is confirmed to hold a
     * copy, throwing [IllegalStateException] with the condition that failed so
     * the app can offer the right next step (wait for sync, or export a backup).
     * Pass [force] once the user has confirmed.
     */
    suspend fun resetAppOwner(force: Boolean = false) {
        if (!force) {
            val pending = lock.withLock { pendingOutboxCount() }
            check(pending == 0) {
                "$pending change(s) haven't reached a sync relay yet. Back up your " +
                    "data first, or wait for sync to finish. Nothing was changed."
            }
            check(lock.withLock { transports }.isNotEmpty()) {
                "No sync relay is configured, so this data exists only on this " +
                    "device. Back up your data first. Nothing was changed."
            }
            val statuses = getRelayStatuses()
            check(statuses.any { it.reachable }) {
                "The sync service could not be reached, so this data can't be " +
                    "confirmed as backed up. Back up your data first. Nothing was changed."
            }
            // `events > 0`, not merely `reachable`: a relay that answers but holds
            // nothing for this owner is no safer than an unreachable one.
            check(statuses.any { (it.events ?: 0L) > 0L }) {
                "No sync relay holds a copy of this data yet. Back up your data " +
                    "first. Nothing was changed."
            }
        }
        val key = IdentityDeriver.createRecoveryKey()
        switchOwner(
            key,
            IdentityDeriver.derive(key),
            MnemonicIdentityProfile.SIMPLYSYNC_V1,
        )
        deps.reloadApp?.invoke()
    }

    /** Outbox events that have not reached any relay yet. Caller holds [lock]. */
    private fun pendingOutboxCount(): Int {
        val rows = store.driver?.select(
            "select count(*) as c from \"${Store.OUTBOX}\" where pushed_at is null",
        ) ?: return 0
        return ((rows.firstOrNull()?.get("c") as? SqliteValue.Integer)?.value ?: 0L).toInt()
    }

    /**
     * A relay whose event log is behind our pull cursor has lost data (wiped
     * volume, fresh deploy, restored from an older backup). Its `seq` counter
     * restarted, so `where seq > cursor` would match nothing and this device
     * would report "synced" forever while diverging from every peer. Forget the
     * relay and rebuild the outbox now, and flag it so a UI can say
     * "re-uploading" instead of lying.
     */
    private fun handleWipedRelay(base: String) {
        val fresh = lock.withLock {
            if (!reseedingRelays.add(base)) return@withLock false
            store.setMeta("cursor:$base", "")
            store.deleteMeta("push:$base")
            store.deleteMeta("backfill:$base")
            true
        }
        if (fresh) backfillOutboxForNewRelay(base)
    }

    private fun switchOwner(
        recoveryKey: String,
        identity: Identity,
        profile: MnemonicIdentityProfile,
    ) {
        lock.withLock {
            deps.secureStorage.setItem(mnemonicKey, recoveryKey)
            store.wipeLocalData()
            store.setMeta("legacyImported", "3")
            persistMnemonicProfile(profile)
            this.identity = identity
            appOwnerValue = AppOwner(identity.ownerId, identity.recoveryKey, identity.relayAuth, identity.mnemonic)
            clock?.seed(0, 0)
            cache.refreshAll()
        }
    }

    // ----- Queries ----------------------------------------------------------

    /** Build a reusable query from SQL (+ optional params) and a row mapper. */
    fun <T> createQuery(sql: String, parameters: List<SqliteValue> = emptyList(), map: (Row) -> T): Query<T> =
        Query(sql, parameters, map)

    /** One-shot read (re-runs the SQL now). */
    fun <T> loadQuery(query: Query<T>): List<T> = lock.withLock { decodeRows(query, cache.loadRawRows(query)) }

    /** Cached snapshot (the `getQueryRows` analog). */
    fun <T> getQueryRows(query: Query<T>): List<T> = lock.withLock { decodeRows(query, cache.rawRows(query)) }

    /** Low-level reactive primitive: a listener fired when the query's rows change. */
    fun <T> subscribeQuery(query: Query<T>, listener: () -> Unit): () -> Unit =
        lock.withLock { cache.subscribe(query, listener) }

    /**
     * A reactive query result as a [StateFlow] — the `useQuery` analog. Republishes
     * when a local write or an incoming sync changes the query's rows. The flow for
     * a given query is shared, so repeated calls return the same one.
     */
    @Suppress("UNCHECKED_CAST")
    fun <T> liveQuery(query: Query<T>): StateFlow<List<T>> = lock.withLock {
        val key = query.key
        liveFlows[key]?.let { return it.asStateFlow() as StateFlow<List<T>> }
        val flow = MutableStateFlow<List<Any?>>(getQueryRows(query))
        liveFlows[key] = flow
        cache.subscribe(query) { flow.value = getQueryRows(query) }
        flow.asStateFlow() as StateFlow<List<T>>
    }

    private fun <T> decodeRows(query: Query<T>, raw: List<Map<String, SqliteValue>>): List<T> =
        raw.mapNotNull { row ->
            try {
                query.map(Row(row))
            } catch (e: Exception) {
                setError("row map failed: ${describe(e)}")
                null
            }
        }

    // ----- Mutations --------------------------------------------------------

    fun insert(table: String, vararg values: Pair<String, Any?>): MutationResult =
        mutate(table, valuesOf(values), Mode.INSERT)

    fun update(table: String, vararg values: Pair<String, Any?>): MutationResult =
        mutate(table, valuesOf(values), Mode.UPDATE)

    fun update(table: String, expectedUpdatedAt: String,
               vararg values: Pair<String, Any?>): MutationResult =
        mutate(table, valuesOf(values), Mode.UPDATE, expectedUpdatedAt)

    fun upsert(table: String, vararg values: Pair<String, Any?>): MutationResult =
        mutate(table, valuesOf(values), Mode.UPSERT)

    fun upsert(table: String, expectedUpdatedAt: String,
               vararg values: Pair<String, Any?>): MutationResult =
        mutate(table, valuesOf(values), Mode.UPSERT, expectedUpdatedAt)

    /**
     * Soft-delete a row by id (parity with the TS engine): marks it deleted so the
     * deletion replicates as a tombstone (a hard local delete would resurrect from a
     * peer on the next pull) and `isDeleted`-filtered queries stop returning it.
     * Idempotent — deleting a not-yet-local id writes a superseding tombstone.
     */
    fun delete(table: String, id: String): MutationResult =
        mutate(table, mapOf("id" to JsonValue.Str(id)), Mode.DELETE)

    fun delete(table: String, id: String, expectedUpdatedAt: String): MutationResult =
        mutate(table, mapOf("id" to JsonValue.Str(id)), Mode.DELETE, expectedUpdatedAt)

    /** Restore exactly the tombstone identified by [expectedUpdatedAt]. */
    fun restore(table: String, id: String, expectedUpdatedAt: String): MutationResult =
        mutate(
            table,
            mapOf("id" to JsonValue.Str(id)),
            Mode.RESTORE,
            expectedUpdatedAt,
            expectedDeleted = true,
        )

    private data class PreparedRow(
        val table: String,
        val id: String,
        val hlc: String,
        val merged: Map<String, JsonValue>,
        val expectedUpdatedAt: String?,
        val expectedDeleted: Boolean,
    )

    private data class PreparedOutbox(
        val eventId: String,
        val envelopeJson: String,
    )

    private data class PullPage(
        val changed: Set<String>,
        val pulled: Int,
    )

    /**
     * Validate + merge + stamp the HLC for one write, WITHOUT touching the database.
     * Split out of the write so `batch` can prepare every op up front and fail
     * atomically before anything is written. Returns (prepared, null) or (null, error).
     * Must be called under `lock`.
     */
    private fun prepareRow(
        table: String,
        values: Map<String, JsonValue>,
        mode: Mode,
        expectedUpdatedAt: String? = null,
        expectedDeleted: Boolean = false,
    ): Pair<PreparedRow?, String?> {
        if (store.driver == null || clock == null) return null to "Database not ready."
        if (!schema.has(table)) return null to "Unknown table: $table"

        val suppliedId = values["id"]
        val id = if (suppliedId != null) {
            val value = (suppliedId as? JsonValue.Str)?.value
            if (value.isNullOrEmpty()) return null to "$table.id: Expected a non-empty id string."
            value
        } else createId()
        val existing = if (mode == Mode.INSERT) null else store.readRow(table, id)
        if (mode == Mode.UPDATE && existing == null) return null to "Row not found: $id"

        val merged = LinkedHashMap<String, JsonValue>()
        existing?.forEach { (k, v) -> merged[k] = v.toJson() }
        val coerceInput = LinkedHashMap(values)
        coerceInput["id"] = JsonValue.Str(id)
        val (coerced, error) = store.coerceValues(table, coerceInput)
        if (error != null) return null to error
        coerced.forEach { (k, v) -> merged[k] = v }
        values["isDeleted"]?.let {
            if (it !is JsonValue.IntVal || (it.value != 0L && it.value != 1L)) {
                return null to "$table.isDeleted: Expected a SQLite boolean (0 or 1)."
            }
            merged["isDeleted"] = it
        }
        // DELETE forces the tombstone flag so the deletion replicates and wins LWW.
        if (mode == Mode.DELETE) merged["isDeleted"] = sqliteTrue
        else if (mode == Mode.RESTORE) merged["isDeleted"] = sqliteFalse

        val suppliedUpdatedAt = values["updatedAt"]
        val providedUpdatedAt = (suppliedUpdatedAt as? JsonValue.Str)?.value
        if (suppliedUpdatedAt != null && providedUpdatedAt == null) {
            return null to "$table.updatedAt: Expected a valid SimplySync HLC."
        }
        val hlc = if (providedUpdatedAt != null) {
            if (!observeHlc(providedUpdatedAt)) {
                return null to "updatedAt must be a valid, non-future SimplySync HLC."
            }
            // A caller-supplied stamp bypasses the clock, so it can sort at or
            // below the row's current version: peers would keep their copy under
            // last-writer-wins while this device overwrote its own, and the next
            // ordinary edit would replicate the regressed values. Equal is refused
            // too — the outbox is keyed by HLC, so the event would be dropped while
            // its row committed. Checked whatever the mode: insert overwrites too.
            val currentHlc = (store.readRow(table, id)?.get("updatedAt") as? SqliteValue.Text)?.value
            if (currentHlc != null && Hlc.compare(currentHlc, providedUpdatedAt) >= 0) {
                return null to "$table.updatedAt: must be newer than the row's current version."
            }
            if (store.hasQueuedEvent(providedUpdatedAt)) {
                return null to "$table.updatedAt: collides with an event already queued for sync."
            }
            providedUpdatedAt
        } else {
            nextHlc()
        }
        merged["id"] = JsonValue.Str(id)
        merged["updatedAt"] = JsonValue.Str(hlc)
        values["createdAt"]?.let {
            if (it !is JsonValue.Str) return null to "$table.createdAt: Expected a string."
            if (existing == null) merged["createdAt"] = it
        }
        if (merged["createdAt"] == null) merged["createdAt"] = JsonValue.Str(isoNow())
        if (merged["isDeleted"] == null) merged["isDeleted"] = sqliteFalse

        return PreparedRow(
            table, id, hlc, merged, expectedUpdatedAt, expectedDeleted
        ) to null
    }

    private fun assertExpectedVersion(row: PreparedRow) {
        val expected = row.expectedUpdatedAt ?: return
        val current = store.readRow(row.table, row.id)
        val actual = (current?.get("updatedAt") as? SqliteValue.Text)?.value
        val isDeleted = (current?.get("isDeleted") as? SqliteValue.Integer)?.value
        val expectedFlag = if (row.expectedDeleted) 1L else 0L
        if (actual != expected || isDeleted != expectedFlag) {
            error("Write conflict: ${row.table}/${row.id} changed or was deleted.")
        }
    }

    private fun mutate(
        table: String,
        values: Map<String, JsonValue>,
        mode: Mode,
        expectedUpdatedAt: String? = null,
        expectedDeleted: Boolean = false,
    ): MutationResult {
        val outcome = lock.withLock {
            val driver = store.driver ?: return@withLock MutationResult.Failure("Database not ready.")
            val (prepared, error) = prepareRow(
                table, values, mode, expectedUpdatedAt, expectedDeleted)
            if (prepared == null) return@withLock MutationResult.Failure(error ?: "Mutation failed.")
            try {
                val outbox = prepareOutbox(prepared.table, prepared.id, prepared.hlc, prepared.merged)
                driver.transaction {
                    assertExpectedVersion(prepared)
                    store.writeRow(prepared.table, prepared.merged)
                    writeOutbox(driver, outbox)
                }
            } catch (e: Exception) {
                return@withLock MutationResult.Failure(e.message ?: e.toString())
            }
            cache.refreshQueries(setOf(table))
            MutationResult.Ok(prepared.id)
        }
        if (outcome.isOk && lock.withLock { transports }.isNotEmpty()) scope.launch { sync() }
        return outcome
    }

    /**
     * Collects writes inside a `batch { ... }`; each op is applied atomically in one
     * transaction with a single query refresh and a single sync (parity with the TS engine).
     */
    internal data class BatchSpec(
        val table: String,
        val values: Map<String, JsonValue>,
        val mode: Mode,
        val expectedUpdatedAt: String? = null,
    )

    inner class BatchScope internal constructor() {
        internal val specs = ArrayList<BatchSpec>()
        fun insert(table: String, vararg values: Pair<String, Any?>) =
            specs.add(BatchSpec(table, valuesOf(values), Mode.INSERT))
        fun update(table: String, vararg values: Pair<String, Any?>) =
            specs.add(BatchSpec(table, valuesOf(values), Mode.UPDATE))
        fun update(table: String, expectedUpdatedAt: String,
                   vararg values: Pair<String, Any?>) =
            specs.add(BatchSpec(table, valuesOf(values), Mode.UPDATE, expectedUpdatedAt))
        fun upsert(table: String, vararg values: Pair<String, Any?>) =
            specs.add(BatchSpec(table, valuesOf(values), Mode.UPSERT))
        fun upsert(table: String, expectedUpdatedAt: String,
                   vararg values: Pair<String, Any?>) =
            specs.add(BatchSpec(table, valuesOf(values), Mode.UPSERT, expectedUpdatedAt))
        fun delete(table: String, id: String) = specs.add(
            BatchSpec(table, mapOf<String, JsonValue>("id" to JsonValue.Str(id)), Mode.DELETE)
        )
        fun delete(table: String, id: String, expectedUpdatedAt: String) = specs.add(
            BatchSpec(
                table, mapOf<String, JsonValue>("id" to JsonValue.Str(id)),
                Mode.DELETE, expectedUpdatedAt
            )
        )
    }

    /**
     * Write many rows atomically: validate + merge every op first (one bad op aborts the
     * whole batch before anything is written), then one transaction, one query refresh per
     * affected table, and one sync. Mix in `delete` for atomic moves. Parity with TS `batch`.
     */
    fun batch(build: BatchScope.() -> Unit): BatchResult {
        val batchScope = BatchScope().apply(build)
        return executeBatch(batchScope.specs)
    }

    /**
     * Coroutine-friendly batch for UI callers. The inexpensive DSL build stays
     * with the caller, while validation, row merging, HLC stamping, outbox
     * sealing, and the transaction run on a background dispatcher.
     */
    suspend fun batchAsync(build: BatchScope.() -> Unit): BatchResult {
        val specs = BatchScope().apply(build).specs.toList()
        return withContext(Dispatchers.Default) { executeBatch(specs) }
    }

    private fun executeBatch(specs: List<BatchSpec>): BatchResult {
        val outcome = lock.withLock {
            val driver = store.driver ?: return@withLock BatchResult.Failure("Database not ready.")
            val prepared = ArrayList<PreparedRow>(specs.size)
            for (spec in specs) {
                val (p, error) = prepareRow(
                    spec.table, spec.values, spec.mode, spec.expectedUpdatedAt)
                if (p == null) return@withLock BatchResult.Failure(error ?: "Batch failed.")
                prepared.add(p)
            }
            // Engine-minted HLCs are unique by construction; caller-supplied ones
            // are not, and two ops sharing one would leave a single outbox event
            // for two row writes.
            if (prepared.map { it.hlc }.toSet().size != prepared.size) {
                return@withLock BatchResult.Failure("updatedAt: two ops in one batch share an HLC.")
            }
            try {
                val outbox = prepared.map {
                    prepareOutbox(it.table, it.id, it.hlc, it.merged)
                }
                driver.transaction {
                    for (p in prepared) {
                        assertExpectedVersion(p)
                        store.writeRow(p.table, p.merged)
                    }
                    for (event in outbox) writeOutbox(driver, event)
                }
            } catch (e: Exception) {
                return@withLock BatchResult.Failure(e.message ?: e.toString())
            }
            cache.refreshQueries(prepared.map { it.table }.toSet())
            BatchResult.Ok(prepared.map { it.id })
        }
        if (outcome.isOk && lock.withLock { transports }.isNotEmpty()) scope.launch { sync() }
        return outcome
    }

    /** Soft-delete many rows of one table in a single atomic batch. */
    fun deleteMany(table: String, ids: List<String>): BatchResult = batch { for (id in ids) delete(table, id) }

    /**
     * Reclaim tombstones only for a database that has never used a relay.
     * Durable relay history keeps this disabled after transports are detached:
     * without a cross-device deletion watermark, a long-offline peer could
     * otherwise resurrect the row.
     */
    fun purgeDeleted(olderThanMs: Long = 30L * 24 * 60 * 60 * 1000): Int =
        lock.withLock {
            if (transports.isNotEmpty() || store.hasRelayHistory()) 0
            else store.purgeDeleted(olderThanMs, System.currentTimeMillis(), false)
        }

    /**
     * Prepare the encrypted outbox value before entering the SQLite transaction.
     * The row and this already-encoded envelope are then committed together, so
     * neither a crypto failure nor an outbox write failure can leave a local row
     * that will never replicate.
     */
    private fun prepareOutbox(
        table: String,
        rowId: String,
        hlc: String,
        value: Map<String, JsonValue>,
    ): PreparedOutbox {
        val id = identity ?: throw EngineException("Identity not ready.")
        val payload = SyncPayload(config.schemaVersion, table, "upsert", rowId, hlc, value)
        val envelope = Envelope.encrypt(id, hlc, deviceId, isoNow(), payload)
        val jsonStr = json.encodeToString(SyncEnvelope.serializer(), envelope)
        return PreparedOutbox(hlc, jsonStr)
    }

    private fun writeOutbox(driver: SqliteDriver, event: PreparedOutbox) {
        driver.exec(
            "insert or ignore into \"${Store.OUTBOX}\" (event_id, envelope_json) values (?, ?)",
            listOf(SqliteValue.Text(event.eventId), SqliteValue.Text(event.envelopeJson)),
        )
    }

    /**
     * Best-effort wrapper used only when backfilling a newly-added relay. Normal
     * app mutations use prepareOutbox + writeOutbox inside their row transaction.
     */
    private fun enqueue(table: String, rowId: String, hlc: String, value: Map<String, JsonValue>) {
        val driver = store.driver ?: return
        val outbox = runCatching { prepareOutbox(table, rowId, hlc, value) }.getOrNull() ?: return
        runCatching { writeOutbox(driver, outbox) }
    }

    // ----- Sync -------------------------------------------------------------

    /** Set transports (relays). Triggers an immediate sync and polling, or stops polling. */
    fun setTransports(next: List<Transport>) {
        lock.withLock {
            transports = next
            // Drop health for relays no longer configured so statuses don't linger.
            val active = next.map { normalizeBase(it.url) }.toSet()
            relayHealth.keys.retainAll(active)
        }
        if (next.isNotEmpty()) {
            scope.launch { sync() }
            startPolling()
        } else {
            stopPolling()
        }
    }

    /**
     * Push the outbox, then pull + apply remote events. Concurrent callers coalesce
     * onto the in-flight run; a request that arrives mid-run schedules one more
     * cycle, so a write made just before `engine.sync()` is always pushed before
     * the call resolves.
     */
    suspend fun sync() {
        val job = lock.withLock {
            syncRequested = true
            syncJob ?: scope.launch { runSyncLoop() }.also { syncJob = it }
        }
        job.join()
    }

    private suspend fun runSyncLoop() {
        try {
            while (true) {
                val shouldRun = lock.withLock {
                    if (syncRequested) { syncRequested = false; true } else { syncJob = null; false }
                }
                if (!shouldRun) return
                try {
                    runSync()
                } catch (e: Exception) {
                    // Per-relay failures are classified inside runSync; this is a
                    // fault outside them (a store call hitting a full disk, say).
                    // Report it and keep draining — an escaped exception used to
                    // leave a completed job in `syncJob`, and every later sync()
                    // joined it instantly and never synced again.
                    setError(describe(e))
                    setSyncState(SyncState.NotSynced(describe(e), terminal = false, status = null))
                }
            }
        } finally {
            lock.withLock { syncJob = null }
        }
    }

    private suspend fun runSync() {
        lock.withLock {
            val replayed = replayEligibleOpaquePage() + replayDueDeferred()
            if (replayed.isNotEmpty()) cache.refreshQueries(replayed)
        }
        val snapshot = lock.withLock {
            val id = identity
            if (id == null || transports.isEmpty()) null
            else id to transports.map { normalizeBase(it.url) }
        } ?: return
        val (id, bases) = snapshot
        if (bases.isEmpty()) return
        setSyncState(SyncState.Syncing)
        val changed = HashSet<String>()
        var anySuccess = false
        var firstFailure: ClassifiedFailure? = null
        // Contact every relay so each one's health is recorded independently
        // (per-relay truth for getRelayStatuses, not collapsed to the first failure).
        for (base in bases) {
            try {
                backfillOutboxForNewRelay(base)
                // Drain the complete local backlog before reporting Synced. A
                // full batch means another page may remain.
                var pushed = 0
                while (true) {
                    val batch = pushOutbox(base, id)
                    pushed += batch
                    if (batch < 1000) break
                }
                // Nothing left to send means the post-wipe re-seed has landed and
                // this relay holds a full copy again. Checked after the drain, so
                // the pass that detects the wipe (push runs before pull) can't
                // clear it.
                if (pushed == 0) lock.withLock { reseedingRelays.remove(base) }
                // Likewise, pull until the relay returns an empty page. Guard
                // against a buggy relay returning data without advancing its
                // cursor so one sync call cannot spin forever.
                while (true) {
                    val cursorKey = "cursor:$base"
                    val before = lock.withLock { store.getMeta(cursorKey) ?: "" }
                    val page = pullAndApply(base, id)
                    changed += page.changed
                    val after = lock.withLock { store.getMeta(cursorKey) ?: "" }
                    if (page.pulled == 0 || after == before) break
                }
                anySuccess = true
                lock.withLock { relayHealth[base] = RelayHealth(lastSyncedAt = isoNow()) }
            } catch (e: Exception) {
                val failure = classifyError(e)
                if (firstFailure == null) firstFailure = failure
                lock.withLock {
                    relayHealth[base] = RelayHealth(
                        // Keep the last good sync time so "failing since when" is visible.
                        lastSyncedAt = relayHealth[base]?.lastSyncedAt,
                        lastFailure = RelayFailure(failure.kind, failure.message, isoNow()),
                    )
                }
            }
        }
        lock.withLock {
            if (changed.isNotEmpty()) cache.refreshQueries(changed)
            pruneSeen()
            // Drop outbox events now delivered to every relay (cursors advanced above).
            store.pruneOutbox(bases)
        }
        if (anySuccess || firstFailure == null) {
            // Recovered — restore the normal poll cadence if we'd backed off.
            lock.withLock { if (pollIntervalMs != defaultPollMs) pollIntervalMs = defaultPollMs }
            setSyncState(SyncState.Synced(isoNow()))
        } else {
            val terminal = firstFailure.kind in terminalKinds
            // A terminal failure (auth/quota/bad event) or rate-limit won't self-heal
            // by retrying the same batch immediately — slow the poller so it stops
            // hammering (a local write still triggers an immediate retry).
            if (terminal || firstFailure.kind == "rateLimited") {
                lock.withLock { pollIntervalMs = backoffPollMs }
            }
            setSyncState(SyncState.NotSynced(firstFailure.message, terminal, firstFailure.status))
        }
    }

    private suspend fun pushOutbox(base: String, identity: Identity): Int {
        // Per-relay push cursor (parity with the TS engine) so EVERY configured relay
        // receives a full copy of this device's events (write redundancy), not just the
        // first one contacted. A single global "pushed_at is null" filter let the first
        // relay drain the outbox and starve the rest. Outbox event_ids are this device's
        // own HLCs — monotonically increasing — so a string high-water mark paginates
        // correctly. On upgrade the cursor is unset and starts at "" (re-push once; the
        // relay dedupes by event id).
        val cursorKey = "push:$base"
        val pending = lock.withLock {
            val after = store.getMeta(cursorKey) ?: ""
            (store.driver?.select(
                "select event_id, envelope_json from \"${Store.OUTBOX}\" where event_id > ? order by event_id asc limit 1000",
                listOf(SqliteValue.Text(after)),
            ) ?: emptyList()).mapNotNull { row ->
                val eid = (row["event_id"] as? SqliteValue.Text)?.value
                val js = (row["envelope_json"] as? SqliteValue.Text)?.value
                if (eid != null && js != null) eid to js else null
            }
        }
        if (pending.isEmpty()) return 0
        val envelopes = pending.mapNotNull { (_, js) ->
            runCatching { json.decodeFromString(SyncEnvelope.serializer(), js) }.getOrNull()
        }
        RelayTransportFactory.create(base, identity.ownerId, identity.relayAuth).push(envelopes)
        val pushedAt = isoNow()
        lock.withLock {
            // The owner changed while this request was in flight (restore/reset
            // wiped the outbox). Recording delivery now would write the OLD
            // owner's push cursor into the NEW owner's metadata, which skips its
            // first backfill.
            if (this.identity?.ownerId != identity.ownerId) return@withLock
            for ((eid, _) in pending) {
                store.driver?.exec(
                    // `pushed_at` marks "reached at least one relay" — keep the earliest via coalesce.
                    "update \"${Store.OUTBOX}\" set pushed_at = coalesce(pushed_at, ?) where event_id = ?",
                    listOf(SqliteValue.Text(pushedAt), SqliteValue.Text(eid)),
                )
            }
            store.setMeta(cursorKey, pending.last().first)
        }
        return pending.size
    }

    /**
     * A relay added after the bounded outbox was pruned still needs the current
     * owner state. Re-emit each row once under its existing HLC. The marker is
     * separate from the push cursor so an initially empty client does not echo
     * rows it just pulled back to that same relay on the next cycle.
     */
    private fun backfillOutboxForNewRelay(base: String) = lock.withLock {
        val marker = "backfill:$base"
        if (store.getMeta(marker) != null) return@withLock
        if (store.getMeta("push:$base") != null) {
            store.setMeta(marker, "1")
            return@withLock
        }
        for (table in schema.tableNames) {
            for (dbRow in store.driver?.select("select * from \"$table\"") ?: emptyList()) {
                val rowId = (dbRow["id"] as? SqliteValue.Text)?.value ?: continue
                // The row's HLC becomes the event id, and a relay refuses a whole
                // push batch over one malformed id. A row that reached the table
                // without a canonical stamp (raw SQL, a legacy import) can only be
                // skipped here; queueing it would stall every later write behind it.
                val hlc = (dbRow["updatedAt"] as? SqliteValue.Text)?.value
                    ?.takeIf { Hlc.parse(it) != null } ?: continue
                enqueue(table, rowId, hlc, dbRow.mapValues { it.value.toJson() })
            }
        }
        store.setMeta(marker, "1")
    }

    private suspend fun pullAndApply(base: String, identity: Identity): PullPage {
        val cursorKey = "cursor:$base"
        val after = lock.withLock { store.getMeta(cursorKey) ?: "" }
        // An owner the relay has never seen is "nothing to pull yet", not a
        // failure: both reference relays create the owner on PUSH only, so pull
        // 404s until this account's first event lands. Treating it as an error
        // made a fresh install report a terminal sync failure and back its poller
        // off until the first write. Mirrors the TypeScript engine (relay.ts) and
        // the same 404 handling already used for /v1/status below.
        val result = try {
            RelayTransportFactory.create(
                base,
                identity.ownerId,
                identity.relayAuth,
            ).pull(after)
        } catch (e: RelayClient.RelayException) {
            if (e.status == 404) {
                // A 404 for an owner we have ALREADY pulled from is different in
                // kind: the relay didn't miss our first push, it lost the account.
                // Repair, or the stale cursor stalls sync permanently once the
                // relay's seq counter restarts below it.
                if (after.isNotEmpty()) handleWipedRelay(base)
                return PullPage(emptySet(), 0)
            }
            throw e
        }
        return lock.withLock {
            // The suspension above is a window in which restoreAppOwner/resetAppOwner
            // can swap the owner and wipe the database. This page was fetched for
            // the previous owner: applying it would leak that owner's rows into
            // the new owner's database, and recording its cursor would make the
            // new owner's first pull skip everything below it. Drop the page; the
            // pass the switch queued re-pulls under the new owner.
            if (this.identity?.ownerId != identity.ownerId) return@withLock PullPage(emptySet(), 0)
            val changed = HashSet<String>()
            for (envelope in result.events) {
                val seen = store.driver?.select(
                    "select 1 from \"${Store.SEEN}\" where event_id = ?", listOf(SqliteValue.Text(envelope.eventId)),
                ) ?: emptyList()
                if (seen.isNotEmpty()) continue
                val decrypted = runCatching { Envelope.decrypt(identity, envelope) }
                if (decrypted.isFailure) {
                    // A GCM tag failure means storage corruption or relay
                    // tampering — the one event the threat model most wants
                    // surfaced (SECURITY.md: "the client rejects it"). The
                    // cursor still advances so it can't wedge the batch, but it
                    // must not be a silent drop.
                    setError("decrypt failed for event ${envelope.eventId}")
                    continue
                }
                val payload = decrypted.getOrThrow()
                val eventHlc = Hlc.admissibility(envelope.eventId)
                if (eventHlc == HlcAdmissibility.MALFORMED) {
                    // Terminal protocol violation: mark seen below so it cannot
                    // wedge the relay cursor.
                } else if (payload.schemaVersion > config.schemaVersion) {
                    // Preserve newer payloads as opaque data until an upgraded
                    // app declares support. Applying them through an older
                    // schema could reinterpret fields whose meaning changed.
                    store.deferRemoteEvent(
                        envelope.eventId,
                        Envelope.encodePayload(payload),
                    )
                } else if (payload.schemaVersion < 1) {
                    // Invalid and terminal: mark seen below so it cannot wedge
                    // the relay cursor or live forever in deferred storage.
                } else if (
                    payload.hlc != envelope.eventId ||
                    Hlc.admissibility(payload.hlc) == HlcAdmissibility.MALFORMED
                ) {
                    // The signed envelope event id is the wire HLC. A mismatch
                    // would make relay compaction and client LWW disagree.
                } else if (
                    eventHlc == HlcAdmissibility.FUTURE ||
                    Hlc.admissibility(payload.hlc) == HlcAdmissibility.FUTURE
                ) {
                    // Keep authenticated future data until wall time catches
                    // up; dropping it would replace poisoning with data loss.
                    store.deferRemoteEvent(
                        envelope.eventId,
                        Envelope.encodePayload(payload),
                        futureRetryAfter(envelope.eventId, payload.hlc),
                    )
                } else if (!observeHlc(payload.hlc)) {
                    // The wall clock moved backwards between classification and
                    // observation. Keep the event for a later retry.
                    store.deferRemoteEvent(
                        envelope.eventId,
                        Envelope.encodePayload(payload),
                        maxOf(
                            System.currentTimeMillis() + 1_000L,
                            futureRetryAfter(envelope.eventId, payload.hlc),
                        ),
                    )
                } else if (schema.has(payload.table)) {
                    when (applyRemoteRow(payload)) {
                        ApplyOutcome.APPLIED -> changed += payload.table
                        ApplyOutcome.UNCHANGED -> Unit
                        ApplyOutcome.FAILED -> {
                            // Authenticated data this build cannot write (a column
                            // it lacks, a value its type refuses). Retained opaquely
                            // for the upgrade that can, as the TypeScript engine
                            // does — dropping it would be silent data loss.
                            store.deferRemoteEvent(envelope.eventId, Envelope.encodePayload(payload))
                            setError("could not apply event ${envelope.eventId}; retained for a later build")
                        }
                    }
                } else {
                    store.deferRemoteEvent(
                        envelope.eventId,
                        Envelope.encodePayload(payload),
                    )
                }
                store.driver?.exec(
                    "insert or ignore into \"${Store.SEEN}\" (event_id) values (?)", listOf(SqliteValue.Text(envelope.eventId)),
                )
            }
            store.setMeta(cursorKey, result.nextCursor)
            PullPage(changed, result.events.size)
        }
    }

    private fun futureRetryAfter(eventId: String, payloadHlc: String): Long {
        val eventMillis = Hlc.parse(eventId)?.first ?: 0L
        val payloadMillis = Hlc.parse(payloadHlc)?.first ?: 0L
        return maxOf(eventMillis, payloadMillis) - HLC_MAX_FUTURE_DRIFT_MS
    }

    private fun replayDeferredRows(items: List<Pair<String, String>>): Set<String> {
        val changed = HashSet<String>()
        for ((eventId, payloadJson) in items) {
            val payload = runCatching { Envelope.decodePayload(payloadJson) }.getOrNull()
            if (payload == null) {
                store.dropDeferredEvent(eventId)
                continue
            }
            if (payload.schemaVersion > config.schemaVersion) {
                store.deferRemoteEvent(eventId, payloadJson)
                continue
            }
            if (payload.schemaVersion < 1) {
                store.dropDeferredEvent(eventId)
                continue
            }
            val eventHlc = Hlc.admissibility(eventId)
            val payloadHlc = Hlc.admissibility(payload.hlc)
            if (eventHlc == HlcAdmissibility.FUTURE || payloadHlc == HlcAdmissibility.FUTURE) {
                store.deferRemoteEvent(
                    eventId, payloadJson, futureRetryAfter(eventId, payload.hlc))
                continue
            }
            if (
                eventHlc == HlcAdmissibility.MALFORMED ||
                payloadHlc == HlcAdmissibility.MALFORMED ||
                payload.hlc != eventId
            ) {
                store.dropDeferredEvent(eventId)
                continue
            }
            if (!schema.has(payload.table)) {
                store.deferRemoteEvent(eventId, payloadJson)
                continue
            }
            if (!observeHlc(payload.hlc)) {
                store.deferRemoteEvent(
                    eventId,
                    payloadJson,
                    maxOf(
                        System.currentTimeMillis() + 1_000L,
                        futureRetryAfter(eventId, payload.hlc),
                    ),
                )
                continue
            }
            when (applyRemoteRow(payload)) {
                ApplyOutcome.APPLIED -> { changed += payload.table; store.dropDeferredEvent(eventId) }
                ApplyOutcome.UNCHANGED -> store.dropDeferredEvent(eventId)
                // Still unwritable against this schema: keep it opaque (no retry
                // time) so only the once-per-schema sweep reconsiders it.
                ApplyOutcome.FAILED -> store.deferRemoteEvent(eventId, payloadJson)
            }
        }
        return changed
    }

    private val deferredSchemaToken: String by lazy {
        val tableTokens = schema.tableNames.map { table ->
            val columns = schema.columns(table).orEmpty()
            val columnToken = columns.keys.sorted().joinToString(",") { name ->
                val column = columns.getValue(name)
                "$name:${column.name}:${column.sqlite}:${column.nullable}"
            }
            "$table{$columnToken}"
        }
        "${config.schemaVersion}|${tableTokens.joinToString(";")}"
    }

    private fun replayEligibleOpaquePage(): Set<String> {
        val token = deferredSchemaToken
        if (store.getMeta(deferredScanCompleteKey) == token) return emptySet()
        if (store.getMeta(deferredScanActiveKey) != token) {
            store.setMeta(deferredScanActiveKey, token)
            store.setMeta(deferredScanCursorKey, "")
        }
        val cursor = store.getMeta(deferredScanCursorKey)?.takeIf { it.isNotEmpty() }
        val page = store.opaqueDeferredEvents(cursor, deferredReplayLimit)
        val changed = replayDeferredRows(page)
        if (page.size < deferredReplayLimit) {
            store.setMeta(deferredScanCompleteKey, token)
            store.setMeta(deferredScanActiveKey, "")
            store.setMeta(deferredScanCursorKey, "")
        } else {
            store.setMeta(deferredScanCursorKey, page.last().first)
        }
        return changed
    }

    private suspend fun replayDeferredAtBoot(): Set<String> {
        yield()
        return lock.withLock {
            replayEligibleOpaquePage() + replayDueDeferred()
        }
    }

    private fun replayDueDeferred(): Set<String> = replayDeferredRows(
        store.dueDeferredEvents(System.currentTimeMillis(), deferredReplayLimit),
    )

    /**
     * What became of one decrypted row. UNCHANGED means last-writer-wins kept the
     * local copy; FAILED means this build could not write it, which callers retain
     * rather than discard.
     */
    private enum class ApplyOutcome { APPLIED, UNCHANGED, FAILED }

    /** Apply one decrypted row, last-writer-wins by `updatedAt`. Called under lock. */
    private fun applyRemoteRow(payload: SyncPayload): ApplyOutcome {
        if (payload.rowId.isEmpty()) return ApplyOutcome.FAILED
        val existing = store.readRow(payload.table, payload.rowId)
        val existingUpdated = (existing?.get("updatedAt") as? SqliteValue.Text)?.value
        if (existing != null && existingUpdated != null && Hlc.compare(existingUpdated, payload.hlc) >= 0) {
            return ApplyOutcome.UNCHANGED
        }
        val row = LinkedHashMap(payload.value)
        row["id"] = JsonValue.Str(payload.rowId)
        // The top-level HLC is canonical on the wire; the nested row can carry
        // a stale value from a partial update (or omit it entirely).
        row["updatedAt"] = JsonValue.Str(payload.hlc)
        val (projected, error) = store.projectRemoteRow(payload.table, row)
        if (error != null) return ApplyOutcome.FAILED
        return if (runCatching { store.writeRow(payload.table, projected) }.isSuccess) {
            ApplyOutcome.APPLIED
        } else {
            ApplyOutcome.FAILED
        }
    }

    private fun pruneSeen() {
        val driver = store.driver ?: return
        val count = (driver.select("select count(*) as c from \"${Store.SEEN}\"").firstOrNull()?.get("c") as? SqliteValue.Integer)?.value ?: 0
        if (count > seenCap) {
            driver.exec(
                "delete from \"${Store.SEEN}\" where event_id not in (select event_id from \"${Store.SEEN}\" order by event_id desc limit ?)",
                listOf(SqliteValue.Integer(seenCap.toLong())),
            )
        }
    }

    // ----- Relay status -------------------------------------------------------

    private data class ClassifiedFailure(val kind: String, val status: Int?, val message: String)

    // Terminal kinds need user/operator action (re-auth, free quota, fix request),
    // so the poller backs off rather than hammering. rateLimited also backs off
    // but is not "terminal" (it self-heals).
    private val terminalKinds = setOf("authRejected", "quotaExceeded", "badRequest")

    /**
     * Map a thrown sync error to the TS engine's `SyncFailureKind` taxonomy. HTTP
     * errors carry a status; anything else (socket/DNS/timeout) is network-level,
     * which we read as unreachable.
     */
    private fun classifyError(e: Throwable): ClassifiedFailure {
        val status = (e as? RelayClient.RelayException)?.status
            ?: return ClassifiedFailure("unreachable", null, describe(e))
        val kind = when {
            status == 401 || status == 403 -> "authRejected"
            status == 413 -> "quotaExceeded"
            status == 429 -> "rateLimited"
            status >= 500 -> "serverError"
            status >= 400 -> "badRequest"
            else -> "unknown"
        }
        return ClassifiedFailure(kind, status, describe(e))
    }

    /**
     * One status probe per configured relay, in parallel — the `getRelayStatuses`
     * analog. Combines the relay's `/v1/status` storage snapshot with this
     * session's per-relay sync health (lastSyncedAt / lastFailure).
     */
    suspend fun getRelayStatuses(): List<RelayStatus> {
        val (id, bases) = lock.withLock { identity to transports.map { normalizeBase(it.url) } }
        return coroutineScope { bases.map { base -> async { fetchRelayStatus(base, id) } }.awaitAll() }
    }

    /**
     * One relay's status probe: GET /v1/status (auth-gated, per-owner). A 404
     * means the relay is up but this owner has never pushed to it — confirm
     * liveness via the public /health so `reachable`/`version` still report.
     */
    private suspend fun fetchRelayStatus(base: String, identity: Identity?): RelayStatus {
        val health = lock.withLock { relayHealth[base] }
        val bare = RelayStatus(
            url = base,
            reachable = false,
            lastSyncedAt = health?.lastSyncedAt,
            lastFailure = health?.lastFailure,
            reseeding = lock.withLock { base in reseedingRelays },
        )
        if (identity == null) return bare
        val client = RelayTransportFactory.create(base, identity.ownerId, identity.relayAuth)
        return try {
            val status = try {
                client.status()
            } catch (e: RelayClient.RelayException) {
                if (e.status != 404) throw e
                // No account yet — /health still proves liveness and reports the
                // version. A non-2xx /health reads as unreachable (parity with the
                // TS engine, which doesn't record a probe failure for this case).
                return try {
                    val alive = client.health()
                    bare.copy(reachable = alive.ok, version = alive.version)
                } catch (healthError: RelayClient.RelayException) {
                    bare
                }
            }
            // The relay still knows the owner but holds nothing for it while we
            // have pulled from it before: truncated, or restored from an older
            // backup, which the pull 404 can't see because the owner row survived.
            // `events == 0` is required as well as a `headSeq` behind our cursor —
            // stream compaction legitimately lowers `max(seq)` over surviving rows
            // and must not look like data loss.
            val localCursor = lock.withLock { store.getMeta("cursor:$base") }?.toLongOrNull() ?: 0L
            val headSeq = status.account?.headSeq
            if (headSeq != null && headSeq < localCursor && (status.account?.events ?: 0L) == 0L) {
                handleWipedRelay(base)
            }
            bare.copy(
                reachable = true,
                lastFailure = null,
                version = status.server?.version,
                usedBytes = status.account?.usedBytes,
                quotaBytes = status.account?.quotaBytes,
                usedPct = status.account?.usedPct,
                headSeq = status.account?.headSeq,
                streams = status.account?.streams,
                events = status.account?.events,
                reseeding = lock.withLock { base in reseedingRelays },
            )
        } catch (e: Exception) {
            val failure = classifyError(e)
            bare.copy(
                reachable = false,
                lastFailure = RelayFailure(failure.kind, failure.message, isoNow()),
            )
        }
    }

    // ----- Polling ----------------------------------------------------------

    private fun startPolling() {
        lock.withLock {
            if (pollJob != null || transports.isEmpty()) return
            pollJob = scope.launch {
                while (isActive) {
                    delay(lock.withLock { pollIntervalMs })
                    sync()
                }
            }
        }
    }

    private fun stopPolling() {
        lock.withLock {
            pollJob?.cancel()
            pollJob = null
        }
    }

    /** Stop background work (poll loop + scope). Call when discarding the engine. */
    fun close() {
        stopPolling()
        scope.coroutineContext[Job]?.cancel()
        lock.withLock { store.driver?.close() }
    }

    fun getSyncState(): SyncState = mutableSyncState.value

    // ----- Helpers ----------------------------------------------------------

    private fun nextHlc(): String {
        val hlc = clock!!.next()
        persistClock()
        return hlc
    }

    private fun observeHlc(remote: String): Boolean {
        val accepted = clock?.observe(remote) ?: false
        persistClock()
        return accepted
    }

    private fun persistClock() {
        val clk = clock ?: return
        val (millis, counter) = clk.highWater()
        store.setMeta("hlc:time", millis.toString())
        store.setMeta("hlc:counter", counter.toString())
    }

    private fun setSyncState(next: SyncState) { mutableSyncState.value = next }
    private fun setError(message: String) { mutableError.value = message }

    private fun createId(): String = Base64Url.encode(Crypto.randomBytes(16))

    private fun isoNow(): String = Instant.now().toString()

    private fun valuesOf(pairs: Array<out Pair<String, Any?>>): Map<String, JsonValue> {
        val map = LinkedHashMap<String, JsonValue>()
        for ((key, value) in pairs) map[key] = toJsonValue(value)
        return map
    }

    private fun toJsonValue(value: Any?): JsonValue = when (value) {
        null -> JsonValue.Null
        is JsonValue -> value
        is String -> JsonValue.Str(value)
        is Boolean -> JsonValue.Bool(value)
        is Int -> JsonValue.IntVal(value.toLong())
        is Long -> JsonValue.IntVal(value)
        is Double -> JsonValue.DoubleVal(value)
        is Float -> JsonValue.DoubleVal(value.toDouble())
        else -> JsonValue.Str(value.toString())
    }

    private fun normalizeBase(url: String): String {
        var s = url
        if (s.startsWith("wss://")) s = "https://" + s.removePrefix("wss://")
        else if (s.startsWith("ws://")) s = "http://" + s.removePrefix("ws://")
        return s.trimEnd('/')
    }

    private fun describe(e: Throwable): String = when (e) {
        is RelayClient.RelayException -> "HTTP ${e.status}: ${e.bodyText}"
        else -> e.message ?: e.toString()
    }
}

/**
 * Wire the platform plumbing once, then build engines — the `createSync(deps)`
 * analog. `val engine = createSync(deps)(schema, config)`.
 */
fun createSync(deps: SyncEngineDeps): (Schema, SyncEngineConfig) -> SyncEngine =
    { schema, config -> SyncEngine(schema, config, deps) }
