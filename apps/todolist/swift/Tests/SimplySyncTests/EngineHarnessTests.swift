import Foundation
import XCTest

@testable import SimplySync

// Engine behaviours the cross-platform e2e scenarios don't reach: additive
// migration, deferred replay across schema/table upgrades, outbox cursor and
// pruning rules, tombstone purge guards, and the ordering/counter/presence
// helpers. The live two-device round-trip lives in apps/todolist/e2e.
final class EngineHarnessTests: XCTestCase {
    private let todoOnly = Schema(["todo": ["id": .id("todo"), "title": .nonEmptyString]])

    private func makeStore(_ name: String, schema: Schema? = nil) throws -> (Store, SQLite3Driver) {
        let driver = try SQLite3Driver(path: ":memory:")
        let store = Store(schema: schema ?? todoOnly, config: SyncEngineConfig(name: name))
        store.driver = driver
        try store.ensureSchema()
        return (store, driver)
    }

    // Additive schema migration: a table gains columns across app versions. Two
    // stores over ONE database, mirroring an app that evolves its schema.
    func testAdditiveSchemaMigrationPreservesRowsAndIsIdempotent() throws {
        let driver = try SQLite3Driver(path: ":memory:")
        let s1 = Store(schema: todoOnly, config: SyncEngineConfig(name: "migrate"))
        s1.driver = driver
        try s1.ensureSchema()
        try driver.exec(
            "insert into \"todo\" (id, title, createdAt, updatedAt, isDeleted) values (?, ?, ?, ?, 0)",
            [.text("t1"), .text("buy milk"), .text("2026-01-01"), .text("aaa")])

        let v2 = Schema(["todo": [
            "id": .id("todo"), "title": .nonEmptyString,
            "priority": .finiteNumber, "dueDate": .string,
        ]])
        let s2 = Store(schema: v2, config: SyncEngineConfig(name: "migrate"))
        s2.driver = driver
        try s2.ensureSchema()

        let cols = Set(try driver.select("pragma table_info(\"todo\")").compactMap {
            (r: SQLiteRow) -> String? in
            if case .text(let n)? = r["name"] { return n } else { return nil }
        })
        XCTAssertTrue(cols.contains("priority"), "migration adds priority column")
        XCTAssertTrue(cols.contains("dueDate"), "migration adds dueDate column")

        let old = try driver.select(
            "select title, priority from \"todo\" where id = ?", [.text("t1")]).first
        guard case .text(let title)? = old?["title"] else {
            return XCTFail("pre-migration row readable")
        }
        XCTAssertEqual(title, "buy milk", "pre-migration row preserved")
        XCTAssertEqual(old?["priority"], .null, "new column is NULL on the old row")

        let s3 = Store(schema: v2, config: SyncEngineConfig(name: "migrate"))
        s3.driver = driver
        try s3.ensureSchema()
        XCTAssertEqual(
            try driver.select("pragma table_info(\"todo\")").count, cols.count,
            "ensureSchema is idempotent")
    }

