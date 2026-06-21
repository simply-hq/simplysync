// Host-side verification for the Swift engine. Compiles Kit + Engine with swiftc
// (no simulator) and exercises the React-parity surface: schema → DDL,
// insert/update/upsert, typed reactive queries, soft deletes, validation, and —
// if a relay URL is passed — a live two-device push/pull/apply round-trip.
//
//   swiftc SimplySyncDemo/Kit/*.swift SimplySyncDemo/Engine/*.swift verify/engine/main.swift -o /tmp/ssengine
//   /tmp/ssengine                       # local engine tests
//   /tmp/ssengine http://localhost:4100 # + live two-device interop
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

struct TodoRow: Decodable {
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

let q = engine.createQuery(listSQL, as: TodoRow.self)

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

print("LOCAL OK")

if CommandLine.arguments.count > 1 {
    let relayURL = CommandLine.arguments[1]
    print("== live two-device round-trip vs \(relayURL) ==")
    let key = IdentityDeriver.createRecoveryKey()
    func makeEngine(_ name: String) -> SyncEngine {
        let d = SyncEngineDeps(
            makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
            secureStorage: InMemorySecureStorage(["\(name):mnemonic": key]))
        return createSync(d)(schema, SyncEngineConfig(
            name: name, transports: [Transport(url: relayURL)], syncIntervalMs: 1000))
    }
    let a = makeEngine("liveA")
    let b = makeEngine("liveB")
    await a.ready
    await b.ready
    let oa = await a.appOwner
    let ob = await b.appOwner
    check(oa?.id == ob?.id, "both devices derive the same owner from the shared key")

    _ = a.insert("todo", ["title": "From A", "done": false])
    await a.sync()
    var received = false
    let qb = b.createQuery(listSQL, as: TodoRow.self)
    for _ in 0..<8 where !received {
        await b.sync()
        received = b.loadQuery(qb).contains { $0.title == "From A" }
    }
    check(received, "device B pulled + decrypted + applied A's row")

    // Convergence: B edits, A sees it (last-writer-wins).
    if let row = b.loadQuery(qb).first(where: { $0.title == "From A" }) {
        _ = b.update("todo", ["id": .string(row.id), "title": "Edited by B"])
        await b.sync()
        var converged = false
        let qa = a.createQuery(listSQL, as: TodoRow.self)
        for _ in 0..<8 where !converged {
            await a.sync()
            converged = a.loadQuery(qa).contains { $0.title == "Edited by B" }
        }
        check(converged, "A converged on B's edit (LWW by HLC)")
    }
    print("LIVE OK")
}

print("ALL ENGINE TESTS PASSED")
exit(0)
