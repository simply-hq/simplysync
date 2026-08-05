// Host-side verification for the Swift engine. Compiles Kit + Engine with swiftc
// (no simulator) and exercises the React-parity surface: schema → DDL,
// insert/update/upsert, typed reactive queries, soft deletes, validation, and —
// if a relay URL is passed — a live two-device push/pull/apply round-trip.
//
//   swiftc ../../../Sources/SimplySync/Kit/*.swift ../../../Sources/SimplySync/Engine/*.swift \
//     SimplySyncDemo/AppSchema.swift verify/engine/main.swift -o /tmp/ssengine
//   /tmp/ssengine                       # local engine tests
//   /tmp/ssengine http://localhost:4100 # + live two-device interop
//   SIMPLYSYNC_RECOVERY_KEY=<key> SIMPLYSYNC_TODO_TITLE=<title> \
//     /tmp/ssengine http://localhost:4100 # join a cross-platform run
import Foundation

func check(_ cond: Bool, _ msg: String) {
    if cond { print("  ok  \(msg)") } else { print("  FAIL \(msg)"); exit(1) }
}

let schema = Schema([
    "todo": [
        "id": .id("todo"),
        "title": .nonEmptyString,
        "done": .sqliteBoolean,
    ],
    "note": [
        "id": .id("note"),
        "body": .string,
    ],
])

struct VerifyTodoRow: Decodable {
    let id: String
    let title: String
    let done: Bool
    let updatedAt: String
}

let listSQL = """
select id, title, done, updatedAt from "todo" where "isDeleted" = 0 order by "updatedAt" desc
"""

print("== local engine ==")
let deps = SyncEngineDeps(
    makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
    secureStorage: InMemorySecureStorage())
let engine = createSync(deps)(schema, SyncEngineConfig(name: "verify"))
await engine.ready

let owner = await engine.appOwner
check(owner != nil, "owner derived on boot")
check(owner?.recoveryKey.hasPrefix("sf1_") == true, "default owner is an sf1_ recovery key")

let q = engine.createQuery(listSQL, as: VerifyTodoRow.self)

let insert1 = engine.insert("todo", ["title": "Buy milk", "done": false])
check(insert1.isOk, "insert returns ok with an id")
let id1 = insert1.id!
_ = engine.insert("todo", ["title": "Walk dog", "done": false])
check(engine.loadQuery(q).count == 2, "two rows after two inserts")
check(engine.loadQuery(q).first?.title == "Walk dog", "ordered newest-first by HLC")

let bad = engine.insert("todo", ["title": ""])
check(!bad.isOk, "empty NonEmptyString is rejected")
check(bad.errorMessage?.contains("non-empty") == true, "validation error names the problem")

let upd = engine.update("todo", ["id": .string(id1), "done": true])
check(upd.isOk, "update ok")
check(engine.loadQuery(q).first(where: { $0.id == id1 })?.done == true, "done toggled true")

let missing = engine.update("todo", ["id": "nope", "done": true])
check(!missing.isOk, "update of a missing row fails")

_ = engine.update("todo", ["id": .string(id1), "isDeleted": sqliteTrue])
check(engine.loadQuery(q).count == 1, "soft-deleted row hidden by isDeleted filter")

let before = engine.getQueryRows(q).count
_ = engine.insert("todo", ["title": "Third", "done": false])
check(engine.getQueryRows(q).count == before + 1, "query cache refreshes on write")

// A separate table proves multi-table DDL + per-table queries.
_ = engine.insert("note", ["body": "hello"])
struct NoteRow: Decodable { let id: String; let body: String }
let notes = engine.loadQuery(engine.createQuery("select id, body from \"note\"", as: NoteRow.self))
check(notes.count == 1 && notes[0].body == "hello", "second table works independently")

// Relay status with no transports configured: nothing to probe.
check(await engine.getRelayStatuses().isEmpty, "no transports -> no relay statuses")

print("LOCAL OK")

