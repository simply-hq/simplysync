package com.simplysync.kotlin

import java.nio.file.Files
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test

/**
 * Exercises the React-parity engine surface on a pure JVM: schema -> DDL,
 * insert/update/upsert, typed reactive queries, soft deletes, validation, and —
 * with `-PrelayUrl=http://localhost:4100` — a live two-device round-trip.
 */
class EngineTest {
    private val abandonMnemonic =
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"

    private val schema = Schema(
        mapOf(
            "todo" to mapOf("id" to Column.id("todo"), "title" to Column.nonEmptyString, "done" to Column.sqliteBoolean),
            "note" to mapOf("id" to Column.id("note"), "body" to Column.string),
        ),
    )

    data class TodoRow(val id: String, val title: String, val done: Boolean, val updatedAt: String)

    private fun todoQuery(engine: SyncEngine): Query<TodoRow> = engine.createQuery(
        "select id, title, done, updatedAt from \"todo\" where \"isDeleted\" = 0 order by \"updatedAt\" desc",
    ) { TodoRow(it.string("id"), it.string("title"), it.boolean("done"), it.string("updatedAt")) }

    private fun localEngine(): SyncEngine = createSync(
        SyncEngineDeps(makeDriver = { JdbcSqliteDriver(":memory:") }, secureStorage = InMemorySecureStorage()),
    )(schema, SyncEngineConfig(name = "verify"))

    @Test
    fun remoteProjectionRejectsMalformedSystemColumns() {
        val store = Store(schema, SyncEngineConfig(name = "validation"))
        val hlc = Hlc.make("remote", 1_700_000_000_000)
        val (_, badFlag) = store.projectRemoteRow(
            "todo",
            mapOf(
                "id" to JsonValue.Str("row"),
                "title" to JsonValue.Str("Valid title"),
                "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                "updatedAt" to JsonValue.Str(hlc),
                "isDeleted" to JsonValue.Str("false"),
            ),
        )
        assertNotNull(badFlag)

        val (_, emptyId) = store.projectRemoteRow(
            "todo",
            mapOf(
                "id" to JsonValue.Str(""),
                "title" to JsonValue.Str("Valid title"),
                "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                "updatedAt" to JsonValue.Str(hlc),
                "isDeleted" to JsonValue.IntVal(0),
            ),
        )
        assertNotNull(emptyId)
    }

    private class FailingOutboxDriver(
        private val delegate: SqliteDriver,
    ) : SqliteDriver {
        var rejectOutboxInserts = true

        override fun exec(sql: String, params: List<SqliteValue>) {
            if (rejectOutboxInserts && sql.startsWith("insert or ignore into \"${Store.OUTBOX}\"")) {
                throw SqliteException("injected outbox failure")
            }
            delegate.exec(sql, params)
        }

        override fun select(
            sql: String,
            params: List<SqliteValue>,
        ): List<Map<String, SqliteValue>> = delegate.select(sql, params)

        override fun <T> transaction(body: () -> T): T = delegate.transaction(body)

        override fun close() = delegate.close()
    }

    private class FakeRelay(
        private val pullPage: (String) -> RelayClient.PullResult = {
            RelayClient.PullResult(emptyList(), it)
        },
    ) : RelayTransport {
        val pushBatchSizes = mutableListOf<Int>()
        val pushedEventIds = mutableListOf<String>()
        var pullCalls = 0

        override suspend fun push(events: List<SyncEnvelope>): RelayClient.PushResult {
            pushBatchSizes += events.size
            pushedEventIds += events.map { it.eventId }
            return RelayClient.PushResult(accepted = events.size, duplicate = 0)
        }

        override suspend fun pull(after: String): RelayClient.PullResult {
            pullCalls += 1
            return pullPage(after)
        }

        override suspend fun status() = RelayClient.StatusResponse()

        override suspend fun health() = RelayClient.HealthResponse(ok = true)
    }

    private suspend fun awaitSynced(engine: SyncEngine) {
        repeat(2_000) {
            if (engine.syncState.value is SyncState.Synced) return
            delay(1)
        }
        throw AssertionError("engine did not reach Synced")
    }

    @Test
    fun localCrudValidationAndReactiveQueries() = runBlocking {
        val engine = localEngine()
        engine.ready()

        val owner = engine.appOwner()
        assertNotNull("owner derived on boot", owner)
        assertEquals(
            "default owner is a 12-word recovery phrase",
            12,
            owner!!.recoveryKey.split(" ").size,
        )
        assertEquals("and the phrase is exposed as the mnemonic", owner.recoveryKey, owner.mnemonic)

        val q = todoQuery(engine)
        val first = engine.insert("todo", "title" to "Buy milk", "done" to false)
        assertTrue("insert returns ok", first.isOk)
        val id1 = first.id!!
        engine.insert("todo", "title" to "Walk dog", "done" to false)
        assertEquals("two rows after two inserts", 2, engine.loadQuery(q).size)
        assertEquals("ordered newest-first by HLC", "Walk dog", engine.loadQuery(q).first().title)

        val bad = engine.insert("todo", "title" to "")
        assertFalse("empty NonEmptyString rejected", bad.isOk)
        assertTrue("validation names the problem", bad.errorMessage!!.contains("non-empty"))

        assertTrue(engine.update("todo", "id" to id1, "done" to true).isOk)
        assertTrue("done toggled", engine.loadQuery(q).first { it.id == id1 }.done)
        assertFalse("update of a missing row fails", engine.update("todo", "id" to "nope", "done" to true).isOk)

        engine.update("todo", "id" to id1, "isDeleted" to sqliteTrue)
        assertEquals("soft-deleted row hidden", 1, engine.loadQuery(q).size)

        val live = engine.liveQuery(q)
        val before = live.value.size
        engine.insert("todo", "title" to "Third", "done" to false)
        assertEquals("reactive StateFlow refreshes on write", before + 1, live.value.size)

        engine.insert("note", "body" to "hello")
        val notes = engine.loadQuery(
            engine.createQuery("select id, body from \"note\"") { Pair(it.string("id"), it.string("body")) },
        )
        assertEquals("second table works independently", 1, notes.size)
        assertEquals("hello", notes[0].second)

        engine.close()
    }

