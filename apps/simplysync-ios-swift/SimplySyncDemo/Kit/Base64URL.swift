import Foundation

/// base64url (RFC 4648 §5, no padding) — the only encoding simplysync puts on
/// the wire. Mirrors @simplysync/protocol's base64UrlEncode/Decode exactly.
enum Base64URL {
    static func encode(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-")
        s = s.replacingOccurrences(of: "/", with: "_")
        s = s.replacingOccurrences(of: "=", with: "")
        return s
    }

    static func encode(_ bytes: [UInt8]) -> String { encode(Data(bytes)) }

    static func decode(_ value: String) -> Data? {
        var s = value.replacingOccurrences(of: "-", with: "+")
        s = s.replacingOccurrences(of: "_", with: "/")
        // Re-pad to a multiple of 4.
        let remainder = s.count % 4
        if remainder > 0 {
            s += String(repeating: "=", count: 4 - remainder)
        }
        return Data(base64Encoded: s)
    }
}
