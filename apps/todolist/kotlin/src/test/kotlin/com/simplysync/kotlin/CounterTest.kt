package com.simplysync.kotlin

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Test

class CounterTest {
    private fun engine(): SyncEngine {
        val schema = Schema(
            mapOf(
                "counter" to counterColumns(),
                "message" to mapOf("id" to Column.id("message"), "body" to Column.string),
            ),
        )
        return createSync(
            SyncEngineDeps(makeDriver = { JdbcSqliteDriver(":memory:") }, secureStorage = InMemorySecureStorage()),
        )(schema, SyncEngineConfig(name = "counter"))
    }

    @Test
    fun conflictFreeCounterSumsAndNeverLosesUpdates() = runBlocking {
        val e = engine()
        e.ready()
        fun total(key: String): Double = e.loadQuery(counterTotalQuery(e, "counter", key)).first()

        assertEquals(0.0, total("m1:like"), 0.0)

        incrementCounter(e, "counter", "m1:like")
        incrementCounter(e, "counter", "m1:like")
        incrementCounter(e, "counter", "m1:like")
        decrementCounter(e, "counter", "m1:like") // someone un-liked
        assertEquals(2.0, total("m1:like"), 0.0)

        // 100 rapid increments all land — a single-int LWW column would collapse to 1.
        repeat(100) { incrementCounter(e, "counter", "burst") }
        assertEquals(100.0, total("burst"), 0.0)

        // Independent keys + arbitrary amounts (unread badge math).
        incrementCounter(e, "counter", "inbox:unread", 4.0)
        incrementCounter(e, "counter", "inbox:unread", 2.0)
        decrementCounter(e, "counter", "inbox:unread", 5.0)
        assertEquals(1.0, total("inbox:unread"), 0.0)
        assertEquals(2.0, total("m1:like"), 0.0) // unaffected

        e.close()
    }
}