    // Payload-schema compatibility: an older app must retain (not partially
    // apply) a newer payload, then replay it once an upgraded app declares
    // support.
    func testFuturePayloadSchemaVersionIsRetainedThenReplayed() async throws {
        let driver = try SQLite3Driver(path: ":memory:")
        let storage = InMemorySecureStorage()
        let v1Config = SyncEngineConfig(name: "payload-version", schemaVersion: 1)
        let staged = Store(schema: todoOnly, config: v1Config)
        staged.driver = driver
        try staged.ensureSchema()
        let remoteHlc = HLC.make(
            deviceId: "remote",
            millis: Int64(Date().timeIntervalSince1970 * 1000))
        let future = SyncPayload(
            schemaVersion: 2,
            table: "todo",
            op: "upsert",
            rowId: "future-row",
            hlc: remoteHlc,
            value: [
                "title": .string("understood by v2"),
                "createdAt": .string("2026-01-01T00:00:00.000Z"),
                "updatedAt": .string(remoteHlc),
                "isDeleted": .int(0),
            ])
        staged.deferRemoteEvent(
            eventId: remoteHlc,
            payloadJson: Envelope.encodePayload(future))

        let deps = SyncEngineDeps(makeDriver: { _ in driver }, secureStorage: storage)
        let old = createSync(deps)(todoOnly, v1Config)
        await old.ready
        XCTAssertTrue(
            try driver.select(
                "select 1 from \"todo\" where id = ?", [.text("future-row")]).isEmpty,
            "v1 does not apply a v2 payload")
        XCTAssertEqual(
            try driver.select(
                "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
                [.text(remoteHlc)]).count, 1,
            "v1 retains the future payload")

        let upgraded = createSync(deps)(
            todoOnly, SyncEngineConfig(name: "payload-version", schemaVersion: 2))
        await upgraded.ready
        XCTAssertEqual(
            try driver.select(
                "select title from \"todo\" where id = ?", [.text("future-row")]).count, 1,
            "v2 replays the retained payload")
        XCTAssertTrue(
            try driver.select(
                "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
                [.text(remoteHlc)]).isEmpty,
            "replayed payload leaves the deferred queue")

        XCTAssertTrue(upgraded.insert("todo", ["title": "written by v2"]).isOk)
        guard
            let owner = await upgraded.appOwner,
            let row = try driver.select(
                "select envelope_json from \"\(Store.outboxTable)\" order by event_id desc limit 1"
            ).first,
            case .text(let envelopeJson)? = row["envelope_json"],
            let envelopeData = envelopeJson.data(using: .utf8)
        else { return XCTFail("v2 outbox envelope is readable") }
        let envelope = try JSONDecoder().decode(SyncEnvelope.self, from: envelopeData)
        let localPayload = try Envelope.decrypt(
            identity: IdentityDeriver.derive(from: owner.recoveryKey),
            envelope: envelope)
        XCTAssertEqual(localPayload.schemaVersion, 2, "local events carry the configured version")
    }

    // Additive table compatibility: an older schema keeps a valid payload for a
    // table it does not know, then an upgraded schema replays it.
    func testUnknownTablePayloadIsRetainedThenReplayed() async throws {
        let driver = try SQLite3Driver(path: ":memory:")
        let storage = InMemorySecureStorage()
        let upgradedSchema = Schema([
            "todo": ["id": .id("todo"), "title": .nonEmptyString],
            "task": ["id": .id("task"), "title": .nonEmptyString],
        ])
        let eventId = HLC.make(
            deviceId: "remote",
            millis: Int64(Date().timeIntervalSince1970 * 1000))
        let payload = SyncPayload(
            schemaVersion: 1,
            table: "task",
            op: "upsert",
            rowId: "task-1",
            hlc: eventId,
            value: [
                "title": .string("arrived before the table"),
                "createdAt": .string("2026-01-01T00:00:00.000Z"),
                "updatedAt": .string(eventId),
                "isDeleted": .int(0),
            ])
        let staged = Store(schema: todoOnly, config: SyncEngineConfig(name: "unknown-table"))
        staged.driver = driver
        try staged.ensureSchema()
        staged.deferRemoteEvent(eventId: eventId, payloadJson: Envelope.encodePayload(payload))

        let deps = SyncEngineDeps(makeDriver: { _ in driver }, secureStorage: storage)
        let old = createSync(deps)(todoOnly, SyncEngineConfig(name: "unknown-table"))
        await old.ready
        XCTAssertEqual(
            try driver.select(
                "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
                [.text(eventId)]).count, 1,
            "old schema retains an unknown-table payload")

        let upgraded = createSync(deps)(
            upgradedSchema, SyncEngineConfig(name: "unknown-table"))
        await upgraded.ready
        XCTAssertEqual(
            try driver.select(
                "select title from \"task\" where id = ?", [.text("task-1")]).count, 1,
            "upgraded schema replays the unknown-table payload")
        XCTAssertTrue(
            try driver.select(
                "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
                [.text(eventId)]).isEmpty,
            "unknown-table replay drains deferred storage")
    }

