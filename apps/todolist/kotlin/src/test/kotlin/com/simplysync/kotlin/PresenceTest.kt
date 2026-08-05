package com.simplysync.kotlin

import org.junit.Assert.assertEquals
import org.junit.Test

class PresenceTest {
    @Test
    fun peersSeeEachOtherIgnoringOwnEcho() {
        val hub = MemoryTransportHub()
        val now = { 1000L }
        val a = createPresenceChannel("presence", hub.connect(), "A", now = now)
        val b = createPresenceChannel("presence", hub.connect(), "B", now = now)
        a.publish("alice")
        b.publish("bob")
        assertEquals(setOf("alice", "bob"), a.list().map { it.second }.toSet())
        assertEquals(setOf("alice", "bob"), b.list().map { it.second }.toSet())
        a.stop(); b.stop()
    }

    @Test
    fun entriesExpireAfterTtl() {
        val hub = MemoryTransportHub()
        var t = 1000L
        val now = { t }
        val a = createPresenceChannel("presence", hub.connect(), "A", ttlMs = 10_000, now = now)
        val b = createPresenceChannel("presence", hub.connect(), "B", ttlMs = 10_000, now = now)
        a.publish("alice")
        b.publish("bob")
        assertEquals(2, b.list().size)

        t += 11_000 // 11s later; alice never re-published, bob heartbeats
        b.publish("bob")
        assertEquals(listOf("bob"), b.list().map { it.second })
        a.stop(); b.stop()
    }

    @Test
    fun clearDropsImmediately() {
        val hub = MemoryTransportHub()
        val now = { 1000L }
        val a = createPresenceChannel("presence", hub.connect(), "A", now = now)
        val b = createPresenceChannel("presence", hub.connect(), "B", now = now)
        a.publish("alice")
        b.publish("bob")
        a.clear()
        assertEquals(listOf("bob"), b.list().map { it.second })
        a.stop(); b.stop()
    }

    @Test
    fun topicsAreIsolatedAndNotifySubscribers() {
        val hub = MemoryTransportHub()
        val now = { 1000L }
        val typing = createPresenceChannel("room:1:typing", hub.connect(), "A", now = now)
        val thinking = createPresenceChannel("thinking:m7", hub.connect(), "A", now = now)
        val peer = createPresenceChannel("room:1:typing", hub.connect(), "B", now = now)
        var typingNotifs = 0
        typing.subscribe { typingNotifs++ }
        var thinkingNotifs = 0
        thinking.subscribe { thinkingNotifs++ }

        peer.publish("1")
        assertEquals("typing channel heard B", 1, typingNotifs)
        assertEquals("different-topic channel did not", 0, thinkingNotifs)
        assertEquals(listOf("B"), typing.list().map { it.first })

        typing.stop(); thinking.stop(); peer.stop()
    }
}
