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
