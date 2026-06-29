package com.simplysync.kotlin

import java.time.Instant
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

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
    private val defaultPollMs = if (config.syncIntervalMs > 0) config.syncIntervalMs else 5000L
    private val backoffPollMs = 5 * 60_000L
    private var pollIntervalMs = defaultPollMs
    private val seenCap = 50_000

    private val mnemonicKey = "${config.name}:mnemonic"
    private val deviceKey = "${config.name}:deviceId"
    private val liveFlows = HashMap<String, MutableStateFlow<List<Any?>>>()

    private val bootJob: Job = scope.launch { boot() }

    internal enum class Mode { INSERT, UPDATE, UPSERT, DELETE }

    /** Resolves once the DB is open and the owner is loaded — the `engine.ready` analog. */
    suspend fun ready() = bootJob.join()

    // ----- Boot -------------------------------------------------------------

    private fun boot() {
        try {
            val driver = deps.makeDriver(config.name)
            loadIdentity()
            lock.withLock {
                store.driver = driver
                store.ensureSchema()
                cache.schemaReady = true
                schemaReady = true
                clock?.seed(
                    store.getMeta("hlc:time")?.toLongOrNull() ?: 0,
                    store.getMeta("hlc:counter")?.toIntOrNull() ?: 0,
                )
                cache.refreshAll()
            }
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
        val derived = IdentityDeriver.derive(secret!!)
        val device = deps.secureStorage.getItem(deviceKey)
            ?: Base64Url.encode(Crypto.randomBytes(8)).also { deps.secureStorage.setItem(deviceKey, it) }
        lock.withLock {
            identity = derived
            deviceId = device
            clock = HlcClock(device)
            appOwnerValue = AppOwner(derived.ownerId, derived.recoveryKey, derived.relayAuth, derived.mnemonic)
        }
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
        val restored = IdentityDeriver.derive(recoveryKey)
        if (!force) {
            val bases = lock.withLock { transports.map { normalizeBase(it.url) } }
            var hasBackup = false
            for (base in bases) {
                val result = runCatching { RelayClient(base, restored.ownerId, restored.relayAuth).pull("") }.getOrNull()
                if (result != null && result.events.isNotEmpty()) { hasBackup = true; break }
            }
            if (!hasBackup) {
                throw EngineException(
                    "No backup found for this recovery phrase (the relay is empty or unreachable). " +
                        "Nothing was changed. Use force to switch to a new owner.",
                )
            }
        }
        switchOwner(restored.recoveryKey, restored)
        if (lock.withLock { transports }.isNotEmpty()) scope.launch { sync() }
        deps.reloadApp?.invoke()
    }

    /** Mint a brand-new owner and wipe local data — the `resetAppOwner` analog. */
    suspend fun resetAppOwner() {
        val key = IdentityDeriver.createRecoveryKey()
        switchOwner(key, IdentityDeriver.derive(key))
        deps.reloadApp?.invoke()
    }

    private fun switchOwner(recoveryKey: String, identity: Identity) {
        lock.withLock {
            deps.secureStorage.setItem(mnemonicKey, recoveryKey)
            store.wipeLocalData()
            store.setMeta("legacyImported", "3")
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

    fun upsert(table: String, vararg values: Pair<String, Any?>): MutationResult =
        mutate(table, valuesOf(values), Mode.UPSERT)

    /**
     * Soft-delete a row by id (parity with the TS engine): marks it deleted so the
     * deletion replicates as a tombstone (a hard local delete would resurrect from a
     * peer on the next pull) and `isDeleted`-filtered queries stop returning it.
     * Idempotent — deleting a not-yet-local id writes a superseding tombstone.
     */
    fun delete(table: String, id: String): MutationResult =
        mutate(table, mapOf("id" to JsonValue.Str(id)), Mode.DELETE)

    private data class PreparedRow(
        val table: String,
        val id: String,
        val hlc: String,
        val merged: Map<String, JsonValue>,
    )

    /**
     * Validate + merge + stamp the HLC for one write, WITHOUT touching the database.
     * Split out of the write so `batch` can prepare every op up front and fail
     * atomically before anything is written. Returns (prepared, null) or (null, error).
     * Must be called under `lock`.
     */
    private fun prepareRow(table: String, values: Map<String, JsonValue>, mode: Mode): Pair<PreparedRow?, String?> {
        if (store.driver == null || clock == null) return null to "Database not ready."
        if (!schema.has(table)) return null to "Unknown table: $table"

        val id = (values["id"] as? JsonValue.Str)?.value?.takeIf { it.isNotEmpty() } ?: createId()
        val existing = if (mode == Mode.INSERT) null else store.readRow(table, id)
        if (mode == Mode.UPDATE && existing == null) return null to "Row not found: $id"

        val merged = LinkedHashMap<String, JsonValue>()
        existing?.forEach { (k, v) -> merged[k] = v.toJson() }
        val coerceInput = LinkedHashMap(values)
        coerceInput["id"] = JsonValue.Str(id)
        val (coerced, error) = store.coerceValues(table, coerceInput)
        if (error != null) return null to error
        coerced.forEach { (k, v) -> merged[k] = v }
        values["isDeleted"]?.let { merged["isDeleted"] = it }
        // DELETE forces the tombstone flag so the deletion replicates and wins LWW.
        if (mode == Mode.DELETE) merged["isDeleted"] = sqliteTrue

        val hlc = nextHlc()
        merged["id"] = JsonValue.Str(id)
        merged["updatedAt"] = JsonValue.Str(hlc)
        if (existing == null) (values["createdAt"] as? JsonValue.Str)?.let { merged["createdAt"] = it }
        if (merged["createdAt"] == null) merged["createdAt"] = JsonValue.Str(isoNow())
        if (merged["isDeleted"] == null) merged["isDeleted"] = sqliteFalse

        return PreparedRow(table, id, hlc, merged) to null
    }

    private fun mutate(table: String, values: Map<String, JsonValue>, mode: Mode): MutationResult {
        val outcome = lock.withLock {
            val driver = store.driver ?: return@withLock MutationResult.Failure("Database not ready.")
            val (prepared, error) = prepareRow(table, values, mode)
            if (prepared == null) return@withLock MutationResult.Failure(error ?: "Mutation failed.")
            try {
                driver.transaction { store.writeRow(prepared.table, prepared.merged) }
            } catch (e: Exception) {
                return@withLock MutationResult.Failure(e.message ?: e.toString())
            }
            enqueue(prepared.table, prepared.id, prepared.hlc, prepared.merged)
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
    inner class BatchScope internal constructor() {
        internal val specs = ArrayList<Triple<String, Map<String, JsonValue>, Mode>>()
        fun insert(table: String, vararg values: Pair<String, Any?>) = specs.add(Triple(table, valuesOf(values), Mode.INSERT))
        fun update(table: String, vararg values: Pair<String, Any?>) = specs.add(Triple(table, valuesOf(values), Mode.UPDATE))
        fun upsert(table: String, vararg values: Pair<String, Any?>) = specs.add(Triple(table, valuesOf(values), Mode.UPSERT))
        fun delete(table: String, id: String) = specs.add(Triple(table, mapOf<String, JsonValue>("id" to JsonValue.Str(id)), Mode.DELETE))
    }

    /**
     * Write many rows atomically: validate + merge every op first (one bad op aborts the
     * whole batch before anything is written), then one transaction, one query refresh per
     * affected table, and one sync. Mix in `delete` for atomic moves. Parity with TS `batch`.
     */
    fun batch(build: BatchScope.() -> Unit): BatchResult {
        val batchScope = BatchScope().apply(build)
        val outcome = lock.withLock {
            val driver = store.driver ?: return@withLock BatchResult.Failure("Database not ready.")
            val prepared = ArrayList<PreparedRow>(batchScope.specs.size)
            for ((table, values, mode) in batchScope.specs) {
                val (p, error) = prepareRow(table, values, mode)
                if (p == null) return@withLock BatchResult.Failure(error ?: "Batch failed.")
                prepared.add(p)
            }
            try {
                driver.transaction { for (p in prepared) store.writeRow(p.table, p.merged) }
            } catch (e: Exception) {
                return@withLock BatchResult.Failure(e.message ?: e.toString())
            }
            for (p in prepared) enqueue(p.table, p.id, p.hlc, p.merged)
            cache.refreshQueries(prepared.map { it.table }.toSet())
            BatchResult.Ok(prepared.map { it.id })
        }
        if (outcome.isOk && lock.withLock { transports }.isNotEmpty()) scope.launch { sync() }
        return outcome
    }

    /** Soft-delete many rows of one table in a single atomic batch. */
    fun deleteMany(table: String, ids: List<String>): BatchResult = batch { for (id in ids) delete(table, id) }

    /**
     * Reclaim local storage by hard-deleting soft-deleted rows (tombstones) older than
     * [olderThanMs] (default 30 days). Safe (parity with the TS engine): the grace window
     * lets the deletion replicate, unpushed deletes are kept while relays are configured,
     * and the relay retains tombstones so a re-sync re-applies them. Returns rows purged.
     */
    fun purgeDeleted(olderThanMs: Long = 30L * 24 * 60 * 60 * 1000): Int =
        lock.withLock { store.purgeDeleted(olderThanMs, System.currentTimeMillis(), transports.isNotEmpty()) }

    /** Encrypt the change and append it to the outbox. Called under the lock. */
    private fun enqueue(table: String, rowId: String, hlc: String, value: Map<String, JsonValue>) {
        val id = identity ?: return
        val payload = SyncPayload(1, table, "upsert", rowId, hlc, value)
        val envelope = try {
            Envelope.encrypt(id, hlc, deviceId, isoNow(), payload)
        } catch (e: Exception) {
            return
        }
        val jsonStr = json.encodeToString(SyncEnvelope.serializer(), envelope)
        store.driver?.exec(
            "insert or ignore into \"${Store.OUTBOX}\" (event_id, envelope_json) values (?, ?)",
            listOf(SqliteValue.Text(hlc), SqliteValue.Text(jsonStr)),
        )
    }

    // ----- Sync -------------------------------------------------------------

    /** Set transports (relays). Triggers an immediate sync and polling, or stops polling. */
    fun setTransports(next: List<Transport>) {
        lock.withLock { transports = next }
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
        while (true) {
            val shouldRun = lock.withLock {
                if (syncRequested) { syncRequested = false; true } else { syncJob = null; false }
            }
            if (!shouldRun) return
            runSync()
        }
    }

    private suspend fun runSync() {
        val snapshot = lock.withLock {
            val id = identity
            if (id == null || transports.isEmpty()) null
            else id to transports.map { normalizeBase(it.url) }
        } ?: return
        val (id, bases) = snapshot
        if (bases.isEmpty()) return
        setSyncState(SyncState.Syncing)
        val changed = HashSet<String>()
        try {
            for (base in bases) {
                pushOutbox(base, id)
                changed += pullAndApply(base, id)
            }
            lock.withLock {
                if (changed.isNotEmpty()) cache.refreshQueries(changed)
                pruneSeen()
                // Drop outbox events now delivered to every relay (cursors advanced above).
                store.pruneOutbox(bases)
                if (pollIntervalMs != defaultPollMs) pollIntervalMs = defaultPollMs
            }
            setSyncState(SyncState.Synced(isoNow()))
        } catch (e: Exception) {
            val status = (e as? RelayClient.RelayException)?.status
            val terminal = status != null && status in setOf(400, 401, 403, 413)
            if (terminal) lock.withLock { pollIntervalMs = backoffPollMs }
            setSyncState(SyncState.NotSynced(describe(e), terminal, status))
        }
    }

    private suspend fun pushOutbox(base: String, identity: Identity) {
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
        if (pending.isEmpty()) return
        val envelopes = pending.mapNotNull { (_, js) ->
            runCatching { json.decodeFromString(SyncEnvelope.serializer(), js) }.getOrNull()
        }
        RelayClient(base, identity.ownerId, identity.relayAuth).push(envelopes)
        val pushedAt = isoNow()
        lock.withLock {
            for ((eid, _) in pending) {
                store.driver?.exec(
                    // `pushed_at` marks "reached at least one relay" — keep the earliest via coalesce.
                    "update \"${Store.OUTBOX}\" set pushed_at = coalesce(pushed_at, ?) where event_id = ?",
                    listOf(SqliteValue.Text(pushedAt), SqliteValue.Text(eid)),
                )
            }
            store.setMeta(cursorKey, pending.last().first)
        }
    }

    private suspend fun pullAndApply(base: String, identity: Identity): Set<String> {
        val cursorKey = "cursor:$base"
        val after = lock.withLock { store.getMeta(cursorKey) ?: "" }
        val result = RelayClient(base, identity.ownerId, identity.relayAuth).pull(after)
        return lock.withLock {
            val changed = HashSet<String>()
            for (envelope in result.events) {
                val seen = store.driver?.select(
                    "select 1 from \"${Store.SEEN}\" where event_id = ?", listOf(SqliteValue.Text(envelope.eventId)),
                ) ?: emptyList()
                if (seen.isNotEmpty()) continue
                val payload = runCatching { Envelope.decrypt(identity, envelope) }.getOrNull() ?: continue
                observeHlc(payload.hlc)
                if (schema.has(payload.table)) {
                    applyRemoteRow(payload)
                    changed += payload.table
                }
                store.driver?.exec(
                    "insert or ignore into \"${Store.SEEN}\" (event_id) values (?)", listOf(SqliteValue.Text(envelope.eventId)),
                )
            }
            store.setMeta(cursorKey, result.nextCursor)
            changed
        }
    }

    /** Apply one decrypted row, last-writer-wins by `updatedAt`. Called under lock. */
    private fun applyRemoteRow(payload: SyncPayload) {
        val existing = store.readRow(payload.table, payload.rowId)
        val existingUpdated = (existing?.get("updatedAt") as? SqliteValue.Text)?.value
        if (existing != null && existingUpdated != null && Hlc.compare(existingUpdated, payload.hlc) >= 0) return
        val row = LinkedHashMap(payload.value)
        row["id"] = JsonValue.Str(payload.rowId)
        store.writeRow(payload.table, row)
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

    private fun observeHlc(remote: String) {
        clock?.observe(remote)
        persistClock()
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
