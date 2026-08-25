import Foundation

// Host-side correctness gate: re-derive identity and re-encrypt the fixed
// vectors produced by the real JS protocol, and assert byte-equality. Run with:
//   swiftc ../../../Sources/SimplySync/Kit/*.swift verify/main.swift -o /tmp/ssverify && \
//     (cd apps/todolist/swift && /tmp/ssverify)

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
let corpus = try JSONSerialization.jsonObject(with: data) as! [String: Any]
let vectors = corpus["identities"] as! [String: [String: Any]]

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

    // Checked before the ciphertext: these two strings are what a ciphertext
    // mismatch is usually caused by, and a bare ciphertext failure names
    // neither the field order nor the key sort that actually moved.
    check("headerCanonical",
          Envelope.encodeHeader(
              version: envelope.version, ownerId: envelope.ownerId,
              eventId: envelope.eventId, deviceId: envelope.deviceId,
              createdAt: envelope.createdAt, streamId: envelope.streamId),
          v["headerCanonical"] as! String)
    check("payloadCanonical", Envelope.encodePayload(payload),
          v["payloadCanonical"] as! String)
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

// HLC.compare is the sole last-write-wins tiebreaker. A port that orders two
// events differently than TypeScript hands its device a different winner for
// the same pair, and the two stop converging — exactly the drift that shipped
// once, when TS used locale collation and the ports used code-unit order.
print("[hlcOrder]")
let orderCases = corpus["hlcOrder"] as! [[String: Any]]
for c in orderCases {
    let actual = HLC.compare((c["left"] as! String), c["right"] as! String)
    let sign = actual < 0 ? "lt" : (actual > 0 ? "gt" : "eq")
    check(c["name"] as! String, sign, c["expect"] as! String)
}

print("")
if failures == 0 {
    print("ALL VECTORS PASS — Swift is byte-compatible with @simplysync/protocol.")
    exit(0)
} else {
    print("\(failures) FAILURE(S).")
    exit(1)
}
