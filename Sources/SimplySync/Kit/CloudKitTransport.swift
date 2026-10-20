#if canImport(CloudKit)
import CloudKit
import Foundation

/// iCloud as a `SyncTransport`: the owner's encrypted event log parked in a
/// custom zone of the user's own CloudKit private database, instead of (or as
/// well as) a relay.
///
/// Nothing about *what* syncs changes. Records carry the same AES-GCM
/// `SyncEnvelope`s a relay receives, so CloudKit, and Apple, only ever hold
/// ciphertext. Only *where* the log is parked differs:
///
/// - one `SyncEvent` record per envelope, record name = `eventId`, so CloudKit
///   dedupes exactly like a relay (`.ifServerRecordUnchanged` reports an
///   existing name as `serverRecordChanged`, counted as `duplicate`);
/// - the zone's `CKServerChangeToken` is the pull cursor, archived into the
///   engine's string cursor slot;
/// - one zone per owner (`<zonePrefix><ownerId>`), so deleting an owner's iCloud
///   copy is a single zone delete and two owners on one Apple ID never mix.
///
/// Wire it in with `engine.transportFactory = CloudKitTransport.factory(...)`
/// and `engine.setTransports([Transport(url: CloudKitTransport.base)])`. Apple
/// platforms only: TypeScript and Kotlin clients cannot reach this log, so an
/// owner that must sync with them keeps a relay configured alongside.
public struct CloudKitTransport: SyncTransport {
    /// The `Transport(url:)` value that selects iCloud. Deliberately not a URL,
    /// so nothing mistakes it for a relay. It also names this transport's
    /// cursor keys (`push:icloud`, `cursor:icloud`).
    public static let base = "icloud"
    public var id: String { Self.base }

    /// The record type to deploy to the container's Production schema, with
    /// three String fields: `envelope`, `streamId`, `createdAt`.
    public static let recordType = "SyncEvent"
    static let envelopeField = "envelope"
    static let streamIdField = "streamId"
    static let createdAtField = "createdAt"
    /// CloudKit's cap on records per modify operation. The engine pushes larger
    /// batches; they are re-chunked here.
    static let maxRecordsPerOperation = 400

    let database: CKDatabase
    let zoneID: CKRecordZone.ID

    /// - Parameters:
    ///   - containerIdentifier: e.g. `"iCloud.com.example.app"`; the app must
    ///     carry the matching iCloud (CloudKit) entitlement.
    ///   - zonePrefix: keep the default unless you already shipped zones under
    ///     another prefix. Changing it later orphans every existing copy.
    public init(containerIdentifier: String, ownerId: String, zonePrefix: String = "simplysync-") {
        self.init(
            database: CKContainer(identifier: containerIdentifier).privateCloudDatabase,
            zoneID: Self.zoneID(forOwner: ownerId, prefix: zonePrefix)
        )
    }

    init(database: CKDatabase, zoneID: CKRecordZone.ID) {
        self.database = database
        self.zoneID = zoneID
    }

    /// The `SyncEngine.transportFactory` that turns the `CloudKitTransport.base`
    /// entry into this transport and leaves every other base to the relay client.
    public static func factory(
        containerIdentifier: String,
        zonePrefix: String = "simplysync-"
    ) -> (_ base: String, _ identity: Identity) -> (any SyncTransport)? {
        { base, identity in
            guard base == Self.base else { return nil }
            return CloudKitTransport(containerIdentifier: containerIdentifier,
                                     ownerId: identity.ownerId, zonePrefix: zonePrefix)
        }
    }

    static func zoneID(forOwner ownerId: String, prefix: String) -> CKRecordZone.ID {
        CKRecordZone.ID(zoneName: prefix + ownerId, ownerName: CKCurrentUserDefaultName)
    }

    // MARK: SyncTransport

