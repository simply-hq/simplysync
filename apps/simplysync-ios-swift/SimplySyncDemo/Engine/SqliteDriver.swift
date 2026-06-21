import Foundation
import SQLite3

/// A value read from or bound to a SQLite cell. Mirrors SQLite's storage
/// classes; the engine maps `SyncValue` (JSON) to and from these.
enum SQLiteValue: Equatable {
    case text(String)
    case integer(Int64)
    case real(Double)
    case blob(Data)
    case null
}

/// One result row: column name → value.
typealias SQLiteRow = [String: SQLiteValue]

/// A thin synchronous wrapper over a platform SQLite — the Swift port of the
/// engine's `SqliteDriver`. The engine injects one of these (the demo uses the
/// libsqlite3-backed `SQLite3Driver`), so the engine stays storage-agnostic.
protocol SqliteDriver: AnyObject {
    func exec(_ sql: String, _ params: [SQLiteValue]) throws
    func select(_ sql: String, _ params: [SQLiteValue]) throws -> [SQLiteRow]
    func transaction<T>(_ body: () throws -> T) throws -> T
}

extension SqliteDriver {
    func exec(_ sql: String) throws { try exec(sql, []) }
    func select(_ sql: String) throws -> [SQLiteRow] { try select(sql, []) }
}

enum SqliteError: Error, CustomStringConvertible {
    case open(String)
    case prepare(String, sql: String)
    case step(String, sql: String)

    var description: String {
        switch self {
        case .open(let m): return "sqlite open failed: \(m)"
        case .prepare(let m, let sql): return "sqlite prepare failed: \(m) — \(sql)"
        case .step(let m, let sql): return "sqlite step failed: \(m) — \(sql)"
        }
    }
}

/// A libsqlite3-backed driver (no third-party dependency — `import SQLite3` is in
/// the iOS/macOS SDK). Access is serialized with a recursive lock so the engine's
/// background sync loop and foreground writes can't interleave statements.
final class SQLite3Driver: SqliteDriver {
    private var db: OpaquePointer?
    private let lock = NSRecursiveLock()

    // SQLite copies bound text/blobs when handed this sentinel destructor.
    private static let transient = unsafeBitCast(-1, to: (@convention(c) (UnsafeMutableRawPointer?) -> Void).self)

    /// Opens (or creates) a database at `path`. Pass `":memory:"` for an
    /// in-memory database (used by the host tests).
    init(path: String) throws {
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        if sqlite3_open_v2(path, &db, flags, nil) != SQLITE_OK {
            let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "unknown"
            throw SqliteError.open(message)
        }
        sqlite3_busy_timeout(db, 5000)
    }

    deinit { if let db { sqlite3_close_v2(db) } }

    func exec(_ sql: String, _ params: [SQLiteValue]) throws {
        try lock.withLock {
            let stmt = try prepare(sql, params)
            defer { sqlite3_finalize(stmt) }
            let rc = sqlite3_step(stmt)
            if rc != SQLITE_DONE && rc != SQLITE_ROW {
                throw SqliteError.step(String(cString: sqlite3_errmsg(db)), sql: sql)
            }
        }
    }

    func select(_ sql: String, _ params: [SQLiteValue]) throws -> [SQLiteRow] {
        try lock.withLock {
            let stmt = try prepare(sql, params)
            defer { sqlite3_finalize(stmt) }
            var rows: [SQLiteRow] = []
            let columnCount = sqlite3_column_count(stmt)
            while true {
                let rc = sqlite3_step(stmt)
                if rc == SQLITE_DONE { break }
                if rc != SQLITE_ROW {
                    throw SqliteError.step(String(cString: sqlite3_errmsg(db)), sql: sql)
                }
                var row: SQLiteRow = [:]
                for i in 0..<columnCount {
                    let name = String(cString: sqlite3_column_name(stmt, i))
                    row[name] = readColumn(stmt, i)
                }
                rows.append(row)
            }
            return rows
        }
    }

    func transaction<T>(_ body: () throws -> T) throws -> T {
        try lock.withLock {
            try exec("BEGIN")
            do {
                let result = try body()
                try exec("COMMIT")
                return result
            } catch {
                try? exec("ROLLBACK")
                throw error
            }
        }
    }

    // MARK: - internals

    private func prepare(_ sql: String, _ params: [SQLiteValue]) throws -> OpaquePointer? {
        var stmt: OpaquePointer?
        if sqlite3_prepare_v2(db, sql, -1, &stmt, nil) != SQLITE_OK {
            throw SqliteError.prepare(String(cString: sqlite3_errmsg(db)), sql: sql)
        }
        for (i, value) in params.enumerated() {
            let idx = Int32(i + 1)
            switch value {
            case .text(let s): sqlite3_bind_text(stmt, idx, s, -1, Self.transient)
            case .integer(let n): sqlite3_bind_int64(stmt, idx, n)
            case .real(let d): sqlite3_bind_double(stmt, idx, d)
            case .blob(let data):
                _ = data.withUnsafeBytes { sqlite3_bind_blob(stmt, idx, $0.baseAddress, Int32(data.count), Self.transient) }
            case .null: sqlite3_bind_null(stmt, idx)
            }
        }
        return stmt
    }

    private func readColumn(_ stmt: OpaquePointer?, _ i: Int32) -> SQLiteValue {
        switch sqlite3_column_type(stmt, i) {
        case SQLITE_INTEGER: return .integer(sqlite3_column_int64(stmt, i))
        case SQLITE_FLOAT: return .real(sqlite3_column_double(stmt, i))
        case SQLITE_NULL: return .null
        case SQLITE_BLOB:
            if let bytes = sqlite3_column_blob(stmt, i) {
                let count = Int(sqlite3_column_bytes(stmt, i))
                return .blob(Data(bytes: bytes, count: count))
            }
            return .blob(Data())
        default:
            if let c = sqlite3_column_text(stmt, i) { return .text(String(cString: c)) }
            return .null
        }
    }
}
