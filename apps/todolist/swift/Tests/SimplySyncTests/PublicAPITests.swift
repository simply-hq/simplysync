import Foundation
import XCTest
@testable import SimplySync

final class PublicAPITests: XCTestCase {
    func testCanonicalTodoSchemaCanOpenThroughThePackageAPI() async throws {
        let schema = Schema([
            "todo": [
                "id": .id("todo"),
                "title": .nonEmptyString,
                "done": .sqliteBoolean,
            ],
        ])
        let storage = InMemorySecureStorage()
        let engine = createSync(
            SyncEngineDeps(
                makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
                secureStorage: storage
            )
        )(schema, SyncEngineConfig(name: "swift-package-smoke"))

        await engine.ready
        let inserted = engine.insert("todo", [
            "title": "Buy milk",
            "done": sqliteFalse,
        ])
        XCTAssertTrue(inserted.isOk)
    }

    // `resetAppOwner` wipes local data AND adopts an owner nothing has ever
    // synced, so with no relay to confirm a copy it must refuse rather than
    // destroy the only copy — force stays the app's "the user confirmed" path.
    func testResetRefusesWithoutARelayAndSucceedsUnderForce() async throws {
        let schema = Schema(["note": ["id": .id("note"), "body": .nonEmptyString]])
        let engine = createSync(
            SyncEngineDeps(
                makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
                secureStorage: InMemorySecureStorage()
            )
        )(schema, SyncEngineConfig(name: "swift-reset-guard"))
        await engine.ready

        do {
            try await engine.resetAppOwner()
            XCTFail("expected a refusal on a relay-less device")
        } catch let error as EngineError {
            guard case .resetUnsafe(let reason) = error else {
                return XCTFail("expected resetUnsafe, got \(error)")
            }
            XCTAssertTrue(reason.contains("Back up your data first"))
        }

        let before = engine.currentOwner?.id
        try await engine.resetAppOwner(force: true)
        XCTAssertNotEqual(before, engine.currentOwner?.id)
    }

    // The generator is a bit-packing codec written against the spec, not a
    // wrapper: the only check that matters is that it is the exact inverse of
    // the decoder every other port already agrees with.
    func testMnemonicGeneratorRoundTripsThroughTheDecoder() throws {
        let fresh = BIP39.createMnemonic()
        XCTAssertEqual(fresh.split(separator: " ").count, 12)
        XCTAssertTrue(BIP39.isValid(fresh))

        for byteCount in [16, 20, 24, 28, 32] {
            let entropy = Crypto.randomBytes(byteCount)
            let phrase = BIP39.fromEntropy(entropy)
            XCTAssertEqual(phrase.split(separator: " ").count, byteCount * 3 / 4)
            XCTAssertEqual(try BIP39.entropy(from: phrase), entropy)
        }

        // The canonical all-zero vector, so a checksum bug can't pass by being
        // self-consistent with this port's own encoder.
        XCTAssertEqual(
            BIP39.fromEntropy(Data(repeating: 0, count: 16)),
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        )
    }

    func testProtocolPrimitivesArePublicAndRoundTrip() throws {
        let identity = try IdentityDeriver.derive(
            from: "sf1_AQgPFh0kKzI5QEdOVVxjanF4f4aNlJuiqbC3vsXM09o"
        )
        let hlc = HLC.make(deviceId: "swift-package", millis: 1_700_000_000_000)
        let payload = SyncPayload(
            schemaVersion: 1,
            table: "todo",
            op: "upsert",
            rowId: "public-api",
            hlc: hlc,
            value: ["title": "Public API", "done": sqliteFalse]
        )
        let envelope = try Envelope.seal(
            identity: identity,
            eventId: hlc,
            deviceId: "swift-package",
            createdAt: "2026-01-01T00:00:00.000Z",
            payload: payload,
            nonce: Data(repeating: 7, count: 12)
        )

        XCTAssertEqual(
            try Envelope.decrypt(identity: identity, envelope: envelope).rowId,
            "public-api"
        )
    }

    func testHLCAdmissibilityIsStrictAndPublic() {
        let now: Int64 = 1_700_000_000_000
        let canonical = HLC.make(
            deviceId: "device.with-tab-suffix",
            millis: now,
            counter: 35
        )
        XCTAssertEqual(
            HLC.parse(canonical),
            ParsedHLC(millis: now, counter: 35, deviceId: "device.with-tab-suffix")
        )
        for malformed in [
            "garbage",
            "0000000000-000-device",
            "0000000000-00000-device",
            "000000000!-0000-device",
            "0000000000-000!-device",
            "0000000000-0000-",
            "0000000000-0000-device space",
        ] {
            XCTAssertNil(HLC.parse(malformed), malformed)
            XCTAssertEqual(HLC.admissibility(malformed, nowMillis: now), .malformed)
        }
        XCTAssertEqual(
            HLC.admissibility(
                HLC.make(
                    deviceId: "peer",
                    millis: now + HLC.maxFutureDriftMillis
                ),
                nowMillis: now
            ),
            .admissible
        )
        XCTAssertEqual(
            HLC.admissibility(
                HLC.make(
                    deviceId: "peer",
                    millis: now + HLC.maxFutureDriftMillis + 1
                ),
                nowMillis: now
            ),
            .future
        )
    }