    @Test
    fun additiveSchemaMigrationAddsNewColumns() {
        // Two stores over ONE database, mirroring an app that evolves its schema
        // across versions. Parity with the TS engine's additive migration.
        val driver = JdbcSqliteDriver(":memory:")
        val config = SyncEngineConfig(name = "migrate")

        // v1: a todo with just a title.
        val v1 = Schema(mapOf("todo" to mapOf("id" to Column.id("todo"), "title" to Column.nonEmptyString)))
        Store(v1, config).also { it.driver = driver; it.ensureSchema() }
        driver.exec(
            "insert into \"todo\" (id, title, createdAt, updatedAt, isDeleted) values (?, ?, ?, ?, 0)",
            listOf(SqliteValue.Text("t1"), SqliteValue.Text("buy milk"), SqliteValue.Text("2026-01-01"), SqliteValue.Text("aaa")),
        )

        // v2: the app grows — todos gain a priority and a due date.
        val v2 = Schema(
            mapOf(
                "todo" to mapOf(
                    "id" to Column.id("todo"),
                    "title" to Column.nonEmptyString,
                    "priority" to Column.finiteNumber,
                    "dueDate" to Column.string,
                ),
            ),
        )
        Store(v2, config).also { it.driver = driver; it.ensureSchema() }

        val cols = driver.select("pragma table_info(\"todo\")")
            .mapNotNull { (it["name"] as? SqliteValue.Text)?.value }.toSet()
        assertTrue("priority column added", cols.contains("priority"))
        assertTrue("dueDate column added", cols.contains("dueDate"))

        // The pre-migration row survives, reading NULL for the new columns.
        val rows = driver.select(
            "select title, priority, dueDate from \"todo\" where id = ?",
            listOf(SqliteValue.Text("t1")),
        )
        assertEquals(1, rows.size)
        assertEquals("buy milk", (rows[0]["title"] as SqliteValue.Text).value)
        assertEquals(SqliteValue.Null, rows[0]["priority"])
        assertEquals(SqliteValue.Null, rows[0]["dueDate"])

        // Idempotent: re-running ensureSchema doesn't error or duplicate columns.
        Store(v2, config).also { it.driver = driver; it.ensureSchema() }
        assertEquals("no duplicate columns", cols.size, driver.select("pragma table_info(\"todo\")").size)

        driver.close()
    }