// Additive schema migration: a table gains columns across app versions. Two
// stores over ONE database, mirroring an app that evolves its schema.
print("== schema migration ==")
do {
    let mdriver = try SQLite3Driver(path: ":memory:")
    let v1 = Schema(["todo": ["id": .id("todo"), "title": .nonEmptyString]])
    let s1 = Store(schema: v1, config: SyncEngineConfig(name: "migrate"))
    s1.driver = mdriver
    try s1.ensureSchema()
    try mdriver.exec(
        "insert into \"todo\" (id, title, createdAt, updatedAt, isDeleted) values (?, ?, ?, ?, 0)",
        [.text("t1"), .text("buy milk"), .text("2026-01-01"), .text("aaa")])

    let v2 = Schema(["todo": [
        "id": .id("todo"), "title": .nonEmptyString,
        "priority": .finiteNumber, "dueDate": .string,
    ]])
    let s2 = Store(schema: v2, config: SyncEngineConfig(name: "migrate"))
    s2.driver = mdriver
    try s2.ensureSchema()

    let cols = Set(try mdriver.select("pragma table_info(\"todo\")").compactMap {
        (r: SQLiteRow) -> String? in
        if case .text(let n)? = r["name"] { return n } else { return nil }
    })
    check(cols.contains("priority"), "migration adds priority column")
    check(cols.contains("dueDate"), "migration adds dueDate column")

    let old = try mdriver.select("select title, priority from \"todo\" where id = ?", [.text("t1")]).first
    if case .text(let t)? = old?["title"] {
        check(t == "buy milk", "pre-migration row preserved")
    } else {
        check(false, "pre-migration row readable")
    }
    check(old?["priority"] == .null, "new column is NULL on the old row")

    // Idempotent: re-running ensureSchema doesn't error or duplicate columns.
    let s3 = Store(schema: v2, config: SyncEngineConfig(name: "migrate"))
    s3.driver = mdriver
    try s3.ensureSchema()
    check(try mdriver.select("pragma table_info(\"todo\")").count == cols.count,
          "ensureSchema is idempotent")
} catch {
    check(false, "schema migration threw: \(error)")
}

// Payload-schema compatibility: an older app must retain (not partially apply)
// a newer payload, then replay it once an upgraded app declares support.
print("== payload schema version ==")
do {
    let vdriver = try SQLite3Driver(path: ":memory:")
    let storage = InMemorySecureStorage()
    let versionedSchema = Schema([
        "todo": ["id": .id("todo"), "title": .nonEmptyString],
    ])
    let v1Config = SyncEngineConfig(name: "payload-version", schemaVersion: 1)
    let stagedStore = Store(schema: versionedSchema, config: v1Config)
    stagedStore.driver = vdriver
    try stagedStore.ensureSchema()
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
    stagedStore.deferRemoteEvent(
        eventId: remoteHlc,
        payloadJson: Envelope.encodePayload(future))

    let versionedDeps = SyncEngineDeps(
        makeDriver: { _ in vdriver },
        secureStorage: storage)
    let old = createSync(versionedDeps)(versionedSchema, v1Config)
    await old.ready
    check(
        try vdriver.select(
            "select 1 from \"todo\" where id = ?", [.text("future-row")]).isEmpty,
        "v1 does not apply a v2 payload")
    check(
        try vdriver.select(
            "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
            [.text(remoteHlc)]).count == 1,
        "v1 retains the future payload")

    let upgraded = createSync(versionedDeps)(
        versionedSchema,
        SyncEngineConfig(name: "payload-version", schemaVersion: 2))
    await upgraded.ready
    check(
        try vdriver.select(
            "select title from \"todo\" where id = ?", [.text("future-row")]).count == 1,
        "v2 replays the retained payload")
    check(
        try vdriver.select(
            "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
            [.text(remoteHlc)]).isEmpty,
        "replayed payload leaves the deferred queue")

    let local = upgraded.insert("todo", ["title": "written by v2"])
    check(local.isOk, "v2 local write succeeds")
    guard
        let owner = await upgraded.appOwner,
        let row = try vdriver.select(
            "select envelope_json from \"\(Store.outboxTable)\" order by event_id desc limit 1").first,
        case .text(let envelopeJson)? = row["envelope_json"],
        let envelopeData = envelopeJson.data(using: .utf8)
    else {
        check(false, "v2 outbox envelope is readable")
        throw EnvelopeError.decodeFailed
    }
    let envelope = try JSONDecoder().decode(SyncEnvelope.self, from: envelopeData)
    let localPayload = try Envelope.decrypt(
        identity: IdentityDeriver.derive(from: owner.recoveryKey),
        envelope: envelope)
    check(localPayload.schemaVersion == 2, "local events carry the configured version")
} catch {
    check(false, "payload schema version threw: \(error)")
}

