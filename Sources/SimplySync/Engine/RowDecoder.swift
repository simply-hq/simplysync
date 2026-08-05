import Foundation

/// Decodes a `SQLiteRow` into a `Decodable` struct, so query results come back as
/// plain typed rows (`engine.loadQuery(q)` → `[TodoRow]`) — the Swift analog of
/// the engine's inferred Kysely row types. Supports the scalar column kinds
/// (String, Int/Int64, Double, Bool) and their optionals, plus scalar-backed
/// `RawRepresentable` enums.
enum RowDecoder {
    static func decode<T: Decodable>(_ type: T.Type, from row: SQLiteRow) throws -> T {
        try T(from: _RowDecoder(row: row))
    }
}

private struct _RowDecoder: Decoder {
    let row: SQLiteRow
    var codingPath: [CodingKey] = []
    var userInfo: [CodingUserInfoKey: Any] = [:]

    func container<Key: CodingKey>(keyedBy: Key.Type) -> KeyedDecodingContainer<Key> {
        KeyedDecodingContainer(KeyedRow<Key>(row: row, codingPath: codingPath))
    }
    func unkeyedContainer() throws -> UnkeyedDecodingContainer {
        throw DecodingError.typeMismatch([Any].self, .init(codingPath: codingPath,
            debugDescription: "A SQLite row decodes to a keyed container, not an array."))
    }
    func singleValueContainer() throws -> SingleValueDecodingContainer {
        throw DecodingError.typeMismatch(Any.self, .init(codingPath: codingPath,
            debugDescription: "A SQLite row decodes to a keyed container."))
    }
}

private struct KeyedRow<Key: CodingKey>: KeyedDecodingContainerProtocol {
    let row: SQLiteRow
    var codingPath: [CodingKey]
    var allKeys: [Key] { row.keys.compactMap { Key(stringValue: $0) } }

    func contains(_ key: Key) -> Bool { row[key.stringValue] != nil }

    func decodeNil(forKey key: Key) throws -> Bool {
        guard let v = row[key.stringValue] else { return true }
        return v == .null
    }

    private func cell(_ key: Key) throws -> SQLiteValue {
        guard let v = row[key.stringValue], v != .null else {
            throw DecodingError.valueNotFound(Any.self, .init(codingPath: codingPath + [key],
                debugDescription: "No value for column \"\(key.stringValue)\"."))
        }
        return v
    }

    func decode(_: String.Type, forKey key: Key) throws -> String {
        switch try cell(key) {
        case .text(let s): return s
        case .integer(let n): return String(n)
        case .real(let d): return String(d)
        default: return ""
        }
    }
    func decode(_: Bool.Type, forKey key: Key) throws -> Bool {
        switch try cell(key) {
        case .integer(let n): return n != 0
        case .real(let d): return d != 0
        case .text(let s): return s == "1" || s.lowercased() == "true"
        default: return false
        }
    }
    func decode(_: Double.Type, forKey key: Key) throws -> Double { try asDouble(key) }
    func decode(_: Float.Type, forKey key: Key) throws -> Float { Float(try asDouble(key)) }
    func decode(_: Int.Type, forKey key: Key) throws -> Int { Int(try asInt(key)) }
    func decode(_: Int64.Type, forKey key: Key) throws -> Int64 { try asInt(key) }
    func decode(_: Int32.Type, forKey key: Key) throws -> Int32 { Int32(try asInt(key)) }

    func decode<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T {
        // Route scalar-backed types (incl. RawRepresentable enums) through a
        // single-value decoder over this one cell.
        try T(from: SingleValueRow(value: try cell(key), codingPath: codingPath + [key]))
    }

    func nestedContainer<NK: CodingKey>(keyedBy: NK.Type, forKey key: Key) throws -> KeyedDecodingContainer<NK> {
        throw unsupported(key)
    }
    func nestedUnkeyedContainer(forKey key: Key) throws -> UnkeyedDecodingContainer { throw unsupported(key) }
    func superDecoder() throws -> Decoder { _RowDecoder(row: row) }
    func superDecoder(forKey key: Key) throws -> Decoder { _RowDecoder(row: row) }

    private func asInt(_ key: Key) throws -> Int64 {
        switch try cell(key) {
        case .integer(let n): return n
        case .real(let d): return Int64(d)
        case .text(let s): return Int64(s) ?? 0
        default: return 0
        }
    }
    private func asDouble(_ key: Key) throws -> Double {
        switch try cell(key) {
        case .real(let d): return d
        case .integer(let n): return Double(n)
        case .text(let s): return Double(s) ?? 0
        default: return 0
        }
    }
    private func unsupported(_ key: Key) -> DecodingError {
        DecodingError.dataCorrupted(.init(codingPath: codingPath + [key],
            debugDescription: "Nested containers aren't supported in a SQLite row."))
    }
}

private struct SingleValueRow: Decoder, SingleValueDecodingContainer {
    let value: SQLiteValue
    var codingPath: [CodingKey]
    var userInfo: [CodingUserInfoKey: Any] = [:]

    func container<Key: CodingKey>(keyedBy: Key.Type) throws -> KeyedDecodingContainer<Key> {
        throw fail("keyed")
    }
    func unkeyedContainer() throws -> UnkeyedDecodingContainer { throw fail("unkeyed") }
    func singleValueContainer() throws -> SingleValueDecodingContainer { self }

    func decodeNil() -> Bool { value == .null }
    func decode(_: String.Type) throws -> String { if case .text(let s) = value { return s }; throw fail("String") }
    func decode(_: Bool.Type) throws -> Bool {
        if case .integer(let n) = value { return n != 0 }
        if case .real(let d) = value { return d != 0 }
        throw fail("Bool")
    }
    func decode(_: Double.Type) throws -> Double {
        if case .real(let d) = value { return d }
        if case .integer(let n) = value { return Double(n) }
        throw fail("Double")
    }
    func decode(_: Float.Type) throws -> Float { Float(try decode(Double.self)) }
    func decode(_: Int.Type) throws -> Int { Int(try int()) }
    func decode(_: Int64.Type) throws -> Int64 { try int() }
    func decode(_: Int32.Type) throws -> Int32 { Int32(try int()) }
    func decode<T: Decodable>(_ type: T.Type) throws -> T { try T(from: self) }

    private func int() throws -> Int64 {
        if case .integer(let n) = value { return n }
        if case .real(let d) = value { return Int64(d) }
        throw fail("Int")
    }
    private func fail(_ what: String) -> DecodingError {
        DecodingError.typeMismatch(Any.self, .init(codingPath: codingPath,
            debugDescription: "Cannot decode \(what) from SQLite value \(value)."))
    }
}
