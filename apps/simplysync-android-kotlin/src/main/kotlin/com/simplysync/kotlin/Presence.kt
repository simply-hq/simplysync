package com.simplysync.kotlin

// Ephemeral presence (parity with the TS engine's presence.ts): who's online,
// typing indicators, "the assistant is thinking". This is real-time and worthless
// seconds later, so it is deliberately kept OUT of the durable sync log — never
// persisted, never in the outbox. Transport-agnostic: provide any pipe (a
// WebSocket you own; the in-memory hub for tests / same-process). State is a
// String — JSON-encode structured state if you need it.
//
// Model: last-value-per-sender with lazy TTL expiry. Each client re-publishes
// ("heartbeat", ~every ttlMs/2) while present; a client that goes away stops
// publishing and simply expires from everyone's view after ttlMs. Expiry is lazy
// (evaluated on read against an injectable clock), so there are no internal timers.

/** A pluggable message pipe. `send` broadcasts to peers; `subscribe` receives. */
interface EphemeralTransport {
    fun send(message: String)
    fun subscribe(onMessage: (String) -> Unit): () -> Unit
}

/** A presence channel for one topic. */
interface PresenceChannel {
    /** Broadcast (and locally record) this client's current state. Call periodically. */
    fun publish(state: String)
    /** Announce going away, dropping this client from peers' views. */
    fun clear()
    /** Live (non-expired) entries as (senderId, state), including this client's own. */
    fun list(): List<Pair<String, String>>
    /** Subscribe to changes (a peer published / cleared). Returns an unsubscribe. */
    fun subscribe(listener: () -> Unit): () -> Unit
    /** Detach from the transport and drop all listeners. */
    fun stop()
}

private const val PRESENCE_SEP = ""

/**
 * Create a presence channel for one [topic] (e.g. "room:42:typing",
 * "thinking:msg_7"). Multiple channels can share one transport; each filters to
 * its own topic. [now] is injectable for tests; defaults to the system clock.
 */
fun createPresenceChannel(
    topic: String,
    transport: EphemeralTransport,
    selfId: String,
    ttlMs: Long = 15_000,
    now: () -> Long = { System.currentTimeMillis() },
): PresenceChannel {
    // senderId -> (state, receivedAt). `receivedAt` is OUR clock, so TTL is immune
    // to a peer's clock skew.
    val entries = HashMap<String, Pair<String, Long>>()
    val listeners = LinkedHashSet<() -> Unit>()
    fun notifyAll() { for (l in listeners.toList()) l() }

    val unsubscribe = transport.subscribe { raw ->
        val parts = raw.split(PRESENCE_SEP, limit = 4)
        if (parts.size < 3 || parts[0] != topic) return@subscribe
        val sender = parts[1]
        if (sender == selfId) return@subscribe // our own echo — already recorded
        if (parts[2] == "1") entries.remove(sender)
        else entries[sender] = parts.getOrElse(3) { "" } to now()
        notifyAll()
    }

    return object : PresenceChannel {
        override fun publish(state: String) {
            entries[selfId] = state to now()
            transport.send(listOf(topic, selfId, "0", state).joinToString(PRESENCE_SEP))
            notifyAll()
        }
        override fun clear() {
            entries.remove(selfId)
            transport.send(listOf(topic, selfId, "1", "").joinToString(PRESENCE_SEP))
            notifyAll()
        }
        override fun list(): List<Pair<String, String>> {
            val cutoff = now() - ttlMs
            return entries.entries.filter { it.value.second >= cutoff }.map { it.key to it.value.first }
        }
        override fun subscribe(listener: () -> Unit): () -> Unit {
            listeners.add(listener)
            return { listeners.remove(listener) }
        }
        override fun stop() {
            unsubscribe()
            listeners.clear()
            entries.clear()
        }
    }
}

/**
 * An in-process transport hub: every `connect()` shares one bus, so a message sent
 * by one connection reaches all the others (and itself — the channel ignores its
 * own echo). Useful for tests and for multiple windows of the same process.
 */
class MemoryTransportHub {
    private val subscribers = LinkedHashSet<(String) -> Unit>()
    fun connect(): EphemeralTransport = object : EphemeralTransport {
        override fun send(message: String) { for (s in subscribers.toList()) s(message) }
        override fun subscribe(onMessage: (String) -> Unit): () -> Unit {
            subscribers.add(onMessage)
            return { subscribers.remove(onMessage) }
        }
    }
}