    // Multi-relay push: events are selected by a per-relay high-water mark
    // (event_id > cursor) so every relay independently receives every event —
    // including events already pushed to another relay (the old
    // `pushed_at is null` filter wrongly skipped those).
    func testPushSelectsByPerRelayCursorNotPushedAt() throws {
        let (_, driver) = try makeStore("cursor")
        for eid in ["e1", "e2", "e3"] {
            try driver.exec(
                "insert into \"\(Store.outboxTable)\" (event_id, envelope_json) values (?, ?)",
                [.text(eid), .text("{}")])
        }
        func after(_ cursor: String) throws -> [String] {
            try driver.select(
                "select event_id from \"\(Store.outboxTable)\" where event_id > ? order by event_id asc",
                [.text(cursor)]
            ).compactMap { if case .text(let e)? = $0["event_id"] { return e } else { return nil } }
        }
        XCTAssertEqual(try after(""), ["e1", "e2", "e3"], "empty cursor selects all (a fresh relay)")
        XCTAssertEqual(try after("e1"), ["e2", "e3"], "cursor advances past acked events")
        XCTAssertTrue(try after("e3").isEmpty, "fully caught up selects none")
        try driver.exec(
            "update \"\(Store.outboxTable)\" set pushed_at = ? where event_id = ?",
            [.text("2026-01-01"), .text("e1")])
        XCTAssertEqual(
            try after(""), ["e1", "e2", "e3"],
            "a fresh relay still gets events pushed elsewhere")
    }

    // Outbox pruning: the send queue drops events delivered to every current relay.
    func testOutboxPrunesOnlyEventsDeliveredToEveryRelay() throws {
        let (store, driver) = try makeStore("prune")
        for eid in ["e1", "e2", "e3", "e4"] {
            try driver.exec(
                "insert into \"\(Store.outboxTable)\" (event_id, envelope_json, pushed_at) values (?, '{}', ?)",
                [.text(eid), .text("2026-01-01")])
        }
        func outboxCount() throws -> Int {
            if case .integer(let n)? = try driver.select(
                "select count(*) as c from \"\(Store.outboxTable)\"").first?["c"] { return Int(n) }
            return -1
        }
        // a acked through e3, b only through e2 -> min is e2 -> prune e1, e2.
        store.setMeta("push:http://a", "e3")
        store.setMeta("push:http://b", "e2")
        XCTAssertEqual(
            store.pruneOutbox(["http://a", "http://b"]), 2,
            "prunes events delivered to every relay")
        XCTAssertEqual(try outboxCount(), 2, "undelivered events (e3, e4) remain")
        XCTAssertEqual(
            store.pruneOutbox(["http://a", "http://b", "http://c"]), 0,
            "uncursored relay -> prune nothing")
        XCTAssertEqual(store.pruneOutbox([]), 0, "no relays -> prune nothing")
    }

    // Atomic batch + deleteMany: all-or-nothing against pre-batch state.
    func testBatchIsAtomicAndDeleteManyClears() async throws {
        let schema = Schema([
            "todo": ["id": .id("todo"), "title": .nonEmptyString, "done": .sqliteBoolean],
        ])
        let deps = SyncEngineDeps(
            makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
            secureStorage: InMemorySecureStorage())
        let engine = createSync(deps)(schema, SyncEngineConfig(name: "batch"))
        await engine.ready
        struct Row: Decodable { let id: String; let title: String }
        let query = engine.createQuery(
            "select id, title from \"todo\" where \"isDeleted\" = 0 order by \"updatedAt\" desc",
            as: Row.self)

        let seed = engine.batch { b in
            b.insert("todo", ["title": "a", "done": false])
            b.insert("todo", ["title": "b", "done": false])
            b.insert("todo", ["title": "c", "done": false])
        }
        XCTAssertTrue(seed.isOk && seed.ids.count == 3, "batch seeds three rows")
        XCTAssertEqual(engine.loadQuery(query).count, 3)

        let before = engine.loadQuery(query).count
        let bad = engine.batch { b in
            b.insert("todo", ["title": "ok", "done": false])
            b.insert("todo", ["title": "", "done": false]) // rejected
        }
        XCTAssertFalse(bad.isOk, "invalid op fails the batch")
        XCTAssertEqual(engine.loadQuery(query).count, before, "nothing written on a failed batch")

        let firstId = engine.loadQuery(query).first!.id
        let mixed = engine.batch { b in
            b.insert("todo", ["title": "new", "done": false])
            b.delete("todo", id: firstId)
        }
        XCTAssertTrue(mixed.isOk, "mixed write+delete batch ok")
        XCTAssertTrue(engine.loadQuery(query).contains { $0.title == "new" })
        XCTAssertFalse(engine.loadQuery(query).contains { $0.id == firstId })

        let ids = engine.loadQuery(query).map { $0.id }
        XCTAssertTrue(engine.deleteMany("todo", ids: ids).isOk, "deleteMany ok")
        XCTAssertTrue(engine.loadQuery(query).isEmpty, "deleteMany cleared all")
    }