    public func push(_ events: [SyncEnvelope]) async throws -> RelayClient.PushResult {
        guard !events.isEmpty else { return RelayClient.PushResult(accepted: 0, duplicate: 0) }
        try await ensureZone()
        let encoder = JSONEncoder()
        var accepted = 0
        var duplicate = 0
        for chunk in Self.chunks(events, size: Self.maxRecordsPerOperation) {
            let records = try chunk.map { try Self.record(for: $0, zoneID: zoneID, encoder: encoder) }
            let outcome: (saveResults: [CKRecord.ID: Result<CKRecord, Error>],
                          deleteResults: [CKRecord.ID: Result<Void, Error>])
            do {
                outcome = try await database.modifyRecords(
                    saving: records, deleting: [],
                    savePolicy: .ifServerRecordUnchanged, atomically: false)
            } catch {
                throw Self.failure(for: error)
            }
            for result in outcome.saveResults.values {
                switch result {
                case .success:
                    accepted += 1
                case .failure(let error):
                    if (error as? CKError)?.code == .serverRecordChanged {
                        duplicate += 1 // this eventId is already parked: a relay's "duplicate"
                    } else {
                        throw Self.failure(for: error)
                    }
                }
            }
        }
        return RelayClient.PushResult(accepted: accepted, duplicate: duplicate)
    }

    public func pull(after cursor: String) async throws -> RelayClient.PullResult {
        var token = Self.token(from: cursor)
        var events: [SyncEnvelope] = []
        let decoder = JSONDecoder()
        var restartedOnce = false
        while true {
            let page: (modificationResultsByID: [CKRecord.ID: Result<CKDatabase.RecordZoneChange.Modification, Error>],
                       deletions: [CKDatabase.RecordZoneChange.Deletion],
                       changeToken: CKServerChangeToken,
                       moreComing: Bool)
            do {
                page = try await database.recordZoneChanges(inZoneWith: zoneID, since: token)
            } catch {
                switch (error as? CKError)?.code {
                case .zoneNotFound?, .userDeletedZone?:
                    // CloudKit's twin of a relay's 404 "unknown owner": nothing is
                    // parked here yet. The next push recreates the zone.
                    return RelayClient.PullResult(events: [], nextCursor: cursor)
                case .changeTokenExpired? where !restartedOnce:
                    // The server forgot our token. Re-read from the start; the
                    // engine's seen-set and LWW apply make re-seen events a no-op.
                    restartedOnce = true
                    token = nil
                    events.removeAll()
                    continue
                default:
                    throw Self.failure(for: error)
                }
            }
            for result in page.modificationResultsByID.values {
                guard case .success(let modification) = result,
                      let envelope = Self.envelope(from: modification.record, decoder: decoder) else { continue }
                events.append(envelope)
            }
            token = page.changeToken
            if !page.moreComing { break }
        }
        return RelayClient.PullResult(events: events, nextCursor: Self.cursor(from: token) ?? cursor)
    }

    // ponytail: no stream compaction. A relay's POST /v1/streams/compact has no
    // CloudKit twin yet; tombstoned rows' ciphertext stays parked. Add a
    // queryable `streamId` index plus a delete-by-stream pass when an app hits
    // iCloud quota because of delete churn.

    // MARK: Account / lifecycle

    /// Whether this device can use CloudKit right now: signed in to iCloud and
    /// not restricted. Check it before offering iCloud as a choice.
    public static func accountAvailable(containerIdentifier: String) async -> Bool {
        let status = try? await CKContainer(identifier: containerIdentifier).accountStatus()
        return status == .available
    }

    /// Remove every parked event for this owner (a "Delete iCloud copy" button).
    /// A zone that is already gone counts as deleted. Local data is untouched.
    public func deleteEverything() async throws {
        let outcome: (saveResults: [CKRecordZone.ID: Result<CKRecordZone, Error>],
                      deleteResults: [CKRecordZone.ID: Result<Void, Error>])
        do {
            outcome = try await database.modifyRecordZones(saving: [], deleting: [zoneID])
        } catch {
            if (error as? CKError)?.code == .zoneNotFound { return }
            throw Self.failure(for: error)
        }
        if case .failure(let error)? = outcome.deleteResults[zoneID],
           (error as? CKError)?.code != .zoneNotFound {
            throw Self.failure(for: error)
        }
        Self.ensuredZones.remove(zoneID.zoneName)
    }

