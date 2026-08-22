package com.simplysync.kotlin

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * Parity with the TS engine's relay-wipe-recovery.test.ts. Two failure modes
 * that used to be silent: a relay that lost its data restarts its event `seq`
 * counter, so a device holding a higher pull cursor asks for `seq > cursor`,
 * gets nothing, and reports "synced" forever; and `resetAppOwner` wiped local
 * data with no checks, which offline meant unrecoverable loss with no prompt.
 */
class RelayWipeRecoveryTest {
    private val schema = Schema(
        mapOf("note" to mapOf("id" to Column.id("note"), "body" to Column.nonEmptyString)),
    )

    private fun startStub(handler: (method: String, path: String, query: String?) -> Pair<Int, String>): HttpServer {
        val server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { exchange ->
            exchange.requestBody.readBytes()
            val (code, body) = handler(exchange.requestMethod, exchange.requestURI.path, exchange.requestURI.query)
            val bytes = body.toByteArray()
            exchange.responseHeaders.add("Content-Type", "application/json")
            exchange.sendResponseHeaders(code, bytes.size.toLong())
            exchange.responseBody.use { it.write(bytes) }
        }
        server.start()
        return server
    }

    private fun baseUrl(server: HttpServer): String = "http://127.0.0.1:${server.address.port}"

    private fun engineWith(name: String, vararg bases: String): SyncEngine = createSync(
        SyncEngineDeps(makeDriver = { JdbcSqliteDriver(":memory:") }, secureStorage = InMemorySecureStorage()),
    )(schema, SyncEngineConfig(name = name, transports = bases.map { Transport(it) }))

    private val okPush = 200 to """{"accepted":1,"duplicate":0}"""

    @Test
    fun pull404AfterAnAdvancedCursorResetsTheRelayAndReSeedsIt() = runBlocking {
        val pullCursors = CopyOnWriteArrayList<String>()
        val pushes = java.util.concurrent.atomic.AtomicInteger(0)
        val wiped = java.util.concurrent.atomic.AtomicBoolean(false)
        val relay = startStub { method, path, query ->
            when {
                method == "POST" -> { pushes.incrementAndGet(); okPush }
                path.startsWith("/v1/events") -> {
                    val after = query?.split("&")?.firstOrNull { it.startsWith("after=") }
                        ?.removePrefix("after=") ?: ""
                    pullCursors.add(after)
                    // A wiped relay has forgotten the owner row, so it 404s an
                    // account it previously served.
                    if (wiped.get()) 404 to """{"error":"Unknown owner"}"""
                    else 200 to """{"events":[],"nextCursor":"5"}"""
                }
                path.startsWith("/v1/status") ->
                    200 to """{"server":{"version":"1.0.0"},"account":{"events":1}}"""
                else -> 200 to """{"ok":true,"version":"1.0.0"}"""
            }
        }
        val engine = engineWith("kotlin-wipe-test", baseUrl(relay))
        try {
            engine.ready()
            engine.insert("note", "body" to "keep me")
            engine.sync()
            engine.sync()
            assertTrue("the relay's cursor was adopted", pullCursors.contains("5"))
            assertTrue(pushes.get() > 0)

            wiped.set(true)
            engine.sync()
            assertTrue(
                "a 404 on an already-pulled owner is data loss, not an empty account",
                engine.getRelayStatuses().first().reseeding,
            )

            // Repaired: the cursor is back to zero (not the stale "5" the relay
            // can no longer match) and the row is re-uploaded even though it was
            // already acknowledged once.
            val before = pushes.get()
            pullCursors.clear()
            wiped.set(false)
            engine.sync()
            assertTrue("the row is re-uploaded", pushes.get() > before)
            assertEquals("", pullCursors.first())

            // A pass with nothing left to send means the copy is rebuilt.
            engine.sync()
            assertFalse(engine.getRelayStatuses().first().reseeding)
        } finally {
            engine.close()
            relay.stop(0)
        }
    }

    @Test
    fun resetRefusesUntilARelayIsConfirmedToHoldTheData() = runBlocking {
        // No relay configured: this data exists only here, so the unforced call
        // must refuse and point at a backup.
        val local = engineWith("kotlin-reset-local")
        try {
            local.ready()
            try {
                local.resetAppOwner()
                fail("expected a refusal on a relay-less device")
            } catch (e: IllegalStateException) {
                assertTrue(e.message!!.contains("Back up your data first"))
            }
            // Force is the app's "the user confirmed" escape hatch.
            local.resetAppOwner(force = true)
        } finally {
            local.close()
        }

        // Reachable relay that holds a copy: allowed.
        val relay = startStub { method, path, _ ->
            when {
                method == "POST" -> okPush
                path.startsWith("/v1/events") -> 200 to """{"events":[],"nextCursor":""}"""
                path.startsWith("/v1/status") ->
                    200 to """{"server":{"version":"1.0.0"},"account":{"events":7}}"""
                else -> 200 to """{"ok":true,"version":"1.0.0"}"""
            }
        }
        val confirmed = engineWith("kotlin-reset-confirmed", baseUrl(relay))
        try {
            confirmed.ready()
            val before = confirmed.appOwner()?.id
            confirmed.resetAppOwner()
            assertTrue("a new owner was adopted", confirmed.appOwner()?.id != before)
        } finally {
            confirmed.close()
            relay.stop(0)
        }
    }
}