    // Tombstone GC: reclaim old soft-deleted rows, with the safety guards.
    func testPurgeGuardsUnpushedTombstonesAndRelayHistory() async throws {
        let (store, driver) = try makeStore("purge")
        let oldHlc = HLC.make(deviceId: "devA", millis: 1000)
        try store.writeRow("todo", [
            "id": .string("t1"), "title": .string("x"),
            "createdAt": .string("2020-01-01"), "updatedAt": .string(oldHlc),
            "isDeleted": sqliteTrue,
        ])
        try driver.exec(
            "insert into \"\(Store.outboxTable)\" (event_id, envelope_json, pushed_at) values (?, '{}', NULL)",
            [.text(oldHlc)])
        func count() throws -> Int {
            if case .integer(let n)? = try driver.select(
                "select count(*) as c from \"todo\"").first?["c"] { return Int(n) }
            return -1
        }
        XCTAssertEqual(
            store.purgeDeleted(olderThanMs: 1_000_000_000_000, nowMs: 5000, requirePushed: false), 0,
            "a huge window keeps recent tombstones")
        XCTAssertEqual(
            store.purgeDeleted(olderThanMs: 0, nowMs: 5000, requirePushed: true), 0,
            "unpushed delete kept while relays configured")
        XCTAssertEqual(try count(), 1, "tombstone still present")
        try driver.exec(
            "update \"\(Store.outboxTable)\" set pushed_at = ? where event_id = ?",
            [.text("2020-01-01"), .text(oldHlc)])
        XCTAssertEqual(
            store.purgeDeleted(olderThanMs: 0, nowMs: 5000, requirePushed: true), 1,
            "pushed tombstone reclaimed")
        XCTAssertEqual(try count(), 0, "row purged")

        // No relays -> purge by age regardless of outbox state.
        let (store2, _) = try makeStore("purge2")
        try store2.writeRow("todo", [
            "id": .string("t2"), "title": .string("y"),
            "createdAt": .string("2020-01-01"),
            "updatedAt": .string(HLC.make(deviceId: "devA", millis: 1000)),
            "isDeleted": sqliteTrue,
        ])
        XCTAssertEqual(
            store2.purgeDeleted(olderThanMs: 0, nowMs: 5000, requirePushed: false), 1,
            "no relays -> purge by age")

        // Detaching transports does not make a previously synced database safe
        // to compact: durable cursor history keeps the public purge disabled.
        let (store3, driver3) = try makeStore("purge-history")
        try store3.writeRow("todo", [
            "id": .string("t3"), "title": .string("z"),
            "createdAt": .string("2020-01-01"),
            "updatedAt": .string(HLC.make(deviceId: "devA", millis: 1000)),
            "isDeleted": sqliteTrue,
        ])
        store3.setMeta("cursor:http://relay.test", "1")
        let historyEngine = createSync(
            SyncEngineDeps(makeDriver: { _ in driver3 }, secureStorage: InMemorySecureStorage())
        )(todoOnly, SyncEngineConfig(name: "purge-history"))
        await historyEngine.ready
        XCTAssertEqual(
            historyEngine.purgeDeleted(olderThanMs: 0), 0,
            "relay history keeps tombstone purge disabled after detach")
        XCTAssertEqual(
            try driver3.select("select 1 from \"todo\" where id = ?", [.text("t3")]).count, 1,
            "relay-history tombstone remains")
    }

