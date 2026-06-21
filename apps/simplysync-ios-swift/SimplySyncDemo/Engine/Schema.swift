import Foundation

/// A schema column type — the Swift port of the engine's typed-schema DSL
/// (`id`, `NonEmptyString`, `FiniteNumber`, `nullOr`, …). Each column knows its
/// SQLite storage kind and how to validate a value on write. `validate` is only
/// ever handed a non-null value; nullability is enforced separately so a `null`
/// into a non-nullable column is a uniform error.
struct Column {
    let name: String
    let sqlite: String // "text" | "integer" | "real" | "blob"
    let nullable: Bool
    /// Returns an error message, or nil if the (non-null) value is acceptable.
    let validate: (JSONValue) -> String?

    init(name: String, sqlite: String, nullable: Bool = false,
         validate: @escaping (JSONValue) -> String?) {
        self.name = name
        self.sqlite = sqlite
        self.nullable = nullable
        self.validate = validate
    }

    // ----- Strings -----------------------------------------------------------

    static let string = Column(name: "String", sqlite: "text") { v in
        if case .string = v { return nil }
        return "Expected a string."
    }

    static let nonEmptyString = Column(name: "NonEmptyString", sqlite: "text") { v in
        guard case .string(let s) = v else { return "Expected a string." }
        return s.isEmpty ? "Expected a non-empty string." : nil
    }

    static let nonEmptyString1000 = Column(name: "NonEmptyString1000", sqlite: "text") { v in
        guard case .string(let s) = v else { return "Expected a string." }
        return (s.isEmpty || s.count > 1000) ? "Expected a string of 1–1000 characters." : nil
    }

    // ----- Numbers -----------------------------------------------------------

    static let positiveInt = Column(name: "PositiveInt", sqlite: "integer") { v in
        if case .int(let n) = v, n > 0 { return nil }
        return "Expected a positive integer."
    }

    static let finiteNumber = Column(name: "FiniteNumber", sqlite: "real") { v in
        switch v {
        case .int: return nil
        case .double(let d): return d.isFinite ? nil : "Expected a finite number."
        default: return "Expected a finite number."
        }
    }

    // ----- SQLite boolean (0 | 1) -------------------------------------------

    static let sqliteBoolean = Column(name: "SqliteBoolean", sqlite: "integer") { v in
        switch v {
        case .bool: return nil
        case .int(let n) where n == 0 || n == 1: return nil
        default: return "Expected a SQLite boolean (0 or 1)."
        }
    }

    // ----- Names -------------------------------------------------------------

    static let simpleName = Column(name: "SimpleName", sqlite: "text") { v in
        guard case .string(let s) = v else { return "Expected a string." }
        let ok = !s.isEmpty && s.count <= 64 &&
            s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        return ok ? nil : "Expected a simple name ([A-Za-z0-9-], 1–64 chars)."
    }

    /// A valid BIP39 recovery phrase column (uses the Kit's BIP39 validator).
    static let mnemonic = Column(name: "Mnemonic", sqlite: "text") { v in
        guard case .string(let s) = v, BIP39.isValid(s) else {
            return "Expected a valid BIP39 recovery phrase."
        }
        return nil
    }

    // ----- Ids & combinators -------------------------------------------------

    /// An id column for a table, e.g. `.id("category")`. Values are opaque,
    /// stable, non-empty strings.
    static func id(_ table: String) -> Column {
        Column(name: "\(table)Id", sqlite: "text") { v in
            if case .string(let s) = v, !s.isEmpty { return nil }
            return "Expected an id string."
        }
    }

    /// Wraps a column type so it also accepts `null` (the `nullOr` analog).
    static func nullable(_ base: Column) -> Column {
        Column(name: "\(base.name)OrNull", sqlite: base.sqlite, nullable: true, validate: base.validate)
    }

    /// Wraps a string column with a maximum length (the `maxLength` analog).
    static func maxLength(_ max: Int, _ base: Column) -> Column {
        Column(name: "\(base.name)Max\(max)", sqlite: base.sqlite, nullable: base.nullable) { v in
            if let message = base.validate(v) { return message }
            if case .string(let s) = v, s.count > max { return "Expected at most \(max) characters." }
            return nil
        }
    }
}

/// A schema: `{ table: { column: Column } }`. The engine derives one physical
/// SQLite table per entry, adding the system columns (`createdAt`, `updatedAt`,
/// `isDeleted`) to every table automatically.
struct Schema {
    let tables: [String: [String: Column]]

    init(_ tables: [String: [String: Column]]) { self.tables = tables }

    var tableNames: [String] { tables.keys.sorted() }
    func columns(of table: String) -> [String: Column]? { tables[table] }
    func has(_ table: String) -> Bool { tables[table] != nil }
}

/// The SQLite boolean constants, mirroring `sqliteTrue` / `sqliteFalse`.
let sqliteTrue: JSONValue = .int(1)
let sqliteFalse: JSONValue = .int(0)