// Additive table compatibility: an older schema keeps a valid payload for a
// table it does not know, then an upgraded schema replays it.
print("== unknown table replay ==")
do {
    let driver = try SQLite3Driver(path: ":memory:")
    let storage = InMemorySecureStorage()
    let oldSchema = Schema([
        "todo": ["id": .id("todo"), "title": .nonEmptyString],
    ])
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
    let staged = Store(
        schema: oldSchema,
        config: SyncEngineConfig(name: "unknown-table"))
    staged.driver = driver
    try staged.ensureSchema()
    staged.deferRemoteEvent(
        eventId: eventId,
        payloadJson: Envelope.encodePayload(payload))

    let deps = SyncEngineDeps(
        makeDriver: { _ in driver },
        secureStorage: storage)
    let old = createSync(deps)(
        oldSchema,
        SyncEngineConfig(name: "unknown-table"))
    await old.ready
    check(
        try driver.select(
            "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
            [.text(eventId)]).count == 1,
        "old schema retains an unknown-table payload")

    let upgraded = createSync(deps)(
        upgradedSchema,
        SyncEngineConfig(name: "unknown-table"))
    await upgraded.ready
    check(
        try driver.select(
            "select title from \"task\" where id = ?", [.text("task-1")]).count == 1,
        "upgraded schema replays the unknown-table payload")
    check(
        try driver.select(
            "select 1 from \"\(Store.deferredTable)\" where event_id = ?",
            [.text(eventId)]).isEmpty,
        "unknown-table replay drains deferred storage")
} catch {
    check(false, "unknown-table replay threw: \(error)")
}

// Multi-relay push: events are selected by a per-relay high-water mark
// (event_id > cursor) so every relay independently receives every event —
// including events already pushed to another relay (the old `pushed_at is null`
// filter wrongly skipped those).
print("== multi-relay push cursor ==")
do {
    let cdriver = try SQLite3Driver(path: ":memory:")
    let cstore = Store(
        schema: Schema(["todo": ["id": .id("todo"), "title": .nonEmptyString]]),
        config: SyncEngineConfig(name: "cursor"))
    cstore.driver = cdriver
    try cstore.ensureSchema()
    for eid in ["e1", "e2", "e3"] {
        try cdriver.exec(
            "insert into \"\(Store.outboxTable)\" (event_id, envelope_json) values (?, ?)",
            [.text(eid), .text("{}")])
    }
    func after(_ cursor: String) throws -> [String] {
        try cdriver.select(
            "select event_id from \"\(Store.outboxTable)\" where event_id > ? order by event_id asc",
            [.text(cursor)]
        ).compactMap { if case .text(let e)? = $0["event_id"] { return e } else { return nil } }
    }
    check(try after("") == ["e1", "e2", "e3"], "empty cursor selects all (a fresh relay)")
    check(try after("e1") == ["e2", "e3"], "cursor advances past acked events")
    check(try after("e3").isEmpty, "fully caught up selects none")
    // e1 pushed to one relay; a fresh relay (cursor "") must still get it.
    try cdriver.exec(
        "update \"\(Store.outboxTable)\" set pushed_at = ? where event_id = ?",
        [.text("2026-01-01"), .text("e1")])
    check(try after("") == ["e1", "e2", "e3"], "a fresh relay still gets events pushed elsewhere")
} catch {
    check(false, "multi-relay cursor threw: \(error)")
}