    // Fractional indexing: reorderable-list ordering keys.
    func testFractionalIndexKeysStayOrderedAndUnique() throws {
        struct SeededRNG: RandomNumberGenerator {
            var state: UInt64
            init(_ seed: UInt64) { state = seed }
            mutating func next() -> UInt64 {
                state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
                return state
            }
        }
        let first = try keyBetween(nil, nil)
        XCTAssertTrue(isOrderKey(first), "first key is valid")

        var prev = first
        for _ in 0..<100 {
            let next = try keyBetween(prev, nil)
            XCTAssertGreaterThan(next, prev, "append always grows")
            prev = next
        }

        let a = try keyBetween(nil, nil)
        let c = try keyBetween(a, nil)
        var lo = a
        for _ in 0..<100 {
            let b = try keyBetween(lo, c)
            XCTAssertTrue(lo < b && b < c, "insert-between stays strictly between")
            lo = b
        }

        XCTAssertThrowsError(try keyBetween(c, a), "out-of-order bounds throw")

        let ks = try keysBetween(nil, nil, 8)
        XCTAssertEqual(ks.count, 8)
        for i in 1..<ks.count {
            XCTAssertLessThan(ks[i - 1], ks[i], "keysBetween returns sorted keys")
        }

        var rng = SeededRNG(12345)
        var list: [String] = []
        for _ in 0..<1000 {
            let slot = Int.random(in: 0...list.count, using: &rng)
            let la = slot == 0 ? nil : list[slot - 1]
            let lb = slot == list.count ? nil : list[slot]
            list.insert(try keyBetween(la, lb), at: slot)
        }
        for i in 1..<list.count {
            XCTAssertLessThan(list[i - 1], list[i], "fuzz: 1000 random inserts strictly increasing")
        }
        XCTAssertEqual(Set(list).count, list.count, "fuzz: no duplicate keys")
    }

    // Conflict-free counters: reaction/unread tallies that never lose increments.
    func testCountersSumIncrementsPerKey() async throws {
        let deps = SyncEngineDeps(
            makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
            secureStorage: InMemorySecureStorage())
        let schema = Schema(["counter": counterColumns(), "msg": ["id": .id("msg"), "body": .string]])
        let engine = createSync(deps)(schema, SyncEngineConfig(name: "counter"))
        await engine.ready
        func total(_ key: String) -> Double {
            engine.loadQuery(counterTotalQuery(engine, "counter", key)).first?.total ?? -1
        }

        XCTAssertEqual(total("m1:like"), 0, "empty counter reads 0")
        _ = incrementCounter(engine, "counter", "m1:like")
        _ = incrementCounter(engine, "counter", "m1:like")
        _ = incrementCounter(engine, "counter", "m1:like")
        _ = decrementCounter(engine, "counter", "m1:like")
        XCTAssertEqual(total("m1:like"), 2, "increments/decrements sum to 2")

        for _ in 0..<100 { _ = incrementCounter(engine, "counter", "burst") }
        XCTAssertEqual(total("burst"), 100, "100 rapid increments all land")

        _ = incrementCounter(engine, "counter", "inbox:unread", amount: 4)
        _ = decrementCounter(engine, "counter", "inbox:unread", amount: 1)
        XCTAssertEqual(total("inbox:unread"), 3, "arbitrary amounts")
        XCTAssertEqual(total("m1:like"), 2, "independent keys unaffected")
    }

    // Ephemeral presence: typing / online / "AI thinking" — never persisted.
    func testPresenceChannelsExpireClearAndIsolateTopics() {
        let hub = MemoryTransportHub()
        let a = createPresenceChannel(topic: "presence", transport: hub.connect(), selfId: "A", now: { 1000 })
        let b = createPresenceChannel(topic: "presence", transport: hub.connect(), selfId: "B", now: { 1000 })
        a.publish("alice")
        b.publish("bob")
        XCTAssertEqual(
            Set(a.list().map { $0.state }), Set(["alice", "bob"]),
            "peers see each other (own echo ignored)")

        var t: Int64 = 1000
        let hub2 = MemoryTransportHub()
        let a2 = createPresenceChannel(topic: "p", transport: hub2.connect(), selfId: "A", ttlMs: 10_000, now: { t })
        let b2 = createPresenceChannel(topic: "p", transport: hub2.connect(), selfId: "B", ttlMs: 10_000, now: { t })
        a2.publish("alice")
        b2.publish("bob")
        XCTAssertEqual(b2.list().count, 2, "both present")
        t += 11_000
        b2.publish("bob") // bob heartbeats; alice didn't
        XCTAssertEqual(b2.list().map { $0.state }, ["bob"], "alice expired after TTL")

        let hub3 = MemoryTransportHub()
        let a3 = createPresenceChannel(topic: "p", transport: hub3.connect(), selfId: "A", now: { 1000 })
        let b3 = createPresenceChannel(topic: "p", transport: hub3.connect(), selfId: "B", now: { 1000 })
        a3.publish("alice")
        b3.publish("bob")
        a3.clear()
        XCTAssertEqual(b3.list().map { $0.state }, ["bob"], "clear drops immediately")

        let hub4 = MemoryTransportHub()
        let typing = createPresenceChannel(topic: "room:1:typing", transport: hub4.connect(), selfId: "A", now: { 1000 })
        let thinking = createPresenceChannel(topic: "thinking:m7", transport: hub4.connect(), selfId: "A", now: { 1000 })
        let peer = createPresenceChannel(topic: "room:1:typing", transport: hub4.connect(), selfId: "B", now: { 1000 })
        var typingN = 0
        var thinkingN = 0
        _ = typing.subscribe { typingN += 1 }
        _ = thinking.subscribe { thinkingN += 1 }
        peer.publish("1")
        XCTAssertTrue(typingN == 1 && thinkingN == 0, "topics isolated; only matching channel notified")
        XCTAssertEqual(typing.list().map { $0.senderId }, ["B"], "typing channel sees B")

        for channel in [a, b, a2, b2, a3, b3, typing, thinking, peer] { channel.stop() }
    }

