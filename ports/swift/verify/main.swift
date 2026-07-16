import Foundation

// Host-side correctness gate: re-derive identity and re-encrypt the fixed
// vectors produced by the real JS protocol, and assert byte-equality. Run with:
//   swiftc SimplySyncDemo/Kit/*.swift verify/main.swift -o /tmp/ssverify && \
//     (cd ports/swift && /tmp/ssverify)

var failures = 0
func check(_ name: String, _ actual: String, _ expected: String) {
    if actual == expected {
        print("  ✓ \(name)")
    } else {
        failures += 1
        print("  ✗ \(name)\n      expected: \(expected)\n      actual:   \(actual)")
    }
}

let vectorsURL = URL(fileURLWithPath: "verify/vectors.json")
let data = try Data(contentsOf: vectorsURL)
let vectors = try JSONSerialization.jsonObject(with: data) as! [String: [String: Any]]

// Fixed inputs used by the generator (packages/simplysync-protocol vector script).
let eventId = "00000abcde-0000-dev1"
let deviceId = "dev1"
let createdAt = "2026-01-01T00:00:00.000Z"

for name in ["sf1", "mnemonic"] {
    let v = vectors[name]!
    print("[\(name)]")

    let identity = try IdentityDeriver.derive(from: v["input"] as! String)
    check("ownerId", identity.ownerId, v["ownerId"] as! String)
    check("relayAuth", identity.relayAuth, v["relayAuth"] as! String)
    check("streamKey", Base64URL.encode(identity.streamKey), v["streamKeyB64"] as! String)

    let payload = SyncPayload(
        schemaVersion: 1, table: "todo", op: "upsert", rowId: "row-123",
        hlc: eventId,
        value: ["done": .int(0), "title": .string("Hello from JS")]
    )

    let nonce = Base64URL.decode(v["nonceB64"] as! String)!
    let envelope = try Envelope.seal(
        identity: identity, eventId: eventId, deviceId: deviceId,
        createdAt: createdAt, payload: payload, nonce: nonce
    )
    check("streamId", envelope.streamId ?? "", v["streamId"] as! String)
    check("ciphertext", envelope.ciphertext, v["ciphertextB64"] as! String)

    // Round-trip: decrypt what we sealed and confirm the row survives.
    let decrypted = try Envelope.decrypt(identity: identity, envelope: envelope)
    let title: String = {
        if case .string(let s)? = decrypted.value["title"] { return s }
        return "<missing>"
    }()
    check("roundtrip.title", title, "Hello from JS")
    check("roundtrip.table", decrypted.table, "todo")
}

print("")
if failures == 0 {
    print("ALL VECTORS PASS — Swift is byte-compatible with @simplysync/protocol.")
    exit(0)
} else {
    print("\(failures) FAILURE(S).")
    exit(1)
}