// Outbox pruning: the send queue drops events delivered to every current relay.
print("== outbox pruning ==")
do {
    let pdriver = try SQLite3Driver(path: ":memory:")
    let pstore = Store(
        schema: Schema(["todo": ["id": .id("todo"), "title": .nonEmptyString]]),
        config: SyncEngineConfig(name: "prune"))
    pstore.driver = pdriver
    try pstore.ensureSchema()
    for eid in ["e1", "e2", "e3", "e4"] {
        try pdriver.exec(
            "insert into \"\(Store.outboxTable)\" (event_id, envelope_json, pushed_at) values (?, '{}', ?)",
            [.text(eid), .text("2026-01-01")])
    }
    func outboxCount() throws -> Int {
        if case .integer(let n)? = try pdriver.select(
            "select count(*) as c from \"\(Store.outboxTable)\"").first?["c"] { return Int(n) }
        return -1
    }
    // a acked through e3, b only through e2 -> min is e2 -> prune e1, e2.
    pstore.setMeta("push:http://a", "e3")
    pstore.setMeta("push:http://b", "e2")
    check(pstore.pruneOutbox(["http://a", "http://b"]) == 2, "prunes events delivered to every relay")
    check(try outboxCount() == 2, "undelivered events (e3, e4) remain")
    check(pstore.pruneOutbox(["http://a", "http://b", "http://c"]) == 0, "uncursored relay -> prune nothing")
    check(pstore.pruneOutbox([]) == 0, "no relays -> prune nothing")
} catch {
    check(false, "outbox pruning threw: \(error)")
}

// First-class soft-delete: hides the row, keeps the tombstone, idempotent.
print("== delete ==")
let delIns = engine.insert("todo", ["title": "delete me", "done": false])
check(delIns.isOk, "insert for delete ok")
let delId = delIns.id!
let beforeDel = engine.loadQuery(q).count
check(engine.delete("todo", id: delId).isOk, "delete returns ok")
check(engine.loadQuery(q).count == beforeDel - 1, "delete hides the row")
check(engine.delete("todo", id: "ghost").isOk, "delete of an unknown id is idempotent")

// Atomic batch + deleteMany.
print("== batch ==")
do {
    let bdeps = SyncEngineDeps(makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
                               secureStorage: InMemorySecureStorage())
    let be = createSync(bdeps)(schema, SyncEngineConfig(name: "batch"))
    await be.ready
    let bq = be.createQuery(listSQL, as: VerifyTodoRow.self)

    let seed = be.batch { b in
        b.insert("todo", ["title": "a", "done": false])
        b.insert("todo", ["title": "b", "done": false])
        b.insert("todo", ["title": "c", "done": false])
    }
    check(seed.isOk && seed.ids.count == 3, "batch seeds three rows")
    check(be.loadQuery(bq).count == 3, "all three present")

    let before = be.loadQuery(bq).count
    let bad = be.batch { b in
        b.insert("todo", ["title": "ok", "done": false])
        b.insert("todo", ["title": "", "done": false]) // rejected
    }
    check(!bad.isOk, "invalid op fails the batch")
    check(be.loadQuery(bq).count == before, "nothing written on a failed batch")

    let firstId = be.loadQuery(bq).first!.id
    let mixed = be.batch { b in
        b.insert("todo", ["title": "new", "done": false])
        b.delete("todo", id: firstId)
    }
    check(mixed.isOk, "mixed write+delete batch ok")
    check(be.loadQuery(bq).contains { $0.title == "new" }, "inserted row present")
    check(!be.loadQuery(bq).contains { $0.id == firstId }, "deleted row gone")

    // deleteMany
    let ids = be.loadQuery(bq).map { $0.id }
    check(be.deleteMany("todo", ids: ids).isOk, "deleteMany ok")
    check(be.loadQuery(bq).isEmpty, "deleteMany cleared all")
}

