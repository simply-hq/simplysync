import Foundation

// End-to-end check against a running relay: derive a fresh isolated owner,
// encrypt a row, PUSH it, PULL it back, and decrypt — proving the native Swift
// client speaks the real wire protocol. Run with:
//   swiftc ../../../Sources/SimplySync/Kit/*.swift verify/integration.swift -o /tmp/ssintegration
//   /tmp/ssintegration http://localhost:4100

let relayURL = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "http://localhost:4100"
let recoveryKeyArg = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : IdentityDeriver.createRecoveryKey()
let titleArg = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "Hello from native Swift"

let identity = try IdentityDeriver.derive(from: recoveryKeyArg)
let client = RelayClient(baseURL: URL(string: relayURL)!, ownerId: identity.ownerId, relayAuth: identity.relayAuth)

let hlc = HLC.make(deviceId: "swift-dev", millis: 1_700_000_000_000, counter: 0)
let payload = SyncPayload(
    schemaVersion: 1, table: "todo", op: "upsert", rowId: "swift-row-1", hlc: hlc,
    value: ["title": .string(titleArg), "done": .int(0)]
)
let envelope = try Envelope.encrypt(
    identity: identity, eventId: hlc, deviceId: "swift-dev",
    createdAt: "2026-06-09T00:00:00.000Z", payload: payload
)

let semaphore = DispatchSemaphore(value: 0)
var exitCode: Int32 = 1

Task {
    do {
        print("owner \(identity.ownerId) -> \(relayURL)")
        let push = try await client.push([envelope])
        print("  PUSH  accepted=\(push.accepted) duplicate=\(push.duplicate)")

        let pull = try await client.pull(after: "")
        print("  PULL  events=\(pull.events.count) nextCursor=\(pull.nextCursor)")

        guard let received = pull.events.first else { throw NSError(domain: "test", code: 1) }
        let decrypted = try Envelope.decrypt(identity: identity, envelope: received)
        let title: String = { if case .string(let s)? = decrypted.value["title"] { return s }; return "" }()
        print("  DECRYPT title=\"\(title)\" table=\(decrypted.table) rowId=\(decrypted.rowId)")

        if push.accepted == 1, pull.events.count >= 1, title == titleArg {
            print("\nEND-TO-END OK — native Swift pushed, pulled, and decrypted through the relay.")
            exitCode = 0
        } else {
            print("\nUNEXPECTED RESULT")
        }
    } catch {
        print("ERROR: \(error)")
    }
    semaphore.signal()
}
semaphore.wait()
exit(exitCode)
