package com.simplysync.kotlin

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Exercises `getRelayStatuses` — the per-relay status + storage-usage surface —
 * against stub relays (JDK HttpServer, no extra deps). Parity with the TS
 * engine's relay-status.test.ts behaviors: the /v1/status snapshot, the /health
 * fallback for empty accounts, per-relay failure visibility behind a green
 * SyncState, and health pruning on setTransports.
 */
class RelayStatusTest {
    private val schema = Schema(
        mapOf("note" to mapOf("id" to Column.id("note"), "body" to Column.nonEmptyString)),
    )

    /** A stub relay: routes (method, path) to (status code, JSON body). */
    private fun startStub(handler: (method: String, path: String) -> Pair<Int, String>): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            exchange.requestBody.readBytes() // drain
            val (code, body) = handler(exchange.requestMethod, exchange.requestURI.path)
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(code, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        return server
    }

    private fun baseUrl(server: HttpServer): String = "http://127.0.0.1:${server.address.port}"

    private fun engineWith(vararg bases: String): SyncEngine = createSync(
        SyncEngineDeps(makeDriver = { JdbcSqliteDriver(":memory:") }, secureStorage = InMemorySecureStorage()),
    )(schema, SyncEngineConfig(name = "relay-status-test", transports = bases.map { Transport(it) }))

    private val okPull = 200 to """{"events":[],"nextCursor":""}"""
    private val okPush = 200 to """{"accepted":0,"duplicate":0}"""

    @Test
    fun statusSnapshotPerRelayWithHealthFallbackForEmptyAccounts() = runBlocking {
        // relay A has an account (usage + quota); relay B has never seen this
        // owner (404 on status) but is alive (/health answers).
        val relayA = startStub { method, path ->
            when {
                path.startsWith("/v1/status") -> 200 to """
                    {"server":{"version":"1.0.0","serverTime":"2026-01-01T00:00:00Z"},
                     "account":{"quotaBytes":1073741824,"usedBytes":52428800,"usedPct":4.88,
                                "headSeq":42,"streams":7,"events":21}}
                """.trimIndent()
                method == "POST" -> okPush
                else -> okPull
            }
        }
        val relayB = startStub { method, path ->
            when {
                path.startsWith("/v1/status") -> 404 to "not found"
                path.startsWith("/health") -> 200 to """{"ok":true,"version":"0.9.0"}"""
                method == "POST" -> okPush
                else -> okPull
            }
        }
        val engine = engineWith(baseUrl(relayA), baseUrl(relayB))
        try {
            engine.ready()

            val statuses = engine.getRelayStatuses()
            assertEquals(2, statuses.size)

            val a = statuses.first { it.url == baseUrl(relayA) }
            assertTrue("relay with an account is reachable", a.reachable)
            assertEquals(52428800L, a.usedBytes)
            assertEquals(1073741824L, a.quotaBytes)
            assertEquals(4.88, a.usedPct!!, 0.001)
            assertEquals(42L, a.headSeq)
            assertEquals(7L, a.streams)
            assertEquals(21L, a.events)
            assertEquals("1.0.0", a.version)

            val b = statuses.first { it.url == baseUrl(relayB) }
            assertTrue("alive, just no account yet", b.reachable)
            assertNull("no account block without an account", b.usedBytes)
            assertNull(b.quotaBytes)
            assertEquals("version comes from /health", "0.9.0", b.version)
        } finally {
            engine.close()
            relayA.stop(0)
            relayB.stop(0)
        }
    }

    @Test
    fun failingRelayStaysVisiblePerRelayWhileAnotherKeepsSyncStateGreen() = runBlocking {
        val good = startStub { method, path ->
            when {
                path.startsWith("/v1/status") -> 200 to
                    """{"server":{"version":"1.0.0"},"account":{"quotaBytes":100,"usedBytes":1,"usedPct":1}}"""
                method == "POST" -> okPush
                else -> okPull
            }
        }
        val bad = startStub { _, _ -> 500 to "boom" }
        val engine = engineWith(baseUrl(good), baseUrl(bad))
        try {
            engine.ready()
            engine.sync()

            // One healthy relay is enough for the collapsed state…
            assertTrue("SyncState stays green", engine.getSyncState() is SyncState.Synced)

            // …but the per-relay surface still shows which relay is failing and why.
            val statuses = engine.getRelayStatuses()
            val g = statuses.first { it.url == baseUrl(good) }
            assertTrue(g.reachable)
            assertNotNull("healthy relay records lastSyncedAt", g.lastSyncedAt)
            assertNull("healthy relay has no failure", g.lastFailure)

            val b = statuses.first { it.url == baseUrl(bad) }
            assertFalse(b.reachable)
            assertEquals("serverError", b.lastFailure?.kind)
            assertNull("never synced with the bad relay", b.lastSyncedAt)
        } finally {
            engine.close()
            good.stop(0)
            bad.stop(0)
        }
    }

    @Test
    fun droppingRelayFromTransportsDropsItsLingeringHealthEntry() = runBlocking {
        val good = startStub { method, path ->
            when {
                path.startsWith("/v1/status") -> 404 to "not found"
                path.startsWith("/health") -> 200 to """{"ok":true,"version":"1.0.0"}"""
                method == "POST" -> okPush
                else -> okPull
            }
        }
        val bad = startStub { _, _ -> 500 to "boom" }
        val engine = engineWith(baseUrl(good), baseUrl(bad))
        try {
            engine.ready()
            engine.sync()

            engine.setTransports(listOf(Transport(baseUrl(good))))
            val statuses = engine.getRelayStatuses()
            assertEquals(1, statuses.size)
            assertEquals(baseUrl(good), statuses[0].url)
            assertNull("the dropped relay's failure doesn't linger", statuses[0].lastFailure)
        } finally {
            engine.close()
            good.stop(0)
            bad.stop(0)
        }
    }
}