    /// The zone must exist before the first save. Created once per process per
    /// owner; saving an existing zone is idempotent on CloudKit's side anyway.
    private func ensureZone() async throws {
        guard !Self.ensuredZones.contains(zoneID.zoneName) else { return }
        do {
            _ = try await database.modifyRecordZones(saving: [CKRecordZone(zoneID: zoneID)], deleting: [])
        } catch {
            throw Self.failure(for: error)
        }
        Self.ensuredZones.insert(zoneID.zoneName)
    }

    private final class EnsuredZones: @unchecked Sendable {
        private let lock = NSLock()
        private var names = Set<String>()
        func contains(_ name: String) -> Bool { lock.withLock { names.contains(name) } }
        func insert(_ name: String) { lock.withLock { _ = names.insert(name) } }
        func remove(_ name: String) { lock.withLock { _ = names.remove(name) } }
    }
    private static let ensuredZones = EnsuredZones()

    // MARK: Pure helpers (unit-tested without an iCloud account)

    static func record(for envelope: SyncEnvelope, zoneID: CKRecordZone.ID,
                       encoder: JSONEncoder) throws -> CKRecord {
        let record = CKRecord(recordType: recordType,
                              recordID: CKRecord.ID(recordName: envelope.eventId, zoneID: zoneID))
        record[envelopeField] = String(decoding: try encoder.encode(envelope), as: UTF8.self)
        record[streamIdField] = envelope.streamId
        record[createdAtField] = envelope.createdAt
        return record
    }

    static func envelope(from record: CKRecord, decoder: JSONDecoder) -> SyncEnvelope? {
        guard let json = record[envelopeField] as? String else { return nil }
        return try? decoder.decode(SyncEnvelope.self, from: Data(json.utf8))
    }

    /// `""` or an unreadable cursor means "from the beginning", never a crash:
    /// re-reading everything is safe under last-writer-wins.
    static func token(from cursor: String) -> CKServerChangeToken? {
        guard !cursor.isEmpty, let data = Data(base64Encoded: cursor) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: CKServerChangeToken.self, from: data)
    }

    static func cursor(from token: CKServerChangeToken?) -> String? {
        guard let token,
              let data = try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true)
        else { return nil }
        return data.base64EncodedString()
    }

    static func chunks<T>(_ items: [T], size: Int) -> [[T]] {
        guard size > 0, !items.isEmpty else { return items.isEmpty ? [] : [items] }
        return stride(from: 0, to: items.count, by: size).map {
            Array(items[$0..<min($0 + size, items.count)])
        }
    }

    /// Maps a CloudKit error onto the engine's failure kinds, so a full iCloud
    /// or a signed-out device backs the poller off the way a relay's 413 or 401
    /// does. Anything unrecognised retries at the normal cadence.
    static func failure(for error: Error) -> SyncTransportFailure {
        if let failure = error as? SyncTransportFailure { return failure }
        guard let ck = error as? CKError else {
            return SyncTransportFailure(kind: "unreachable", message: error.localizedDescription)
        }
        switch ck.code {
        case .notAuthenticated:
            return SyncTransportFailure(kind: "authRejected", message: "Not signed in to iCloud.")
        case .quotaExceeded:
            return SyncTransportFailure(kind: "quotaExceeded", message: "iCloud storage is full.")
        case .requestRateLimited, .zoneBusy:
            let retry = ck.retryAfterSeconds.map { " Retry in \(Int($0.rounded(.up)))s." } ?? ""
            return SyncTransportFailure(kind: "rateLimited", message: ck.localizedDescription + retry)
        case .serviceUnavailable, .internalError:
            return SyncTransportFailure(kind: "serverError", message: ck.localizedDescription)
        case .limitExceeded, .invalidArguments, .serverRejectedRequest:
            return SyncTransportFailure(kind: "badRequest", message: ck.localizedDescription)
        case .missingEntitlement, .badContainer:
            return SyncTransportFailure(kind: "badRequest",
                                        message: "This build has no iCloud entitlement for the container.")
        case .partialFailure:
            if let inner = ck.partialErrorsByItemID?.values
                .first(where: { ($0 as? CKError)?.code != .serverRecordChanged }) {
                return failure(for: inner)
            }
            return SyncTransportFailure(kind: "unreachable", message: ck.localizedDescription)
        default:
            return SyncTransportFailure(kind: "unreachable", message: ck.localizedDescription)
        }
    }
}
#endif
