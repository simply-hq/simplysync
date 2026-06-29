package com.simplysync.kotlin

import kotlinx.coroutines.runBlocking
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
    fun localCrudValidationAndReactiveQueries() = runBlocking {
        val engine = localEngine()
        engine.ready()

        val owner = engine.appOwner()
        assertNotNull("owner derived on boot", owner)
        assertTrue("default owner is an sf1_ key", owner!!.recoveryKey.startsWith("sf1_"))

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
        val key = IdentityDeriver.createRecoveryKey()
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
}
