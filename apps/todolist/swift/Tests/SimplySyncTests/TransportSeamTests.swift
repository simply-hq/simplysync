import Foundation
import XCTest

@testable import SimplySync

// The engine moves envelopes through `SyncTransport`, not a hard-wired HTTP
// client: an in-memory transport stands in for a relay so two engines can
// round-trip without a network, and the per-transport cursor rules (nothing
// re-sent once acked, resend after a failed push) are checked exactly.
final class TransportSeamTests: XCTestCase {
    /// A relay in a box: one append-only log shared by every engine in a test,
    /// deduped by event id. Like a real relay, each owner sees only its own
    /// events (`view(for:)`), so a pull under the wrong owner is empty rather
    /// than a decrypt failure.
    final class InMemoryRelay {
        private let lock = NSLock()
        private var log: [SyncEnvelope] = []
        private var seen = Set<String>()
        var failPushes = false
        var pushFailure: Error = URLError(.networkConnectionLost)

        var count: Int { lock.withLock { log.count } }

        func push(_ events: [SyncEnvelope]) throws -> RelayClient.PushResult {
            try lock.withLock {
                if failPushes { throw pushFailure }
                var accepted = 0
                var duplicate = 0
                for event in events {
                    if seen.insert(event.eventId).inserted {
                        log.append(event)
                        accepted += 1
                    } else {
                        duplicate += 1
                    }
                }
                return RelayClient.PushResult(accepted: accepted, duplicate: duplicate)
            }
        }

        func pull(after cursor: String, ownerId: String) -> RelayClient.PullResult {
            lock.withLock {
                let mine = log.filter { $0.ownerId == ownerId }
                let start = min(Int(cursor) ?? 0, mine.count)
                return RelayClient.PullResult(events: Array(mine[start...]), nextCursor: String(mine.count))
            }
        }

        func view(for ownerId: String, id: String) -> OwnerView {
            OwnerView(relay: self, ownerId: ownerId, id: id)
        }

        struct OwnerView: SyncTransport {
            let relay: InMemoryRelay
            let ownerId: String
            let id: String
            func push(_ events: [SyncEnvelope]) async throws -> RelayClient.PushResult { try relay.push(events) }
            func pull(after cursor: String) async throws -> RelayClient.PullResult {
                relay.pull(after: cursor, ownerId: ownerId)
            }
        }
    }

    private let schema = Schema(["todo": ["id": .id("todo"), "title": .nonEmptyString]])
    private let base = "https://memory.test"
    private struct Row: Decodable { let title: String }

    private func makeEngine(_ name: String, relay: InMemoryRelay) async -> SyncEngine {
        let deps = SyncEngineDeps(
            makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
            secureStorage: InMemorySecureStorage())
        let engine = createSync(deps)(schema, SyncEngineConfig(name: name))
        await engine.ready
        let base = base
        engine.transportFactory = { configuredBase, identity in
            relay.view(for: identity.ownerId, id: configuredBase)
        }
        engine.setTransports([Transport(url: base)])
        await engine.sync() // drain the pass that setTransports kicked off
        return engine
    }

    private func titles(_ engine: SyncEngine) -> [String] {
        engine.loadQuery(
            engine.createQuery("select title from \"todo\" where \"isDeleted\" = 0", as: Row.self)
        ).map(\.title)
    }

    func testTwoEnginesRoundTripThroughAnInMemoryTransport() async throws {
        let relay = InMemoryRelay()
        let a = await makeEngine("seam-a", relay: relay)
        let b = await makeEngine("seam-b", relay: relay)
        defer {
            a.setTransports([])
            b.setTransports([])
        }

        _ = a.insert("todo", ["title": .string("buy milk")])
        await a.sync()
        XCTAssertEqual(relay.count, 1, "A's write reached the transport through the seam")

        let key = try XCTUnwrap(a.currentOwner?.recoveryKey)
        try await b.restoreAppOwner(key) // the backup check goes through the seam too (no force)
        await b.sync()
        XCTAssertEqual(titles(b), ["buy milk"])

        await a.sync()
        await b.sync()
        XCTAssertEqual(relay.count, 1, "cursors hold: nothing re-sent, nothing echoed back")
    }

    func testOneHealthyReplicaDoesNotBlockLocalWritesWhenAnotherFails() async throws {
        let good = InMemoryRelay(), bad = InMemoryRelay()
        bad.failPushes = true
        let engine = await makeEngine("seam-one-healthy", relay: good)
        defer { engine.setTransports([]) }
        engine.transportFactory = { base, identity in
            (base.contains("unavailable") ? bad : good).view(for: identity.ownerId, id: base)
        }
        engine.setTransports([Transport(url: base), Transport(url: "https://unavailable.test")])
        _ = engine.insert("todo", ["title": .string("first")])
        await engine.sync()
        guard case .synced = engine.getSyncState() else { return XCTFail("One healthy replica is sufficient") }
        _ = engine.insert("todo", ["title": .string("still editable")])
        await engine.sync()
        XCTAssertEqual(Set(titles(engine)), Set(["first", "still editable"]))
        XCTAssertEqual(good.count, 2)
        XCTAssertEqual(bad.count, 0, "The failed replica remains independently unsynced")
    }

    func testFailedPushKeepsTheCursorSoTheNextSyncResends() async throws {
        let relay = InMemoryRelay()
        let a = await makeEngine("seam-retry", relay: relay)
        defer { a.setTransports([]) }

        relay.failPushes = true
        _ = a.insert("todo", ["title": .string("retry me")])
        await a.sync()
        XCTAssertEqual(relay.count, 0, "a failed push stores nothing")

        relay.failPushes = false
        await a.sync()
        XCTAssertEqual(relay.count, 1, "the push cursor did not advance past the failure")
        XCTAssertEqual(titles(a), ["retry me"])
    }

    /// A transport with no HTTP status (iCloud) reports a `SyncTransportFailure`;
    /// its kind drives the same terminal back-off a relay's 413 would.
    func testATransportFailureKindReachesTheSyncState() async throws {
        let relay = InMemoryRelay()
        let a = await makeEngine("seam-kind", relay: relay)
        defer { a.setTransports([]) }

        relay.failPushes = true
        relay.pushFailure = SyncTransportFailure(kind: "quotaExceeded", message: "iCloud storage is full.")
        _ = a.insert("todo", ["title": .string("too big")])
        await a.sync()
        XCTAssertEqual(a.getSyncState(),
                       .notSynced(error: "iCloud storage is full.", terminal: true, status: nil))
        let statuses = await a.getRelayStatuses()
        let status = try XCTUnwrap(statuses.first)
        XCTAssertEqual(status.lastFailure?.kind, "quotaExceeded")
    }

    /// An app-supplied transport has no `/v1/status`: its status comes from the
    /// last sync pass instead of an HTTP probe that could only fail.
    func testAnAppSuppliedTransportIsNotProbedOverHTTP() async throws {
        let relay = InMemoryRelay()
        let a = await makeEngine("seam-status", relay: relay)
        defer { a.setTransports([]) }

        _ = a.insert("todo", ["title": .string("hello")])
        await a.sync()
        let statuses = await a.getRelayStatuses()
        let status = try XCTUnwrap(statuses.first)
        XCTAssertEqual(status.url, base)
        XCTAssertTrue(status.reachable)
        XCTAssertNil(status.lastFailure)
        XCTAssertNil(status.version, "no HTTP status call was made")
    }
}
