import Foundation
import XCTest
@testable import SimplySync

final class BlobTests: XCTestCase {
    // Encrypted by @simplysync/protocol's encryptBlob (chunkSize 4): Swift must
    // verify and decrypt TS chunks byte for byte, so the AAD, nonce layout and
    // hashes agree across ports.
    func testDecryptsABlobEncryptedByTypeScript() throws {
        let identity = try IdentityDeriver.derive(from: "sf1_AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA")
        let manifest = try JSONDecoder().decode(BlobManifest.self, from: Data("""
            {"version":1,"ownerId":"xWDXbzuCnTq90fEC-tDaxA","blobId":"blob-vector","mimeType":"text/plain","byteSize":11,"chunkSize":4,"chunks":[{"hash":"In9OUdcMMvE_cLPtTSwgS6DeENjaZOWCr5-A89mz8Vc","size":32,"plaintextSize":4},{"hash":"Y15UTzAJiHWq3bSR23CANhMWNIg81mHUDeOMvTbj8C4","size":32,"plaintextSize":4},{"hash":"NpMqVXFbEKfbvzMf4lu0pR2SzjXz53KHYf5o_7DlRwI","size":31,"plaintextSize":3}],"sha256":"1AnSdpuu8Af02LWytGiFQ0tGlW_smN5UNgrZzQjLIAQ","createdAt":"2026-10-30T00:00:00.000Z"}
            """.utf8))
        let chunks = ["OgGr3zIiru0RXZIYz_IDzs42GskOBtJ2qI78WUDaFy4",
                      "b457qHoIZtdGxYEy39ezrN0Phe_ngzLFv9cefOyLYv8",
                      "tOiAMqC5KsevxMgzt53phwf7Mp2ige4EJlhBMMQ8xA"].map { Base64URL.decode($0)! }
        let data = try Blob.decrypt(chunks, manifest: manifest, identity: identity)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "hello blob!")
    }

    func testRoundTripsAndRejectsTampering() throws {
        let identity = try IdentityDeriver.derive(from: IdentityDeriver.createRecoveryKey())
        let data = Crypto.randomBytes(700_000)
        let blob = try Blob.encrypt(data, identity: identity, mimeType: "image/png")
        XCTAssertEqual(blob.manifest.chunks.count, 3) // ceil(700000 / 262144)
        XCTAssertEqual(blob.manifest.chunks[0].size, Blob.defaultChunkBytes + 12 + 16)
        XCTAssertEqual(try Blob.decrypt(blob.chunks.map(\.bytes), manifest: blob.manifest, identity: identity), data)

        var tampered = blob.chunks.map(\.bytes)
        tampered[1][tampered[1].startIndex + 20] ^= 1
        XCTAssertThrowsError(try Blob.decrypt(tampered, manifest: blob.manifest, identity: identity)) {
            XCTAssertEqual($0 as? BlobError, .chunkHashMismatch)
        }
        let other = try IdentityDeriver.derive(from: IdentityDeriver.createRecoveryKey())
        XCTAssertThrowsError(try Blob.decrypt(blob.chunks.map(\.bytes), manifest: blob.manifest, identity: other))
    }
}