    func testRemoteProjectionRejectsMalformedSystemColumns() {
        let schema = Schema([
            "todo": ["id": .id("todo"), "title": .nonEmptyString],
        ])
        let store = Store(schema: schema, config: SyncEngineConfig(name: "validation"))
        let hlc = HLC.make(deviceId: "remote", millis: 1_700_000_000_000)

        let badFlag = store.projectRemoteRow("todo", [
            "id": .string("row"),
            "title": .string("Valid title"),
            "createdAt": .string("2026-01-01T00:00:00.000Z"),
            "updatedAt": .string(hlc),
            "isDeleted": .string("false"),
        ])
        XCTAssertNotNil(badFlag.error)

        let emptyId = store.projectRemoteRow("todo", [
            "id": .string(""),
            "title": .string("Valid title"),
            "createdAt": .string("2026-01-01T00:00:00.000Z"),
            "updatedAt": .string(hlc),
            "isDeleted": .int(0),
        ])
        XCTAssertNotNil(emptyId.error)
    }

    func testCompareAndSetRejectsAStaleEditorSnapshot() async throws {
        struct Snapshot: Decodable {
            let id: String
            let title: String
            let updatedAt: String
        }

        let schema = Schema([
            "todo": ["id": .id("todo"), "title": .nonEmptyString],
        ])
        let engine = createSync(
            SyncEngineDeps(
                makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
                secureStorage: InMemorySecureStorage()
            )
        )(schema, SyncEngineConfig(name: "swift-cas"))
        await engine.ready
        let inserted = engine.insert("todo", ["title": "original"])
        let id = try XCTUnwrap(inserted.id)
        let query = engine.createQuery(
            "select id, title, updatedAt from \"todo\" where id = ?",
            [.text(id)],
            as: Snapshot.self
        )
        let version = try XCTUnwrap(engine.loadQuery(query).first?.updatedAt)

        XCTAssertTrue(
            engine.update(
                "todo", ["id": .string(id), "title": "newer"],
                expectedUpdatedAt: version
            ).isOk
        )
        let stale = engine.update(
            "todo", ["id": .string(id), "title": "stale overwrite"],
            expectedUpdatedAt: version
        )

        XCTAssertFalse(stale.isOk)
        XCTAssertTrue(stale.errorMessage?.contains("Write conflict") == true)
        XCTAssertEqual(engine.loadQuery(query).first?.title, "newer")
    }

    func testRestoreCompareAndSetsTheExactTombstone() async throws {
        struct Snapshot: Decodable {
            let id: String
            let updatedAt: String
            let isDeleted: Int
        }

        let schema = Schema([
            "todo": ["id": .id("todo"), "title": .nonEmptyString],
        ])
        let engine = createSync(
            SyncEngineDeps(
                makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
                secureStorage: InMemorySecureStorage()
            )
        )(schema, SyncEngineConfig(name: "swift-restore-cas"))
        await engine.ready
        let inserted = engine.insert("todo", ["title": "restore me"])
        let id = try XCTUnwrap(inserted.id)
        let query = engine.createQuery(
            "select id, updatedAt, isDeleted from \"todo\" where id = ?",
            [.text(id)],
            as: Snapshot.self
        )
        let liveVersion = try XCTUnwrap(engine.loadQuery(query).first?.updatedAt)
        XCTAssertTrue(engine.delete(
            "todo", id: id, expectedUpdatedAt: liveVersion).isOk)
        let tombstoneVersion = try XCTUnwrap(engine.loadQuery(query).first?.updatedAt)

        XCTAssertTrue(engine.restore(
            "todo", id: id, expectedUpdatedAt: tombstoneVersion).isOk)
        XCTAssertEqual(engine.loadQuery(query).first?.isDeleted, 0)

        let staleRestore = engine.restore(
            "todo", id: id, expectedUpdatedAt: tombstoneVersion)
        XCTAssertFalse(staleRestore.isOk)
        XCTAssertTrue(staleRestore.errorMessage?.contains("Write conflict") == true)
    }

    func testAsyncBatchCommitsWithoutRequiringCallerThreadWork() async throws {
        struct Snapshot: Decodable {
            let title: String
        }

        let schema = Schema([
            "todo": ["id": .id("todo"), "title": .nonEmptyString],
        ])
        let engine = createSync(
            SyncEngineDeps(
                makeDriver: { _ in try SQLite3Driver(path: ":memory:") },
                secureStorage: InMemorySecureStorage()
            )
        )(schema, SyncEngineConfig(name: "swift-async-batch"))
        await engine.ready

        let result = await engine.batchAsync { batch in
            batch.insert("todo", ["id": "async-a", "title": "A"])
            batch.insert("todo", ["id": "async-b", "title": "B"])
        }

        XCTAssertTrue(result.isOk)
        let query = engine.createQuery(
            "select title from \"todo\" order by title",
            as: Snapshot.self
        )
        XCTAssertEqual(engine.loadQuery(query).map(\.title), ["A", "B"])
    }
}