// Tombstone GC: reclaim old soft-deleted rows, with the safety guards.
print("== purge ==")
do {
    let gdriver = try SQLite3Driver(path: ":memory:")
    let gstore = Store(
        schema: Schema(["todo": ["id": .id("todo"), "title": .nonEmptyString]]),
        config: SyncEngineConfig(name: "purge"))
    gstore.driver = gdriver
    try gstore.ensureSchema()
    let oldHlc = HLC.make(deviceId: "devA", millis: 1000)
    try gstore.writeRow("todo", [
        "id": .string("t1"), "title": .string("x"),
        "createdAt": .string("2020-01-01"), "updatedAt": .string(oldHlc), "isDeleted": sqliteTrue,
    ])
    try gdriver.exec(
        "insert into \"\(Store.outboxTable)\" (event_id, envelope_json, pushed_at) values (?, '{}', NULL)",
        [.text(oldHlc)])
    func count() throws -> Int {
        if case .integer(let n)? = try gdriver.select("select count(*) as c from \"todo\"").first?["c"] { return Int(n) }
        return -1
    }
    check(gstore.purgeDeleted(olderThanMs: 1_000_000_000_000, nowMs: 5000, requirePushed: false) == 0,
          "a huge window keeps recent tombstones")
    check(gstore.purgeDeleted(olderThanMs: 0, nowMs: 5000, requirePushed: true) == 0,
          "unpushed delete kept while relays configured")
    check(try count() == 1, "tombstone still present")
    try gdriver.exec("update \"\(Store.outboxTable)\" set pushed_at = ? where event_id = ?",
                     [.text("2020-01-01"), .text(oldHlc)])
    check(gstore.purgeDeleted(olderThanMs: 0, nowMs: 5000, requirePushed: true) == 1, "pushed tombstone reclaimed")
    check(try count() == 0, "row purged")

    // No relays -> purge by age regardless of outbox state.
    let gd2 = try SQLite3Driver(path: ":memory:")
    let gs2 = Store(
        schema: Schema(["todo": ["id": .id("todo"), "title": .nonEmptyString]]),
        config: SyncEngineConfig(name: "purge2"))
    gs2.driver = gd2
    try gs2.ensureSchema()
    try gs2.writeRow("todo", [
        "id": .string("t2"), "title": .string("y"),
        "createdAt": .string("2020-01-01"), "updatedAt": .string(HLC.make(deviceId: "devA", millis: 1000)),
        "isDeleted": sqliteTrue,
    ])
    check(gs2.purgeDeleted(olderThanMs: 0, nowMs: 5000, requirePushed: false) == 1,
          "no relays -> purge by age")

    // Detaching transports does not make a previously synced database safe to
    // compact: durable cursor history keeps the public purge disabled.
    let gd3 = try SQLite3Driver(path: ":memory:")
    let historySchema = Schema([
        "todo": ["id": .id("todo"), "title": .nonEmptyString],
    ])
    let gs3 = Store(
        schema: historySchema,
        config: SyncEngineConfig(name: "purge-history"))
    gs3.driver = gd3
    try gs3.ensureSchema()
    try gs3.writeRow("todo", [
        "id": .string("t3"), "title": .string("z"),
        "createdAt": .string("2020-01-01"),
        "updatedAt": .string(HLC.make(deviceId: "devA", millis: 1000)),
        "isDeleted": sqliteTrue,
    ])
    gs3.setMeta("cursor:http://relay.test", "1")
    let historyEngine = createSync(
        SyncEngineDeps(
            makeDriver: { _ in gd3 },
            secureStorage: InMemorySecureStorage())
    )(historySchema, SyncEngineConfig(name: "purge-history"))
    await historyEngine.ready
    check(historyEngine.purgeDeleted(olderThanMs: 0) == 0,
          "relay history keeps tombstone purge disabled after detach")
    check(
        try gd3.select("select 1 from \"todo\" where id = ?", [.text("t3")]).count == 1,
        "relay-history tombstone remains")
} catch {
    check(false, "purge threw: \(error)")
}