    @Test
    fun futurePayloadIsRetainedUntilAppDeclaresSupport() = runBlocking {
        val path = Files.createTempFile("simplysync-schema-version-", ".sqlite")
        try {
            val versionedSchema = Schema(
                mapOf(
                    "todo" to mapOf(
                        "id" to Column.id("todo"),
                        "title" to Column.nonEmptyString,
                    ),
                ),
            )
            val remoteHlc = Hlc.make("remote", System.currentTimeMillis())
            val future = SyncPayload(
                schemaVersion = 2,
                table = "todo",
                op = "upsert",
                rowId = "future-row",
                hlc = remoteHlc,
                value = mapOf(
                    "title" to JsonValue.Str("understood by v2"),
                    "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                    "updatedAt" to JsonValue.Str(remoteHlc),
                    "isDeleted" to JsonValue.IntVal(0),
                ),
            )
            JdbcSqliteDriver(path.toString()).also { driver ->
                Store(
                    versionedSchema,
                    SyncEngineConfig(name = "payload-version"),
                ).also { store ->
                    store.driver = driver
                    store.ensureSchema()
                    store.deferRemoteEvent(remoteHlc, Envelope.encodePayload(future))
                }
                driver.close()
            }

            val storage = InMemorySecureStorage()
            val deps = SyncEngineDeps(
                makeDriver = { JdbcSqliteDriver(path.toString()) },
                secureStorage = storage,
            )
            val old = createSync(deps)(
                versionedSchema,
                SyncEngineConfig(name = "payload-version", schemaVersion = 1),
            )
            old.ready()
            JdbcSqliteDriver(path.toString()).also { probe ->
                assertTrue(
                    "v1 does not apply a v2 payload",
                    probe.select(
                        "select 1 from \"todo\" where id = ?",
                        listOf(SqliteValue.Text("future-row")),
                    ).isEmpty(),
                )
                assertEquals(
                    "v1 retains the future payload",
                    1,
                    probe.select(
                        "select 1 from \"${Store.DEFERRED}\" where event_id = ?",
                        listOf(SqliteValue.Text(remoteHlc)),
                    ).size,
                )
                probe.close()
            }
            old.close()

            val upgraded = createSync(deps)(
                versionedSchema,
                SyncEngineConfig(name = "payload-version", schemaVersion = 2),
            )
            upgraded.ready()
            assertEquals(
                "v2 replays the retained payload",
                "understood by v2",
                upgraded.loadQuery(
                    upgraded.createQuery(
                        "select title from \"todo\" where id = ?",
                        listOf(SqliteValue.Text("future-row")),
                    ) { it.string("title") },
                ).single(),
            )

            val local = upgraded.insert("todo", "title" to "written by v2")
            assertTrue("v2 local write succeeds", local.isOk)
            val envelopeJson = JdbcSqliteDriver(path.toString()).let { probe ->
                val value = (
                    probe.select(
                        "select envelope_json from \"${Store.OUTBOX}\" order by event_id desc limit 1",
                    ).single()["envelope_json"] as SqliteValue.Text
                ).value
                probe.close()
                value
            }
            val envelope = Json.decodeFromString(
                SyncEnvelope.serializer(),
                envelopeJson,
            )
            val owner = upgraded.appOwner()
            assertNotNull(owner)
            assertEquals(
                "local events carry the configured version",
                2,
                Envelope.decrypt(
                    IdentityDeriver.derive(owner!!.recoveryKey),
                    envelope,
                ).schemaVersion,
            )
            upgraded.close()
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun unknownTablePayloadIsRetainedUntilSchemaUpgrade() = runBlocking {
        val path = Files.createTempFile("simplysync-unknown-table-", ".sqlite")
        try {
            val oldSchema = Schema(
                mapOf("todo" to mapOf("id" to Column.id("todo"), "title" to Column.nonEmptyString)),
            )
            val upgradedSchema = Schema(
                oldSchema.tables + (
                    "task" to mapOf("id" to Column.id("task"), "title" to Column.nonEmptyString)
                ),
            )
            val remoteHlc = Hlc.make("remote", System.currentTimeMillis())
            val payload = SyncPayload(
                schemaVersion = 1,
                table = "task",
                op = "upsert",
                rowId = "task-1",
                hlc = remoteHlc,
                value = mapOf(
                    "title" to JsonValue.Str("arrived before the table"),
                    "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                    "updatedAt" to JsonValue.Str(remoteHlc),
                    "isDeleted" to JsonValue.IntVal(0),
                ),
            )
            JdbcSqliteDriver(path.toString()).also { driver ->
                Store(oldSchema, SyncEngineConfig(name = "unknown-table")).also { store ->
                    store.driver = driver
                    store.ensureSchema()
                    store.deferRemoteEvent(remoteHlc, Envelope.encodePayload(payload))
                }
                driver.close()
            }

            val deps = SyncEngineDeps(
                makeDriver = { JdbcSqliteDriver(path.toString()) },
                secureStorage = InMemorySecureStorage(),
            )
            val old = createSync(deps)(oldSchema, SyncEngineConfig(name = "unknown-table"))
            old.ready()
            JdbcSqliteDriver(path.toString()).also { probe ->
                assertEquals(
                    1,
                    probe.select(
                        "select 1 from \"${Store.DEFERRED}\" where event_id = ?",
                        listOf(SqliteValue.Text(remoteHlc)),
                    ).size,
                )
                probe.close()
            }
            old.close()

            val upgraded = createSync(deps)(
                upgradedSchema,
                SyncEngineConfig(name = "unknown-table"),
            )
            upgraded.ready()
            assertEquals(
                "arrived before the table",
                upgraded.loadQuery(
                    upgraded.createQuery(
                        "select title from \"task\" where id = ?",
                        listOf(SqliteValue.Text("task-1")),
                    ) { it.string("title") },
                ).single(),
            )
            upgraded.close()
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun perRelayPushCursorReSelectsEventsPushedElsewhere() {
        // The multi-relay push fix selects outbox events by a per-relay high-water mark
        // (event_id > cursor) instead of a single global `pushed_at is null`, so every
        // relay independently receives every event. Verify that selection logic — in
        // particular that an event already pushed to one relay is STILL selected for a
        // fresh relay (the exact case the old logic got wrong).
        val driver = JdbcSqliteDriver(":memory:")
        val schema = Schema(mapOf("todo" to mapOf("id" to Column.id("todo"), "title" to Column.nonEmptyString)))
        Store(schema, SyncEngineConfig(name = "cursor")).also { it.driver = driver; it.ensureSchema() }
        for (eid in listOf("e1", "e2", "e3")) {
            driver.exec(
                "insert into \"${Store.OUTBOX}\" (event_id, envelope_json) values (?, ?)",
                listOf(SqliteValue.Text(eid), SqliteValue.Text("{}")),
            )
        }
        fun after(cursor: String): List<String> = driver.select(
            "select event_id from \"${Store.OUTBOX}\" where event_id > ? order by event_id asc",
            listOf(SqliteValue.Text(cursor)),
        ).mapNotNull { (it["event_id"] as? SqliteValue.Text)?.value }

        assertEquals("empty cursor selects all (a fresh relay)", listOf("e1", "e2", "e3"), after(""))
        assertEquals("advances past acked events", listOf("e2", "e3"), after("e1"))
        assertEquals("fully caught up selects none", emptyList<String>(), after("e3"))

        // e1 already pushed to one relay; a second relay (cursor "") must still get it —
        // the old `pushed_at is null` filter would have skipped it.
        driver.exec(
            "update \"${Store.OUTBOX}\" set pushed_at = ? where event_id = ?",
            listOf(SqliteValue.Text("2026-01-01"), SqliteValue.Text("e1")),
        )
        assertEquals(
            "a fresh relay still gets events already pushed elsewhere",
            listOf("e1", "e2", "e3"),
            after(""),
        )
        driver.close()
    }

    @Test
    fun batchWritesAtomicallyAndSupportsMixedDelete() = runBlocking {
        val engine = localEngine()
        engine.ready()
        val q = todoQuery(engine)

        // Bulk seed in one atomic batch.
        val seed = engine.batch {
            insert("todo", "title" to "a", "done" to false)
            insert("todo", "title" to "b", "done" to false)
            insert("todo", "title" to "c", "done" to false)
        }
        assertTrue("batch ok", seed.isOk)
        assertEquals(3, seed.ids.size)
        assertEquals(3, engine.loadQuery(q).size)

        // Atomic: one invalid op aborts the whole batch — nothing is written.
        val before = engine.loadQuery(q).size
        val bad = engine.batch {
            insert("todo", "title" to "ok", "done" to false)
            insert("todo", "title" to "", "done" to false) // empty NonEmptyString rejected
        }
        assertFalse("invalid op fails the batch", bad.isOk)
        assertEquals("nothing written on a failed batch", before, engine.loadQuery(q).size)

        // Mix a write and a delete atomically.
        val first = engine.loadQuery(q).first()
        val mixed = engine.batch {
            insert("todo", "title" to "new", "done" to false)
            delete("todo", first.id)
        }
        assertTrue(mixed.isOk)
        assertTrue("inserted row present", engine.loadQuery(q).any { it.title == "new" })
        assertFalse("deleted row gone", engine.loadQuery(q).any { it.id == first.id })

        engine.close()
    }

    @Test
    fun asyncBatchCommitsFromCoroutineWithoutCallerThreadWork() = runBlocking {
        val engine = localEngine()
        engine.ready()
        val query = todoQuery(engine)

        val result = engine.batchAsync {
            insert("todo", "id" to "async-a", "title" to "A", "done" to false)
            insert("todo", "id" to "async-b", "title" to "B", "done" to false)
        }

        assertTrue("async batch ok", result.isOk)
        assertEquals(listOf("A", "B"), engine.loadQuery(query).map { it.title }.sorted())
        engine.close()
    }

    @Test
    fun compareAndSetRejectsAStaleEditorSnapshot() = runBlocking {
        val engine = localEngine()
        engine.ready()
        val query = todoQuery(engine)
        val inserted = engine.insert("todo", "title" to "original", "done" to false)
        val id = inserted.id!!
        val version = engine.loadQuery(query).first().updatedAt

        val newer = engine.update(
            "todo", version,
            "id" to id, "title" to "newer",
        )
        assertTrue(newer.isOk)
        val stale = engine.update(
            "todo", version,
            "id" to id, "title" to "stale overwrite",
        )

        assertFalse(stale.isOk)
        assertTrue(stale.errorMessage!!.contains("Write conflict"))
        assertEquals("newer", engine.loadQuery(query).first().title)
        engine.close()
    }

    @Test
    fun restoreCompareAndSetsTheExactTombstone() = runBlocking {
        val engine = localEngine()
        engine.ready()
        val states = engine.createQuery(
            "select updatedAt, isDeleted from \"todo\" where id = 'restore-id'",
        ) { Pair(it.string("updatedAt"), it.long("isDeleted")) }
        assertTrue(engine.insert(
            "todo", "id" to "restore-id", "title" to "restore me", "done" to false
        ).isOk)
        val liveVersion = engine.loadQuery(states).first().first
        assertTrue(engine.delete("todo", "restore-id", liveVersion).isOk)
        val tombstoneVersion = engine.loadQuery(states).first().first

        assertTrue(engine.restore("todo", "restore-id", tombstoneVersion).isOk)
        assertEquals(0L, engine.loadQuery(states).first().second)

        val staleRestore = engine.restore("todo", "restore-id", tombstoneVersion)
        assertFalse(staleRestore.isOk)
        assertTrue(staleRestore.errorMessage!!.contains("Write conflict"))
        engine.close()
    }

    @Test
    fun rowAndOutboxCommitOrRollbackTogether() = runBlocking {
        val driver = FailingOutboxDriver(JdbcSqliteDriver(":memory:"))
        val engine = createSync(
            SyncEngineDeps(makeDriver = { driver }, secureStorage = InMemorySecureStorage()),
        )(schema, SyncEngineConfig(name = "atomic-outbox"))
        engine.ready()

        fun count(table: String): Int =
            (driver.select("select count(*) as c from \"$table\"").first()["c"] as SqliteValue.Integer)
                .value.toInt()

        val failed = engine.insert("todo", "title" to "must roll back", "done" to false)
        assertFalse("outbox failure fails the mutation", failed.isOk)
        assertTrue("failure is surfaced", failed.errorMessage!!.contains("injected outbox failure"))
        assertEquals("row rolled back with outbox", 0, count("todo"))
        assertEquals("no outbox entry committed", 0, count(Store.OUTBOX))

        driver.rejectOutboxInserts = false
        val succeeded = engine.insert("todo", "title" to "committed", "done" to false)
        assertTrue("same public mutation succeeds after storage recovers", succeeded.isOk)
        assertEquals(1, count("todo"))
        assertEquals(1, count(Store.OUTBOX))

        driver.rejectOutboxInserts = true
        val failedBatch = engine.batch {
            insert("todo", "title" to "batch a", "done" to false)
            insert("todo", "title" to "batch b", "done" to false)
        }
        assertFalse("outbox failure fails the whole batch", failedBatch.isOk)
        assertEquals("batch rows roll back together", 1, count("todo"))
        assertEquals("batch outbox entries roll back together", 1, count(Store.OUTBOX))

        engine.close()
    }

    @Test
    fun oneSyncDrainsEveryPushBatch() = runBlocking {
        val fakeRelay = FakeRelay()
        RelayTransportFactory.create = { _, _, _ -> fakeRelay }
        val engine = localEngine()
        try {
            engine.ready()
            repeat(1_001) { index ->
                assertTrue(
                    engine.insert(
                        "note",
                        "body" to "queued-$index",
                    ).isOk,
                )
            }

            engine.setTransports(listOf(Transport("http://relay.test")))
            awaitSynced(engine)

            assertEquals(
                "a single sync drains the full backlog instead of one page per poll",
                listOf(1_000, 1),
                fakeRelay.pushBatchSizes,
            )
        } finally {
            engine.close()
            RelayTransportFactory.reset()
        }
    }

    @Test
    fun oneSyncDrainsEveryPullPageBeforeReportingSynced() = runBlocking {
        val recoveryKey = IdentityDeriver.createRecoveryKey()
        val identity = IdentityDeriver.derive(recoveryKey)
        val remoteEvents = (0 until 501).map { index ->
            val eventId = Hlc.make("remote-device", 1_000L + index, 0)
            val rowId = "remote-$index"
            Envelope.encrypt(
                identity,
                eventId,
                "remote-device",
                "2026-01-01T00:00:00.000Z",
                SyncPayload(
                    schemaVersion = 1,
                    table = "note",
                    op = "upsert",
                    rowId = rowId,
                    hlc = eventId,
                    value = mapOf(
                        "id" to JsonValue.Str(rowId),
                        "body" to JsonValue.Str("body-$index"),
                        "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                        "updatedAt" to JsonValue.Str(eventId),
                        "isDeleted" to sqliteFalse,
                    ),
                ),
            )
        }
        val fakeRelay = FakeRelay { after ->
            when (after) {
                "" -> RelayClient.PullResult(remoteEvents.take(500), "500")
                "500" -> RelayClient.PullResult(remoteEvents.drop(500), "501")
                else -> RelayClient.PullResult(emptyList(), "501")
            }
        }
        RelayTransportFactory.create = { _, _, _ -> fakeRelay }
        val driver = JdbcSqliteDriver(":memory:")
        val name = "drain-pull"
        val engine = createSync(
            SyncEngineDeps(
                makeDriver = { driver },
                secureStorage = InMemorySecureStorage(mapOf("$name:mnemonic" to recoveryKey)),
            ),
        )(schema, SyncEngineConfig(name = name, syncIntervalMs = 60_000))

        try {
            engine.ready()
            engine.setTransports(listOf(Transport("http://relay.test")))
            awaitSynced(engine)

            val count = (
                driver.select("select count(*) as c from \"note\"").first()["c"]
                    as SqliteValue.Integer
                ).value.toInt()
            assertEquals("all pages applied before Synced", 501, count)
            assertEquals("500 + 1 + empty terminal page", 3, fakeRelay.pullCalls)
        } finally {
            engine.close()
            RelayTransportFactory.reset()
        }
    }

    @Test
    fun unmarkedMnemonicDatabaseWithRowsKeepsLegacyAndroidOwner() = runBlocking {
        val name = "identity-legacy-upgrade"
        val driver = JdbcSqliteDriver(":memory:")
        Store(schema, SyncEngineConfig(name = name)).also {
            it.driver = driver
            it.ensureSchema()
        }
        val updatedAt = Hlc.make("old-android", 1_000, 0)
        driver.exec(
            """
            insert into "note" (id, body, createdAt, updatedAt, isDeleted)
            values (?, ?, ?, ?, 0)
            """.trimIndent(),
            listOf(
                SqliteValue.Text("existing-note"),
                SqliteValue.Text("created before identity profiles"),
                SqliteValue.Text("2026-01-01T00:00:00.000Z"),
                SqliteValue.Text(updatedAt),
            ),
        )
        val secureStorage = InMemorySecureStorage(mapOf("$name:mnemonic" to abandonMnemonic))
        val engine = createSync(
            SyncEngineDeps(makeDriver = { driver }, secureStorage = secureStorage),
        )(schema, SyncEngineConfig(name = name))

        try {
            engine.ready()
            val expected = IdentityDeriver.derive(
                abandonMnemonic,
                MnemonicIdentityProfile.EVOLU_LEGACY_V1,
            )
            assertEquals("upgrade must not silently switch owners", expected.ownerId, engine.appOwner()!!.id)
            assertEquals(
                MnemonicIdentityProfile.EVOLU_LEGACY_V1.storageValue,
                secureStorage.getItem("$name:mnemonicIdentityProfile"),
            )
            val persisted = driver.select(
                "select value from \"${Store.META}\" where key = ?",
                listOf(SqliteValue.Text("identity:mnemonicProfile")),
            )
            assertEquals(
                MnemonicIdentityProfile.EVOLU_LEGACY_V1.storageValue,
                (persisted.single()["value"] as SqliteValue.Text).value,
            )
        } finally {
            engine.close()
        }
    }

    @Test
    fun existingSimplySyncOutboxWinsOverLegacyRowFallback() = runBlocking {
        val name = "identity-current-upgrade"
        val driver = JdbcSqliteDriver(":memory:")
        Store(schema, SyncEngineConfig(name = name)).also {
            it.driver = driver
            it.ensureSchema()
        }
        val identity = IdentityDeriver.derive(
            abandonMnemonic,
            MnemonicIdentityProfile.SIMPLYSYNC_V1,
        )
        val eventId = Hlc.make("current-android", 2_000, 0)
        val row = linkedMapOf(
            "id" to JsonValue.Str("current-note"),
            "body" to JsonValue.Str("already on SimplySync paths"),
            "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
            "updatedAt" to JsonValue.Str(eventId),
            "isDeleted" to sqliteFalse,
        )
        driver.exec(
            """
            insert into "note" (id, body, createdAt, updatedAt, isDeleted)
            values (?, ?, ?, ?, 0)
            """.trimIndent(),
            listOf(
                SqliteValue.Text("current-note"),
                SqliteValue.Text("already on SimplySync paths"),
                SqliteValue.Text("2026-01-01T00:00:00.000Z"),
                SqliteValue.Text(eventId),
            ),
        )
        val envelope = Envelope.encrypt(
            identity,
            eventId,
            "current-android",
            "2026-01-01T00:00:00.000Z",
            SyncPayload(1, "note", "upsert", "current-note", eventId, row),
        )
        driver.exec(
            "insert into \"${Store.OUTBOX}\" (event_id, envelope_json) values (?, ?)",
            listOf(
                SqliteValue.Text(eventId),
                SqliteValue.Text(Json.encodeToString(SyncEnvelope.serializer(), envelope)),
            ),
        )
        val secureStorage = InMemorySecureStorage(mapOf("$name:mnemonic" to abandonMnemonic))
        val engine = createSync(
            SyncEngineDeps(makeDriver = { driver }, secureStorage = secureStorage),
        )(schema, SyncEngineConfig(name = name))

        try {
            engine.ready()
            assertEquals(
                "an existing current-profile app must not be reclassified as legacy",
                identity.ownerId,
                engine.appOwner()!!.id,
            )
            assertEquals(
                MnemonicIdentityProfile.SIMPLYSYNC_V1.storageValue,
                secureStorage.getItem("$name:mnemonicIdentityProfile"),
            )
        } finally {
            engine.close()
        }
    }

    @Test
    fun emptyMnemonicDatabaseDefaultsToCrossPlatformIdentity() = runBlocking {
        val name = "identity-new-database"
        val secureStorage = InMemorySecureStorage(mapOf("$name:mnemonic" to abandonMnemonic))
        val engine = createSync(
            SyncEngineDeps(
                makeDriver = { JdbcSqliteDriver(":memory:") },
                secureStorage = secureStorage,
            ),
        )(schema, SyncEngineConfig(name = name))

        try {
            engine.ready()
            assertEquals(
                IdentityDeriver.derive(abandonMnemonic).ownerId,
                engine.appOwner()!!.id,
            )
            assertEquals(
                MnemonicIdentityProfile.SIMPLYSYNC_V1.storageValue,
                secureStorage.getItem("$name:mnemonicIdentityProfile"),
            )
        } finally {
            engine.close()
        }
    }

    @Test
    fun restorePhraseDiscoversLegacyRelayOwnerWithoutAFlag() = runBlocking {
        val legacyIdentity = IdentityDeriver.derive(
            abandonMnemonic,
            MnemonicIdentityProfile.EVOLU_LEGACY_V1,
        )
        val eventId = Hlc.make("legacy-relay", 3_000, 0)
        val event = Envelope.encrypt(
            legacyIdentity,
            eventId,
            "legacy-relay",
            "2026-01-01T00:00:00.000Z",
            SyncPayload(
                1,
                "note",
                "upsert",
                "legacy-note",
                eventId,
                linkedMapOf(
                    "id" to JsonValue.Str("legacy-note"),
                    "body" to JsonValue.Str("relay backup"),
                    "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                    "updatedAt" to JsonValue.Str(eventId),
                    "isDeleted" to sqliteFalse,
                ),
            ),
        )
        RelayTransportFactory.create = { _, ownerId, _ ->
            FakeRelay { after ->
                if (ownerId == legacyIdentity.ownerId && after.isEmpty()) {
                    RelayClient.PullResult(listOf(event), "legacy-1")
                } else {
                    RelayClient.PullResult(emptyList(), after.ifEmpty { "empty" })
                }
            }
        }
        val name = "identity-restore-legacy"
        val secureStorage = InMemorySecureStorage()
        val engine = createSync(
            SyncEngineDeps(
                makeDriver = { JdbcSqliteDriver(":memory:") },
                secureStorage = secureStorage,
            ),
        )(schema, SyncEngineConfig(name = name, syncIntervalMs = 60_000))

        try {
            engine.ready()
            engine.setTransports(listOf(Transport("http://relay.test")))
            awaitSynced(engine)
            engine.restoreAppOwner(abandonMnemonic)

            assertEquals(
                "restore probes both mnemonic profiles and selects the one with data",
                legacyIdentity.ownerId,
                engine.appOwner()!!.id,
            )
            assertEquals(
                MnemonicIdentityProfile.EVOLU_LEGACY_V1.storageValue,
                secureStorage.getItem("$name:mnemonicIdentityProfile"),
            )
            // Wait for the post-restore pull before closing the shared driver.
            engine.sync()
        } finally {
            engine.close()
            RelayTransportFactory.reset()
        }
    }

    @Test
    fun deleteManyClearsSeveralRowsAtomically() = runBlocking {
        val engine = localEngine()
        engine.ready()
        val a = engine.insert("todo", "title" to "a", "done" to false).id!!
        engine.insert("todo", "title" to "b", "done" to false)
        val c = engine.insert("todo", "title" to "c", "done" to false).id!!
        val q = todoQuery(engine)
        assertEquals(3, engine.loadQuery(q).size)

        val res = engine.deleteMany("todo", listOf(a, c))
        assertTrue(res.isOk)
        assertEquals(listOf("b"), engine.loadQuery(q).map { it.title })

        engine.close()
    }

    @Test
    fun deleteSoftDeletesHidesRowKeepsTombstoneAndIsIdempotent() = runBlocking {
        val engine = localEngine()
        engine.ready()
        val created = engine.insert("todo", "title" to "buy milk", "done" to false)
        assertTrue(created.isOk)
        val id = created.id!!

        val visible = todoQuery(engine)
        assertEquals(1, engine.loadQuery(visible).size)

        // delete() hides it from isDeleted-filtered queries...
        assertTrue("delete returns ok", engine.delete("todo", id).isOk)
        assertEquals("soft-deleted row hidden", 0, engine.loadQuery(visible).size)

        // ...but the tombstone physically remains so the deletion can replicate.
        val all = engine.loadQuery(engine.createQuery("select id from \"todo\"") { it.string("id") })
        assertEquals("tombstone retained", 1, all.size)

        // idempotent: deleting an id that isn't present still succeeds.
        assertTrue("delete of an unknown id succeeds", engine.delete("todo", "ghost").isOk)

        engine.close()
    }

    @Test
    fun purgeDeletedReclaimsOldTombstonesKeepsLiveRows() = runBlocking {
        val engine = localEngine() // no relays -> requirePushed is false
        engine.ready()
        val keep = engine.insert("todo", "title" to "keep", "done" to false).id!!
        val gone = engine.insert("todo", "title" to "gone", "done" to false).id!!
        engine.delete("todo", gone)

        // A 30-year window keeps everything (nothing is that old).
        assertEquals(0, engine.purgeDeleted(olderThanMs = 1000L * 3600 * 24 * 365 * 30))

        // olderThanMs = 0 ("older than now") reclaims the tombstone, keeps the live row.
        assertEquals(1, engine.purgeDeleted(olderThanMs = 0))
        val ids = engine.loadQuery(engine.createQuery("select id from \"todo\"") { it.string("id") })
        assertEquals(listOf(keep), ids)

        engine.close()
    }

    @Test
    fun purgeDeletedStaysDisabledAfterRelayIsDetached() = runBlocking {
        val path = Files.createTempFile("simplysync-relay-history-", ".sqlite")
        try {
            JdbcSqliteDriver(path.toString()).also { driver ->
                Store(schema, SyncEngineConfig(name = "relay-history")).also { store ->
                    store.driver = driver
                    store.ensureSchema()
                    store.writeRow(
                        "todo",
                        mapOf(
                            "id" to JsonValue.Str("deleted-row"),
                            "title" to JsonValue.Str("keep tombstone"),
                            "done" to sqliteFalse,
                            "createdAt" to JsonValue.Str("2020-01-01T00:00:00.000Z"),
                            "updatedAt" to JsonValue.Str(Hlc.make("remote", 1_000)),
                            "isDeleted" to sqliteTrue,
                        ),
                    )
                    // Durable evidence left after setTransports(emptyList()).
                    store.setMeta("cursor:http://relay.test", "1")
                }
                driver.close()
            }
            val engine = createSync(
                SyncEngineDeps(
                    makeDriver = { JdbcSqliteDriver(path.toString()) },
                    secureStorage = InMemorySecureStorage(),
                ),
            )(schema, SyncEngineConfig(name = "relay-history"))
            engine.ready()

            assertEquals(0, engine.purgeDeleted(olderThanMs = 0))
            assertEquals(
                1,
                engine.loadQuery(
                    engine.createQuery(
                        "select id from \"todo\" where id = ?",
                        listOf(SqliteValue.Text("deleted-row")),
                    ) { it.string("id") },
                ).size,
            )
            engine.close()
        } finally {
            Files.deleteIfExists(path)
        }
    }

    @Test
    fun purgeDeletedKeepsUnpushedTombstoneWhenRelaysConfigured() {
        val driver = JdbcSqliteDriver(":memory:")
        val schema = Schema(mapOf("todo" to mapOf("id" to Column.id("todo"), "title" to Column.nonEmptyString)))
        val store = Store(schema, SyncEngineConfig(name = "purge")).also { it.driver = driver; it.ensureSchema() }
        val oldHlc = Hlc.make("devA", 1000L, 0)
        store.writeRow(
            "todo",
            mapOf(
                "id" to JsonValue.Str("t1"),
                "title" to JsonValue.Str("x"),
                "createdAt" to JsonValue.Str("2020-01-01"),
                "updatedAt" to JsonValue.Str(oldHlc),
                "isDeleted" to sqliteTrue,
            ),
        )
        driver.exec(
            "insert into \"${Store.OUTBOX}\" (event_id, envelope_json, pushed_at) values (?, '{}', NULL)",
            listOf(SqliteValue.Text(oldHlc)),
        )
        fun count(): Int =
            (driver.select("select count(*) as c from \"todo\"").first()["c"] as SqliteValue.Integer).value.toInt()

        // Ancient + relays configured + unpushed delete -> kept.
        assertEquals(0, store.purgeDeleted(0, 5000, requirePushed = true))
        assertEquals(1, count())

        // Once the delete is pushed, it can be reclaimed.
        driver.exec(
            "update \"${Store.OUTBOX}\" set pushed_at = ? where event_id = ?",
            listOf(SqliteValue.Text("2020-01-01"), SqliteValue.Text(oldHlc)),
        )
        assertEquals(1, store.purgeDeleted(0, 5000, requirePushed = true))
        assertEquals(0, count())

        driver.close()
    }

    @Test
    fun pruneOutboxDropsEventsDeliveredToEveryRelay() {
        // Parity with the TS engine: the outbox is a send queue, not an archive. Drop
        // events confirmed delivered to EVERY current relay (event_id <= min push cursor).
        val driver = JdbcSqliteDriver(":memory:")
        val schema = Schema(mapOf("todo" to mapOf("id" to Column.id("todo"), "title" to Column.nonEmptyString)))
        val store = Store(schema, SyncEngineConfig(name = "prune")).also { it.driver = driver; it.ensureSchema() }
        for (eid in listOf("e1", "e2", "e3", "e4")) {
            driver.exec(
                "insert into \"${Store.OUTBOX}\" (event_id, envelope_json, pushed_at) values (?, '{}', ?)",
                listOf(SqliteValue.Text(eid), SqliteValue.Text("2026-01-01")),
            )
        }
        fun outboxCount(): Int =
            (driver.select("select count(*) as c from \"${Store.OUTBOX}\"").first()["c"] as SqliteValue.Integer).value.toInt()

        // a acked through e3, b only through e2 -> min is e2 -> prune e1, e2.
        store.setMeta("push:http://a", "e3")
        store.setMeta("push:http://b", "e2")
        assertEquals(2, store.pruneOutbox(listOf("http://a", "http://b")))
        assertEquals(2, outboxCount()) // e3, e4 remain (not yet on b)

        // A newly-added relay with no cursor yet -> prune nothing (it needs the backlog).
        assertEquals(0, store.pruneOutbox(listOf("http://a", "http://b", "http://c")))
        assertEquals(2, outboxCount())

        // No relays configured -> prune nothing.
        assertEquals(0, store.pruneOutbox(emptyList()))
        assertEquals(2, outboxCount())

        driver.close()
    }

    @Test
    fun liveTwoDeviceRoundTrip() = runBlocking {
        val relayUrl = System.getProperty("SIMPLYSYNC_RELAY_URL") ?: System.getenv("SIMPLYSYNC_RELAY_URL")
        assumeTrue("set -PrelayUrl to run the live test", relayUrl != null)
        // -PrecoveryKey joins an owner another platform already created, which is
        // how the cross-platform interop run (bun run todo:interop) checks that
        // Kotlin, Swift, and TypeScript converge on ONE account.
        val key = System.getProperty("SIMPLYSYNC_RECOVERY_KEY")
            ?: System.getenv("SIMPLYSYNC_RECOVERY_KEY")
            ?: IdentityDeriver.createRecoveryKey()
        fun engineFor(name: String): SyncEngine = createSync(
            SyncEngineDeps(
                makeDriver = { JdbcSqliteDriver(":memory:") },
                secureStorage = InMemorySecureStorage(mapOf("$name:mnemonic" to key)),
            ),
        )(schema, SyncEngineConfig(name = name, transports = listOf(Transport(relayUrl!!)), syncIntervalMs = 1000))

        val a = engineFor("liveA")
        val b = engineFor("liveB")
        a.ready(); b.ready()
        assertEquals("both devices derive the same owner", a.appOwner()!!.id, b.appOwner()!!.id)

        a.insert("todo", "title" to "From A", "done" to false)
        a.sync()
        val qb = todoQuery(b)
        var received = false
        repeat(8) { if (!received) { b.sync(); received = b.loadQuery(qb).any { it.title == "From A" } } }
        assertTrue("device B pulled + decrypted + applied A's row", received)

        val row = b.loadQuery(qb).first { it.title == "From A" }
        b.update("todo", "id" to row.id, "title" to "Edited by B")
        b.sync()
        val qa = todoQuery(a)
        var converged = false
        repeat(8) { if (!converged) { a.sync(); converged = a.loadQuery(qa).any { it.title == "Edited by B" } } }
        assertTrue("A converged on B's edit (LWW by HLC)", converged)

        a.close(); b.close()
    }

    // ----- Edge cases shared with the TypeScript engine (edge-cases.test.ts) -----

    private fun noteEnvelope(identity: Identity, rowId: String, body: String, hlc: String): SyncEnvelope =
        Envelope.encrypt(
            identity, hlc, "remote-device", "2026-01-01T00:00:00.000Z",
            SyncPayload(
                schemaVersion = 1, table = "note", op = "upsert", rowId = rowId, hlc = hlc,
                value = mapOf(
                    "id" to JsonValue.Str(rowId),
                    "body" to JsonValue.Str(body),
                    "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                    "updatedAt" to JsonValue.Str(hlc),
                    "isDeleted" to sqliteFalse,
                ),
            ),
        )

    private fun metaValue(driver: SqliteDriver, key: String): String? =
        (driver.select("select value from \"${Store.META}\" where key = ?", listOf(SqliteValue.Text(key)))
            .firstOrNull()?.get("value") as? SqliteValue.Text)?.value

    @Test
    fun pruneForgetsThePushCursorOfARelayNoLongerConfigured() {
        // A relay removed from the set cannot acknowledge what is pruned while it
        // is away. Its push cursor must stop vouching for it, or re-adding it skips
        // the backfill and the relay silently lacks those events.
        val driver = JdbcSqliteDriver(":memory:")
        val store = Store(schema, SyncEngineConfig(name = "prune-forget")).also { it.driver = driver; it.ensureSchema() }
        for (eid in listOf("e1", "e2", "e3")) {
            driver.exec(
                "insert into \"${Store.OUTBOX}\" (event_id, envelope_json, pushed_at) values (?, '{}', ?)",
                listOf(SqliteValue.Text(eid), SqliteValue.Text("2026-01-01")),
            )
        }
        store.setMeta("push:http://a", "e3")
        store.setMeta("push:http://b", "e2")
        store.setMeta("backfill:http://b", "1")
        store.setMeta("cursor:http://b", "9")

        assertEquals("a alone acknowledged everything", 3, store.pruneOutbox(listOf("http://a")))
        assertEquals("b's push cursor no longer vouches for it", null, store.getMeta("push:http://b"))
        assertEquals("b will be re-seeded when re-added", null, store.getMeta("backfill:http://b"))
        assertEquals("b's pull cursor is untouched", "9", store.getMeta("cursor:http://b"))
        assertEquals("a configured relay keeps its cursor", "e3", store.getMeta("push:http://a"))

        // Nothing pruned -> nothing forgotten (a single relay toggled off is safe).
        store.setMeta("push:http://c", "zz")
        assertEquals(0, store.pruneOutbox(listOf("http://a")))
        assertEquals("zz", store.getMeta("push:http://c"))
        driver.close()
    }

    @Test
    fun explicitUpdatedAtMustBeNewerThanTheCurrentRow() = runBlocking {
        // A caller-supplied updatedAt bypasses the clock, so it can sort at or
        // below the row's current version — peers would keep their copy under LWW
        // while this device regressed its own. Equal is refused too: the HLC-keyed
        // outbox would drop the event while its row committed.
        val driver = JdbcSqliteDriver(":memory:")
        val engine = createSync(
            SyncEngineDeps(makeDriver = { driver }, secureStorage = InMemorySecureStorage()),
        )(schema, SyncEngineConfig(name = "explicit-hlc"))
        try {
            engine.ready()
            val id = (engine.insert("todo", "title" to "current", "done" to false) as MutationResult.Ok).id!!
            val current = (driver.select("select updatedAt from \"todo\" where id = ?", listOf(SqliteValue.Text(id)))
                .first()["updatedAt"] as SqliteValue.Text).value
            val now = System.currentTimeMillis()
            val older = Hlc.make("import", now - 60_000)
            assertFalse("an older stamp is refused", engine.upsert("todo", "id" to id, "title" to "stale", "updatedAt" to older).isOk)
            assertFalse("an equal stamp is refused", engine.upsert("todo", "id" to id, "title" to "same", "updatedAt" to current).isOk)
            assertFalse(
                "insert overwrites too, so it gets the same guard",
                engine.insert("todo", "id" to id, "title" to "stale insert", "updatedAt" to older).isOk,
            )
            assertEquals(
                "the row is untouched", "current",
                (driver.select("select title from \"todo\" where id = ?", listOf(SqliteValue.Text(id))).first()["title"] as SqliteValue.Text).value,
            )
            assertTrue(
                "a newer stamp is accepted",
                engine.upsert("todo", "id" to id, "title" to "forward", "updatedAt" to Hlc.make("import", now + 1_000)).isOk,
            )

            val shared = Hlc.make("import", now - 500)
            assertTrue(engine.insert("todo", "title" to "first", "done" to false, "updatedAt" to shared).isOk)
            assertFalse(
                "an HLC already queued may not be reused for another row",
                engine.insert("todo", "title" to "second", "done" to false, "updatedAt" to shared).isOk,
            )
            val other = Hlc.make("import", now - 400)
            val dup = engine.batch {
                insert("todo", "title" to "a", "done" to false, "updatedAt" to other)
                insert("todo", "title" to "b", "done" to false, "updatedAt" to other)
            }
            assertFalse("two ops sharing an HLC fail the batch", dup.isOk)
        } finally {
            engine.close()
        }
    }

    @Test
    fun backfillSkipsARowWhoseUpdatedAtIsNotAnHlc() = runBlocking {
        // The row's HLC becomes the event id, and a relay refuses a whole push
        // batch over one malformed id. A row written outside the engine must be
        // skipped by the new-relay backfill, not queued where it stalls every
        // later write.
        val fakeRelay = FakeRelay()
        RelayTransportFactory.create = { _, _, _ -> fakeRelay }
        val driver = JdbcSqliteDriver(":memory:")
        val engine = createSync(
            SyncEngineDeps(makeDriver = { driver }, secureStorage = InMemorySecureStorage()),
        )(schema, SyncEngineConfig(name = "backfill-guard", syncIntervalMs = 3_600_000))
        try {
            engine.ready()
            assertTrue(engine.insert("todo", "title" to "fine", "done" to false).isOk)
            driver.exec(
                "insert into \"todo\" (id, title, done, createdAt, updatedAt, isDeleted) values (?, ?, 0, ?, ?, 0)",
                listOf(SqliteValue.Text("bad"), SqliteValue.Text("legacy"), SqliteValue.Text("2020-01-01"), SqliteValue.Text("2020-01-01T00:00:00Z")),
            )
            engine.setTransports(listOf(Transport("http://relay.test")))
            awaitSynced(engine)
            assertEquals("only the canonical row is pushed", 1, fakeRelay.pushedEventIds.size)
            assertFalse(fakeRelay.pushedEventIds.contains("2020-01-01T00:00:00Z"))
        } finally {
            engine.close()
            RelayTransportFactory.reset()
        }
    }

    @Test
    fun anUnwritableRemoteRowIsRetainedNotDropped() = runBlocking {
        // Authenticated data this build cannot write is retained for a later
        // build, exactly as the TypeScript engine does; it used to be dropped.
        val recoveryKey = IdentityDeriver.createRecoveryKey()
        val identity = IdentityDeriver.derive(recoveryKey)
        val hlc = Hlc.make("remote-device", System.currentTimeMillis() - 1_000)
        // `title` is nonEmptyString on the todo table; an empty one fails projection.
        val unwritable = Envelope.encrypt(
            identity, hlc, "remote-device", "2026-01-01T00:00:00.000Z",
            SyncPayload(
                1, "todo", "upsert", "bad-title", hlc,
                mapOf(
                    "id" to JsonValue.Str("bad-title"), "title" to JsonValue.Str(""), "done" to sqliteFalse,
                    "createdAt" to JsonValue.Str("2026-01-01T00:00:00.000Z"),
                    "updatedAt" to JsonValue.Str(hlc), "isDeleted" to sqliteFalse,
                ),
            ),
        )
        val fakeRelay = FakeRelay { after ->
            if (after == "") RelayClient.PullResult(listOf(unwritable), "1") else RelayClient.PullResult(emptyList(), "1")
        }
        RelayTransportFactory.create = { _, _, _ -> fakeRelay }
        val driver = JdbcSqliteDriver(":memory:")
        val name = "retain-unwritable"
        val engine = createSync(
            SyncEngineDeps(
                makeDriver = { driver },
                secureStorage = InMemorySecureStorage(mapOf("$name:mnemonic" to recoveryKey)),
            ),
        )(schema, SyncEngineConfig(name = name, transports = listOf(Transport("http://relay.test")), syncIntervalMs = 3_600_000))
        try {
            engine.ready()
            awaitSynced(engine)
            assertTrue(
                "a value the column refuses is not written",
                driver.select("select 1 from \"todo\" where id = ?", listOf(SqliteValue.Text("bad-title"))).isEmpty(),
            )
            assertEquals(
                "the event stays retained for a build whose schema can write it", 1,
                driver.select("select 1 from \"${Store.DEFERRED}\" where event_id = ?", listOf(SqliteValue.Text(hlc))).size,
            )
            assertNotNull("the failure is surfaced, not silent", engine.lastError.value)
        } finally {
            engine.close()
            RelayTransportFactory.reset()
        }
    }

    @Test
    fun aPullPageFetchedForThePreviousOwnerIsDroppedAfterAnOwnerSwitch() = runBlocking {
        // restoreAppOwner wipes the database and swaps the identity while a pull is
        // still awaiting the relay. That page was sealed for the OLD owner; applying
        // it would leak that owner's rows into the new owner's database and record
        // a cursor the new owner's first real pull would then skip below.
        val gate = CompletableDeferred<Unit>()
        val pullStarted = CompletableDeferred<Unit>()
        var served: List<SyncEnvelope> = emptyList()
        var pulls = 0
        val relay = object : RelayTransport {
            override suspend fun push(events: List<SyncEnvelope>) = RelayClient.PushResult(events.size, 0)
            override suspend fun pull(after: String): RelayClient.PullResult {
                pulls += 1
                if (pulls > 1) return RelayClient.PullResult(emptyList(), after)
                pullStarted.complete(Unit)
                gate.await()
                return RelayClient.PullResult(served, "7")
            }
            override suspend fun status() = RelayClient.StatusResponse()
            override suspend fun health() = RelayClient.HealthResponse(ok = true)
        }
        RelayTransportFactory.create = { _, _, _ -> relay }
        val driver = JdbcSqliteDriver(":memory:")
        val engine = createSync(
            SyncEngineDeps(makeDriver = { driver }, secureStorage = InMemorySecureStorage()),
        )(schema, SyncEngineConfig(name = "owner-switch", transports = listOf(Transport("http://relay.test")), syncIntervalMs = 3_600_000))
        try {
            engine.ready()
            // Boot's own sync may already be in flight; either way, the first pull
            // is the one we hold.
            pullStarted.await()
            val previous = IdentityDeriver.derive(engine.currentOwner!!.recoveryKey)
            served = listOf(noteEnvelope(previous, "leak", "previous owner", Hlc.make("peer", System.currentTimeMillis() - 1_000)))

            engine.restoreAppOwner(IdentityDeriver.createRecoveryKey(), force = true)
            gate.complete(Unit)
            engine.sync()
            awaitSynced(engine)

            assertTrue("the previous owner's row is not applied", driver.select("select id from \"note\"").isEmpty())
            assertTrue("the previous owner's cursor is not recorded", metaValue(driver, "cursor:http://relay.test") != "7")
        } finally {
            engine.close()
            RelayTransportFactory.reset()
        }
    }

    @Test
    fun aFaultOutsideThePerRelayGuardDoesNotWedgeTheSyncLoop() = runBlocking {
        // A store exception escaping runSync used to complete the loop's job while
        // `syncJob` still pointed at it: every later sync() joined the dead job at
        // once and the engine never synced again until restart.
        val inner = JdbcSqliteDriver(":memory:")
        var explode = false
        val driver = object : SqliteDriver {
            override fun exec(sql: String, params: List<SqliteValue>) = inner.exec(sql, params)
            override fun select(sql: String, params: List<SqliteValue>): List<Map<String, SqliteValue>> {
                if (explode && sql.contains(Store.DEFERRED)) throw SqliteException("disk on fire")
                return inner.select(sql, params)
            }
            override fun <T> transaction(body: () -> T): T = inner.transaction(body)
            override fun close() = inner.close()
        }
        val fakeRelay = FakeRelay()
        RelayTransportFactory.create = { _, _, _ -> fakeRelay }
        val engine = createSync(
            SyncEngineDeps(makeDriver = { driver }, secureStorage = InMemorySecureStorage()),
        )(schema, SyncEngineConfig(name = "fault", transports = listOf(Transport("http://relay.test")), syncIntervalMs = 3_600_000))
        try {
            engine.ready()
            awaitSynced(engine)
            val before = fakeRelay.pullCalls
            explode = true
            engine.sync()
            assertTrue("the fault is reported", engine.syncState.value is SyncState.NotSynced)
            explode = false
            engine.sync()
            assertTrue("the loop recovers and talks to the relay again", fakeRelay.pullCalls > before)
            assertTrue(engine.syncState.value is SyncState.Synced)
        } finally {
            engine.close()
            RelayTransportFactory.reset()
        }
    }
}
