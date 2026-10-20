#if canImport(CloudKit)
import CloudKit
import XCTest

@testable import SimplySync

// Everything here runs without an iCloud account or entitlement: no test
// creates a `CKContainer`. The live push/pull path needs a signed-in device.
final class CloudKitTransportTests: XCTestCase {
    private let zone = CloudKitTransport.zoneID(forOwner: "owner-1", prefix: "simplysync-")

    func testARecordCarriesTheEnvelopeUnchanged() throws {
        let envelope = SyncEnvelope(
            version: 1, ownerId: "owner-1", eventId: "0000000001-0000-dev",
            deviceId: "dev", nonce: "bm9uY2U", ciphertext: "Y2lwaGVy",
            createdAt: "2026-10-19T00:00:00.000Z", streamId: "stream-1")
        let record = try CloudKitTransport.record(for: envelope, zoneID: zone, encoder: JSONEncoder())

        XCTAssertEqual(record.recordType, "SyncEvent")
        XCTAssertEqual(record.recordID.recordName, envelope.eventId, "eventId is the dedupe key")
        XCTAssertEqual(record.recordID.zoneID.zoneName, "simplysync-owner-1")
        let back = try XCTUnwrap(CloudKitTransport.envelope(from: record, decoder: JSONDecoder()))
        XCTAssertEqual(back.ciphertext, envelope.ciphertext)
        XCTAssertEqual(back.nonce, envelope.nonce)
        XCTAssertEqual(back.streamId, envelope.streamId)
    }

    func testAnUnreadableCursorRestartsFromTheBeginning() {
        XCTAssertNil(CloudKitTransport.token(from: ""))
        XCTAssertNil(CloudKitTransport.token(from: "not base64 !"))
        XCTAssertNil(CloudKitTransport.token(from: Data("junk".utf8).base64EncodedString()))
        XCTAssertNil(CloudKitTransport.cursor(from: nil))
    }

    func testPushesAreChunkedUnderTheOperationCap() {
        let sizes = CloudKitTransport.chunks(Array(0..<901), size: 400).map(\.count)
        XCTAssertEqual(sizes, [400, 400, 101])
        XCTAssertEqual(CloudKitTransport.chunks([Int](), size: 400).count, 0)
    }

    func testCloudKitErrorsMapOntoTheEngineFailureKinds() {
        func kind(_ code: CKError.Code) -> String { CloudKitTransport.failure(for: CKError(code)).kind }
        XCTAssertEqual(kind(.notAuthenticated), "authRejected")
        XCTAssertEqual(kind(.quotaExceeded), "quotaExceeded")
        XCTAssertEqual(kind(.requestRateLimited), "rateLimited")
        XCTAssertEqual(kind(.serviceUnavailable), "serverError")
        XCTAssertEqual(kind(.missingEntitlement), "badRequest")
        XCTAssertEqual(kind(.networkUnavailable), "unreachable")

        // A batch that failed only on already-parked records plus one real
        // error reports the real error, not the duplicates.
        let partial = CKError(.partialFailure, userInfo: [CKPartialErrorsByItemIDKey: [
            CKRecord.ID(recordName: "a", zoneID: zone): CKError(.serverRecordChanged),
            CKRecord.ID(recordName: "b", zoneID: zone): CKError(.quotaExceeded),
        ]])
        XCTAssertEqual(CloudKitTransport.failure(for: partial).kind, "quotaExceeded")
    }

    func testTheFactoryLeavesRelaysToTheRelayClient() throws {
        let identity = try IdentityDeriver.derive(from: IdentityDeriver.createRecoveryKey())
        let factory = CloudKitTransport.factory(containerIdentifier: "iCloud.com.example.app")
        XCTAssertNil(factory("https://relay.example.com", identity))
        XCTAssertEqual(CloudKitTransport.base, "icloud")
    }
}
#endif