    // MARK: - Edge cases shared with the TypeScript engine (edge-cases.test.ts)

    // A relay removed from the set cannot acknowledge what is pruned while it is
    // away. Its push cursor must stop vouching for it, or re-adding it skips the
    // backfill and the relay silently lacks those events.
    func testPruneForgetsThePushCursorOfARelayNoLongerConfigured() throws {
        let (store, driver) = try makeStore("prune-forget")
        for eid in ["e1", "e2", "e3"] {
            try driver.exec(
                "insert into \"\(Store.outboxTable)\" (event_id, envelope_json, pushed_at) values (?, '{}', ?)",
                [.text(eid), .text("2026-01-01")])
        }
        store.setMeta("push:http://a", "e3")
        store.setMeta("push:http://b", "e2")
        store.setMeta("backfill:http://b", "1")
        store.setMeta("cursor:http://b", "9")

        XCTAssertEqual(store.pruneOutbox(["http://a"]), 3, "a alone acknowledged everything")
        XCTAssertNil(store.getMeta("push:http://b"), "b's push cursor no longer vouches for it")
        XCTAssertNil(store.getMeta("backfill:http://b"), "b will be re-seeded when re-added")
        XCTAssertEqual(store.getMeta("cursor:http://b"), "9", "b's pull cursor is untouched")
        XCTAssertEqual(store.getMeta("push:http://a"), "e3", "a configured relay keeps its cursor")

        // Nothing pruned -> nothing forgotten (a single relay toggled off is safe).
        store.setMeta("push:http://c", "zz")
        XCTAssertEqual(store.pruneOutbox(["http://a"]), 0)
        XCTAssertEqual(store.getMeta("push:http://c"), "zz")
    }

    // A caller-supplied updatedAt bypasses the clock, so it can sort at or below
    // the row's current version — peers would keep their copy under LWW while
    // this device regressed its own. Equal is refused too: the HLC-keyed outbox
    // would drop the event while its row committed.
    func testExplicitUpdatedAtMustBeNewerThanTheCurrentRow() async throws {
        let driver = try SQLite3Driver(path: ":memory:")
        let deps = SyncEngineDeps(makeDriver: { _ in driver }, secureStorage: InMemorySecureStorage())
        let engine = createSync(deps)(todoOnly, SyncEngineConfig(name: "explicit-hlc"))
        await engine.ready
        guard case .ok(let id) = engine.insert("todo", ["title": "current"]) else {
            return XCTFail("insert")
        }
        guard case .text(let current)? = try driver.select(
            "select updatedAt from \"todo\" where id = ?", [.text(id)]).first?["updatedAt"] else {
            return XCTFail("row readable")
        }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let older = HLC.make(deviceId: "import", millis: now - 60_000)
        XCTAssertFalse(
            engine.upsert("todo", ["id": .string(id), "title": "stale", "updatedAt": .string(older)]).isOk,
            "an older stamp is refused")
        XCTAssertFalse(
            engine.upsert("todo", ["id": .string(id), "title": "same", "updatedAt": .string(current)]).isOk,
            "an equal stamp is refused")
        XCTAssertFalse(
            engine.insert("todo", ["id": .string(id), "title": "stale insert", "updatedAt": .string(older)]).isOk,
            "insert overwrites too, so it gets the same guard")
        if case .text(let title)? = try driver.select(
            "select title from \"todo\" where id = ?", [.text(id)]).first?["title"] {
            XCTAssertEqual(title, "current", "the row is untouched")
        }
        XCTAssertTrue(
            engine.upsert("todo", ["id": .string(id), "title": "forward",
                                   "updatedAt": .string(HLC.make(deviceId: "import", millis: now + 1_000))]).isOk,
            "a newer stamp is accepted")

        let shared = HLC.make(deviceId: "import", millis: now - 500)
        XCTAssertTrue(engine.insert("todo", ["title": "first", "updatedAt": .string(shared)]).isOk)
        XCTAssertFalse(
            engine.insert("todo", ["title": "second", "updatedAt": .string(shared)]).isOk,
            "an HLC already queued may not be reused for another row")
        let other = HLC.make(deviceId: "import", millis: now - 400)
        let dup = engine.batch { b in
            b.insert("todo", ["title": "a", "updatedAt": .string(other)])
            b.insert("todo", ["title": "b", "updatedAt": .string(other)])
        }
        XCTAssertFalse(dup.isOk, "two ops sharing an HLC fail the batch")
    }