// Fractional indexing: reorderable-list ordering keys.
print("== fractional index ==")
struct SeededRNG: RandomNumberGenerator {
    var state: UInt64
    init(_ seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state = state &* 6364136223846793005 &+ 1442695040888963407
        return state
    }
}
do {
    let first = try keyBetween(nil, nil)
    check(isOrderKey(first), "first key is valid")

    var prev = first, appendOk = true
    for _ in 0..<100 { let n = try keyBetween(prev, nil); if !(n > prev) { appendOk = false }; prev = n }
    check(appendOk, "append always grows")

    let a = try keyBetween(nil, nil)
    let c = try keyBetween(a, nil)
    var lo = a, betweenOk = true
    for _ in 0..<100 { let b = try keyBetween(lo, c); if !(lo < b && b < c) { betweenOk = false }; lo = b }
    check(betweenOk, "insert-between stays strictly between")

    var threw = false
    do { _ = try keyBetween(c, a) } catch { threw = true }
    check(threw, "out-of-order bounds throw")

    let ks = try keysBetween(nil, nil, 8)
    var ksOk = ks.count == 8
    for i in 1..<ks.count where !(ks[i - 1] < ks[i]) { ksOk = false }
    check(ksOk, "keysBetween returns 8 sorted keys")

    var rng = SeededRNG(12345)
    var list: [String] = []
    for _ in 0..<1000 {
        let slot = Int.random(in: 0...list.count, using: &rng)
        let la = slot == 0 ? nil : list[slot - 1]
        let lb = slot == list.count ? nil : list[slot]
        list.insert(try keyBetween(la, lb), at: slot)
    }
    var incOk = true
    for i in 1..<list.count where !(list[i - 1] < list[i]) { incOk = false }
    check(incOk, "fuzz: 1000 random inserts strictly increasing")
    check(Set(list).count == list.count, "fuzz: no duplicate keys")
} catch {
    check(false, "fractional index threw: \(error)")
}

// Conflict-free counters: reaction/unread tallies that never lose increments.
print("== counter ==")
do {
    let cdeps = SyncEngineDeps(makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
                               secureStorage: InMemorySecureStorage())
    let cschema = Schema(["counter": counterColumns(), "msg": ["id": .id("msg"), "body": .string]])
    let ce = createSync(cdeps)(cschema, SyncEngineConfig(name: "counter"))
    await ce.ready
    func total(_ key: String) -> Double { ce.loadQuery(counterTotalQuery(ce, "counter", key)).first?.total ?? -1 }

    check(total("m1:like") == 0, "empty counter reads 0")
    _ = incrementCounter(ce, "counter", "m1:like")
    _ = incrementCounter(ce, "counter", "m1:like")
    _ = incrementCounter(ce, "counter", "m1:like")
    _ = decrementCounter(ce, "counter", "m1:like")
    check(total("m1:like") == 2, "increments/decrements sum to 2")

    for _ in 0..<100 { _ = incrementCounter(ce, "counter", "burst") }
    check(total("burst") == 100, "100 rapid increments all land")

    _ = incrementCounter(ce, "counter", "inbox:unread", amount: 4)
    _ = decrementCounter(ce, "counter", "inbox:unread", amount: 1)
    check(total("inbox:unread") == 3, "arbitrary amounts")
    check(total("m1:like") == 2, "independent keys unaffected")
}

// Ephemeral presence: typing / online / "AI thinking" — never persisted.
print("== presence ==")
do {
    let hub = MemoryTransportHub()
    let a = createPresenceChannel(topic: "presence", transport: hub.connect(), selfId: "A", now: { 1000 })
    let b = createPresenceChannel(topic: "presence", transport: hub.connect(), selfId: "B", now: { 1000 })
    a.publish("alice"); b.publish("bob")
    check(Set(a.list().map { $0.state }) == Set(["alice", "bob"]), "peers see each other (own echo ignored)")

    var t: Int64 = 1000
    let hub2 = MemoryTransportHub()
    let a2 = createPresenceChannel(topic: "p", transport: hub2.connect(), selfId: "A", ttlMs: 10_000, now: { t })
    let b2 = createPresenceChannel(topic: "p", transport: hub2.connect(), selfId: "B", ttlMs: 10_000, now: { t })
    a2.publish("alice"); b2.publish("bob")
    check(b2.list().count == 2, "both present")
    t += 11_000
    b2.publish("bob") // bob heartbeats; alice didn't
    check(b2.list().map { $0.state } == ["bob"], "alice expired after TTL")

    let hub3 = MemoryTransportHub()
    let a3 = createPresenceChannel(topic: "p", transport: hub3.connect(), selfId: "A", now: { 1000 })
    let b3 = createPresenceChannel(topic: "p", transport: hub3.connect(), selfId: "B", now: { 1000 })
    a3.publish("alice"); b3.publish("bob"); a3.clear()
    check(b3.list().map { $0.state } == ["bob"], "clear drops immediately")

    let hub4 = MemoryTransportHub()
    let typing = createPresenceChannel(topic: "room:1:typing", transport: hub4.connect(), selfId: "A", now: { 1000 })
    let thinking = createPresenceChannel(topic: "thinking:m7", transport: hub4.connect(), selfId: "A", now: { 1000 })
    let peer = createPresenceChannel(topic: "room:1:typing", transport: hub4.connect(), selfId: "B", now: { 1000 })
    var typingN = 0, thinkingN = 0
    _ = typing.subscribe { typingN += 1 }
    _ = thinking.subscribe { thinkingN += 1 }
    peer.publish("1")
    check(typingN == 1 && thinkingN == 0, "topics isolated; only matching channel notified")
    check(typing.list().map { $0.senderId } == ["B"], "typing channel sees B")

    for ch in [a, b, a2, b2, a3, b3, typing, thinking, peer] { ch.stop() }
}

