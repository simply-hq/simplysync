import Foundation

/// The value type for column values in mutations and decrypted payloads — the
/// same `JSONValue` the Kit canonicalizes into envelopes. The literal
/// conformances below are what give the engine its React-like write DX, so you
/// can pass `["title": "Buy milk", "done": false, "amountCents": -450]` directly
/// as `[String: SyncValue]`.
typealias SyncValue = JSONValue

extension JSONValue: ExpressibleByStringLiteral {
    init(stringLiteral value: String) { self = .string(value) }
}
extension JSONValue: ExpressibleByIntegerLiteral {
    init(integerLiteral value: Int) { self = .int(value) }
}
extension JSONValue: ExpressibleByFloatLiteral {
    init(floatLiteral value: Double) { self = .double(value) }
}
extension JSONValue: ExpressibleByBooleanLiteral {
    init(booleanLiteral value: Bool) { self = .bool(value) }
}
extension JSONValue: ExpressibleByNilLiteral {
    init(nilLiteral: ()) { self = .null }
}

extension JSONValue {
    /// How this value binds into SQLite (text / integer / real / null). Nested
    /// arrays/objects fall back to canonical-JSON text.
    var sqliteBound: SQLiteValue {
        switch self {
        case .string(let s): return .text(s)
        case .int(let n): return .integer(Int64(n))
        case .double(let d): return .real(d)
        case .bool(let b): return .integer(b ? 1 : 0)
        case .null: return .null
        case .array, .object: return .text(canonical())
        }
    }

    var isNull: Bool { if case .null = self { return true }; return false }
}
