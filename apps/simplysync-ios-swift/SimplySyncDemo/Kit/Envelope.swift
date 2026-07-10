import Foundation

/// On-the-wire encrypted event. Field names and JSON shape match `SyncEnvelope`
/// in @simplysync/protocol exactly, so the relay and JS clients accept it.
struct SyncEnvelope: Codable {
    let version: Int
    let ownerId: String
    let eventId: String
    let deviceId: String
    let nonce: String
    let ciphertext: String
    let createdAt: String
    let streamId: String?
}

/// The decrypted event body — the Swift port of `SyncPayload`. `value` carries
/// the row's columns.
struct SyncPayload {
    let schemaVersion: Int
    let table: String
    let op: String // "upsert" | "delete"
    let rowId: String
    let hlc: String
    let value: [String: JSONValue]
}

enum EnvelopeError: Error { case ownerMismatch, decodeFailed }

enum Envelope {
    private static let nonceBytes = 12

    static func encrypt(
        identity: Identity,
        eventId: String,
        deviceId: String,
        createdAt: String,
        payload: SyncPayload
    ) throws -> SyncEnvelope {
        let nonce = Crypto.randomBytes(nonceBytes)
        return try seal(identity: identity, eventId: eventId, deviceId: deviceId,
                        createdAt: createdAt, payload: payload, nonce: nonce)
    }

    /// The pseudonymous stream id the relay sees for a logical row:
    /// HMAC(streamKey, "<table> <rowId>"), base64url, truncated to 22 chars.
    /// Mirrors `deriveStreamId` in @simplysync/protocol — exported so a client
    /// can name a row's stream without sealing an envelope (e.g. to ask a
    /// relay to drop a fully-purged stream via `POST /v1/streams/compact`).
    static func streamId(identity: Identity, table: String, rowId: String) -> String {
        String(
            Base64URL.encode(
                Crypto.hmacSHA256(key: identity.streamKey,
                                  data: Data("\(table) \(rowId)".utf8))
            ).prefix(22)
        )
    }

    /// Encrypt with an explicit nonce — used by the deterministic test vectors.
    static func seal(
        identity: Identity,
        eventId: String,
        deviceId: String,
        createdAt: String,
        payload: SyncPayload,
        nonce: Data
    ) throws -> SyncEnvelope {
        let streamIdString = streamId(identity: identity, table: payload.table,
                                      rowId: payload.rowId)

        let header = headerObject(
            version: 1, ownerId: identity.ownerId, eventId: eventId,
            deviceId: deviceId, createdAt: createdAt, streamId: streamIdString
        )
        let aad = header.canonicalData()
        let plaintext = payloadObject(payload).canonicalData()
        let ciphertext = try Crypto.aesGcmSeal(key: identity.dataKey, nonce: nonce,
                                               plaintext: plaintext, aad: aad)

        return SyncEnvelope(
            version: 1, ownerId: identity.ownerId, eventId: eventId, deviceId: deviceId,
            nonce: Base64URL.encode(nonce), ciphertext: Base64URL.encode(ciphertext),
            createdAt: createdAt, streamId: streamIdString
        )
    }

    static func decrypt(identity: Identity, envelope: SyncEnvelope) throws -> SyncPayload {
        guard envelope.ownerId == identity.ownerId else { throw EnvelopeError.ownerMismatch }

        let header = headerObject(
            version: envelope.version, ownerId: envelope.ownerId, eventId: envelope.eventId,
            deviceId: envelope.deviceId, createdAt: envelope.createdAt, streamId: envelope.streamId
        )
        let aad = header.canonicalData()
        guard let nonce = Base64URL.decode(envelope.nonce),
              let ctTag = Base64URL.decode(envelope.ciphertext) else {
            throw EnvelopeError.decodeFailed
        }
        let plaintext = try Crypto.aesGcmOpen(key: identity.dataKey, nonce: nonce,
                                              ciphertextAndTag: ctTag, aad: aad)
        return try parsePayload(plaintext)
    }

    // MARK: header / payload as canonical-JSON objects

    private static func headerObject(
        version: Int, ownerId: String, eventId: String,
        deviceId: String, createdAt: String, streamId: String?
    ) -> JSONValue {
        var fields: [String: JSONValue] = [
            "version": .int(version),
            "ownerId": .string(ownerId),
            "eventId": .string(eventId),
            "deviceId": .string(deviceId),
            "createdAt": .string(createdAt),
        ]
        if let streamId { fields["streamId"] = .string(streamId) }
        return .object(fields)
    }

    private static func payloadObject(_ p: SyncPayload) -> JSONValue {
        .object([
            "schemaVersion": .int(p.schemaVersion),
            "table": .string(p.table),
            "op": .string(p.op),
            "rowId": .string(p.rowId),
            "hlc": .string(p.hlc),
            "value": .object(p.value),
        ])
    }

    private static func parsePayload(_ data: Data) throws -> SyncPayload {
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let table = obj["table"] as? String,
              let op = obj["op"] as? String,
              let rowId = obj["rowId"] as? String,
              let hlc = obj["hlc"] as? String else {
            throw EnvelopeError.decodeFailed
        }
        let schemaVersion = (obj["schemaVersion"] as? Int) ?? 1
        var value: [String: JSONValue] = [:]
        if let raw = obj["value"] as? [String: Any] {
            for (k, v) in raw { value[k] = JSONValue.from(v) }
        }
        return SyncPayload(schemaVersion: schemaVersion, table: table, op: op,
                           rowId: rowId, hlc: hlc, value: value)
    }
}