if CommandLine.arguments.count > 1 {
    let relayURL = CommandLine.arguments[1]
    let environment = ProcessInfo.processInfo.environment
    print("== live two-device round-trip vs \(relayURL) ==")
    let key = environment["SIMPLYSYNC_RECOVERY_KEY"]
        ?? IdentityDeriver.createRecoveryKey()
    let finalTitle = environment["SIMPLYSYNC_TODO_TITLE"] ?? "Edited by B"
    let initialTitle = environment["SIMPLYSYNC_TODO_TITLE"].map {
        "\($0) (draft)"
    } ?? "From A"
    func makeEngine(_ name: String) -> SyncEngine {
        let d = SyncEngineDeps(
            makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
            secureStorage: InMemorySecureStorage(["\(name):mnemonic": key]))
        return createSync(d)(appSchema, SyncEngineConfig(
            name: name, transports: [Transport(url: relayURL)], syncIntervalMs: 1000))
    }
    let a = makeEngine("liveA")
    let b = makeEngine("liveB")
    await a.ready
    await b.ready
    let oa = await a.appOwner
    let ob = await b.appOwner
    check(oa?.id == ob?.id, "both devices derive the same owner from the shared key")

    _ = a.insert("todo", ["title": .string(initialTitle), "done": false])
    await a.sync()
    var received = false
    let qb = todosQuery
    for _ in 0..<8 where !received {
        await b.sync()
        received = b.loadQuery(qb).contains { $0.title == initialTitle }
    }
    check(received, "device B pulled + decrypted + applied A's row")

    // Convergence: B edits, A sees it (last-writer-wins).
    if let row = b.loadQuery(qb).first(where: { $0.title == initialTitle }) {
        _ = b.update("todo", [
            "id": .string(row.id),
            "title": .string(finalTitle),
        ])
        await b.sync()
        var converged = false
        let qa = todosQuery
        for _ in 0..<8 where !converged {
            await a.sync()
            converged = a.loadQuery(qa).contains { $0.title == finalTitle }
        }
        check(converged, "A converged on B's edit (LWW by HLC)")
    }

    // Per-relay status + storage usage: /v1/status via getRelayStatuses.
    let statuses = await a.getRelayStatuses()
    check(statuses.count == 1, "one status entry per configured relay")
    if let s = statuses.first {
        check(s.reachable, "relay reachable via /v1/status")
        check(s.lastSyncedAt != nil, "lastSyncedAt recorded after a successful sync")
        check(s.lastFailure == nil, "no failure recorded on a healthy relay")
        check(s.version != nil, "relay reports its version")
        check((s.usedBytes ?? 0) > 0, "usedBytes reports stored data")
        check((s.quotaBytes ?? 0) > 0, "quotaBytes reported")
        check((s.headSeq ?? 0) > 0, "headSeq advanced past the pushed events")
    }
    print("LIVE OK")
}

print("ALL ENGINE TESTS PASSED")
exit(0)
