import Foundation

/// A JSON value with deterministic, JS-`JSON.stringify`-compatible serialization
/// and recursively sorted object keys — the exact bytes the protocol feeds to
/// AES-GCM as additional authenticated data (`canonicalJson`).
///
/// Key ordering uses Swift's `<` (Unicode scalar order). The protocol only ever
/// canonicalizes lowercase-ASCII keys (header fields, payload fields, and your
/// column names), for which scalar order matches JS's code-unit order
/// (`canonicalJson`'s `<` key sort). Keep app
/// column names lowercase-ASCII to stay compatible.
public indirect enum JSONValue {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    public func canonical() -> String {
        switch self {
        case .string(let s):
            return JSONValue.escape(s)
        case .int(let n):
            return String(n)
        case .double(let d):
            // Integers-as-doubles render without a fractional part, like JS.
            if d == d.rounded() && abs(d) < 1e15 {
                return String(Int64(d))
            }
            return String(d)
        case .bool(let b):
            return b ? "true" : "false"
        case .null:
            return "null"
        case .array(let items):
            return "[" + items.map { $0.canonical() }.joined(separator: ",") + "]"
        case .object(let dict):
            let parts = dict.keys.sorted().map { key in
                JSONValue.escape(key) + ":" + dict[key]!.canonical()
            }
            return "{" + parts.joined(separator: ",") + "}"
        }
    }

    public func canonicalData() -> Data { Data(canonical().utf8) }

    /// Builds a `JSONValue` from a Foundation JSON object (`JSONSerialization`
    /// output). Distinguishes booleans from numbers via the `NSNumber` objCType.
    public static func from(_ any: Any) -> JSONValue {
        switch any {
        case let s as String:
            return .string(s)
        case let n as NSNumber:
            if String(cString: n.objCType) == "c" { return .bool(n.boolValue) }
            if CFNumberIsFloatType(n) { return .double(n.doubleValue) }
            return .int(n.intValue)
        case let arr as [Any]:
            return .array(arr.map { from($0) })
        case let obj as [String: Any]:
            return .object(obj.mapValues { from($0) })
        case is NSNull:
            return .null
        default:
            return .null
        }
    }

    /// JSON string escaping matching `JSON.stringify`: escapes `"` and `\`, the
    /// short escapes (\b \t \n \f \r), and other control chars as `\u00xx`
    /// (lowercase hex). Forward slashes and non-ASCII are left literal.
    public static func escape(_ s: String) -> String {
        var out = "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{09}": out += "\\t"
            case "\u{0A}": out += "\\n"
            case "\u{0C}": out += "\\f"
            case "\u{0D}": out += "\\r"
            default:
                if scalar.value < 0x20 {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }
}