    // The row's HLC becomes the event id, and a relay refuses a whole push batch
    // over one malformed id. A row written outside the engine must be skipped
    // by the new-relay backfill, not queued where it stalls every later write.
    func testBackfillSkipsARowWhoseUpdatedAtIsNotAnHlc() async throws {
        let driver = try SQLite3Driver(path: ":memory:")
        let deps = SyncEngineDeps(makeDriver: { _ in driver }, secureStorage: InMemorySecureStorage())
        let engine = createSync(deps)(todoOnly, SyncEngineConfig(name: "backfill-guard", syncIntervalMs: 3_600_000))
        await engine.ready
        XCTAssertTrue(engine.insert("todo", ["title": "fine"]).isOk)
        try driver.exec(
            "insert into \"todo\" (id, title, createdAt, updatedAt, isDeleted) values (?, ?, ?, ?, 0)",
            [.text("bad"), .text("legacy"), .text("2020-01-01"), .text("2020-01-01T00:00:00Z")])

        // An unreachable relay: the backfill runs before the push that fails.
        engine.setTransports([Transport(url: "http://127.0.0.1:9")])
        await engine.sync()

        let queued = try driver.select(
            "select event_id from \"\(Store.outboxTable)\" order by event_id").compactMap {
            if case .text(let e)? = $0["event_id"] { return e } else { return nil }
        }
        XCTAssertEqual(queued.count, 1, "only the canonical row is queued")
        XCTAssertFalse(queued.contains("2020-01-01T00:00:00Z"), "the malformed stamp never reaches the outbox")
        engine.setTransports([])
    }

    // Authenticated data this build cannot write is retained for a later build,
    // exactly as the TypeScript engine does; it used to be dropped on the floor.
    func testAnUnwritableRemoteRowIsRetainedNotDropped() async throws {
        let driver = try SQLite3Driver(path: ":memory:")
        let config = SyncEngineConfig(name: "retain-unwritable")
        let staged = Store(schema: todoOnly, config: config)
        staged.driver = driver
        try staged.ensureSchema()
        let hlc = HLC.make(deviceId: "remote", millis: Int64(Date().timeIntervalSince1970 * 1000) - 1_000)
        let unwritable = SyncPayload(
            schemaVersion: 1, table: "todo", op: "upsert", rowId: "bad-title", hlc: hlc,
            value: ["title": .string(""), "createdAt": .string("2026-01-01T00:00:00.000Z"),
                    "updatedAt": .string(hlc), "isDeleted": .int(0)])
        staged.deferRemoteEvent(eventId: hlc, payloadJson: Envelope.encodePayload(unwritable))

        let deps = SyncEngineDeps(makeDriver: { _ in driver }, secureStorage: InMemorySecureStorage())
        let engine = createSync(deps)(todoOnly, config)
        await engine.ready

        XCTAssertTrue(
            try driver.select("select 1 from \"todo\" where id = ?", [.text("bad-title")]).isEmpty,
            "a value the column refuses is not written")
        XCTAssertEqual(
            try driver.select(
                "select 1 from \"\(Store.deferredTable)\" where event_id = ?", [.text(hlc)]).count, 1,
            "the event stays retained for a build whose schema can write it")
    }
}
