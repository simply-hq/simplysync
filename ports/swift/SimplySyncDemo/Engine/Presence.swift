import Foundation

// Ephemeral presence (parity with the TS/Kotlin engines): who's online, typing
// indicators, "the assistant is thinking". Real-time and worthless seconds later,
// so it is deliberately kept OUT of the durable sync log — never persisted, never
// in the outbox. Transport-agnostic: provide any pipe (a WebSocket you own; the
// in-memory hub for tests / same-process). State is a String — JSON-encode
// structured state if needed. Last-value-per-sender with lazy TTL expiry against
// an injectable clock (no internal timers).

/// A pluggable message pipe. `send` broadcasts to peers; `subscribe` receives.
protocol EphemeralTransport {
    func send(_ message: String)
    func subscribe(_ onMessage: @escaping (String) -> Void) -> () -> Void
}

private let presenceSep = "\u{01}"

/// A presence channel for one topic. Create with `createPresenceChannel`.
final class PresenceChannel {
    private let topic: String
    private let selfId: String
    private let ttlMs: Int64
    private let now: () -> Int64
    private let transport: EphemeralTransport
    private var entries: [String: (state: String, at: Int64)] = [:]
    private var listeners: [UUID: () -> Void] = [:]
    private var unsub: (() -> Void)?

    fileprivate init(topic: String, transport: EphemeralTransport, selfId: String,
                     ttlMs: Int64, now: @escaping () -> Int64) {
        self.topic = topic
        self.transport = transport
        self.selfId = selfId
        self.ttlMs = ttlMs
        self.now = now
        self.unsub = transport.subscribe { [weak self] raw in self?.receive(raw) }
    }

    private func receive(_ raw: String) {
        // `at` is OUR clock, so TTL is immune to a peer's clock skew. maxSplits keeps
        // any separators inside `state` intact (state is the last field).
        let parts = raw.split(separator: Character(presenceSep), maxSplits: 3,
                              omittingEmptySubsequences: false).map(String.init)
        guard parts.count >= 3, parts[0] == topic else { return }
        let sender = parts[1]
        if sender == selfId { return } // our own echo — already recorded
        if parts[2] == "1" { entries.removeValue(forKey: sender) }
        else { entries[sender] = (parts.count >= 4 ? parts[3] : "", now()) }
        notifyAll()
    }

    private func notifyAll() { for l in listeners.values { l() } }

    /// Broadcast (and locally record) this client's current state. Call periodically.
    func publish(_ state: String) {
        entries[selfId] = (state, now())
        transport.send([topic, selfId, "0", state].joined(separator: presenceSep))
        notifyAll()
    }

    /// Announce going away, dropping this client from peers' views.
    func clear() {
        entries.removeValue(forKey: selfId)
        transport.send([topic, selfId, "1", ""].joined(separator: presenceSep))
        notifyAll()
    }

    /// Live (non-expired) entries, including this client's own.
    func list() -> [(senderId: String, state: String)] {
        let cutoff = now() - ttlMs
        return entries.compactMap { kv in kv.value.at >= cutoff ? (kv.key, kv.value.state) : nil }
    }

    /// Subscribe to changes (a peer published / cleared). Returns an unsubscribe.
    @discardableResult
    func subscribe(_ listener: @escaping () -> Void) -> () -> Void {
        let id = UUID()
        listeners[id] = listener
        return { [weak self] in self?.listeners.removeValue(forKey: id) }
    }

    /// Detach from the transport and drop all listeners.
    func stop() {
        unsub?()
        unsub = nil
        listeners.removeAll()
        entries.removeAll()
    }
}

/// Create a presence channel for one `topic`. Multiple channels can share one
/// transport; each filters to its own topic. `now` is injectable for tests.
func createPresenceChannel(topic: String, transport: EphemeralTransport, selfId: String,
                           ttlMs: Int64 = 15_000,
                           now: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) })
    -> PresenceChannel {
    PresenceChannel(topic: topic, transport: transport, selfId: selfId, ttlMs: ttlMs, now: now)
}

/// An in-process transport hub: every `connect()` shares one bus, so a message sent
/// by one connection reaches all the others (and itself — the channel ignores its echo).
final class MemoryTransportHub {
    private var subscribers: [UUID: (String) -> Void] = [:]
    func connect() -> EphemeralTransport { HubTransport(hub: self) }
    fileprivate func broadcast(_ message: String) { for s in subscribers.values { s(message) } }
    fileprivate func add(_ cb: @escaping (String) -> Void) -> () -> Void {
        let id = UUID()
        subscribers[id] = cb
        return { [weak self] in self?.subscribers.removeValue(forKey: id) }
    }
}

private struct HubTransport: EphemeralTransport {
    let hub: MemoryTransportHub
    func send(_ message: String) { hub.broadcast(message) }
    func subscribe(_ onMessage: @escaping (String) -> Void) -> () -> Void { hub.add(onMessage) }
}
