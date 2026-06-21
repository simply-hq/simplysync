import Foundation
import Combine

/// A compiled query — raw SQL plus bound parameters and the row type to decode
/// into. Build one with `engine.createQuery(...)`. The SQL is run on demand and
/// the result is cached and kept reactive. Reference schema tables with double
/// quotes (e.g. `from "todo"`) so the cache can tell which writes affect it.
struct Query<Row: Decodable> {
    let sql: String
    let parameters: [SQLiteValue]

    init(_ sql: String, _ parameters: [SQLiteValue] = []) {
        self.sql = sql
        self.parameters = parameters
    }

    var key: String { QueryCache.key(sql: sql, parameters: parameters) }
}

/// The reactive query cache — the Swift port of the engine's query cache. Each
/// distinct `sql::params` is cached with a stable raw-rows array; a
/// mutation/sync calls `refreshQueries(changedTables)`, which re-runs only the
/// queries whose tables overlap and fires their listeners. Not internally locked
/// — the engine serializes all access.
final class QueryCache {
    private final class Entry {
        let sql: String
        let parameters: [SQLiteValue]
        let tables: Set<String>
        var rows: [SQLiteRow]
        var listeners: [UUID: () -> Void] = [:]
        init(sql: String, parameters: [SQLiteValue], tables: Set<String>, rows: [SQLiteRow]) {
            self.sql = sql; self.parameters = parameters; self.tables = tables; self.rows = rows
        }
    }

    private let store: Store
    private let schema: Schema
    private var entries: [String: Entry] = [:]
    var schemaReady = false
    var onError: ((String) -> Void)?
    private var reportedError = false

    init(store: Store, schema: Schema) {
        self.store = store
        self.schema = schema
    }

    static func key(sql: String, parameters: [SQLiteValue]) -> String {
        sql + "::" + parameters.map(describe).joined(separator: ",")
    }

    private static func describe(_ v: SQLiteValue) -> String {
        switch v {
        case .text(let s): return "t:\(s)"
        case .integer(let n): return "i:\(n)"
        case .real(let d): return "r:\(d)"
        case .blob(let d): return "b:\(d.count)"
        case .null: return "n"
        }
    }

    private func tablesInSql(_ sql: String) -> Set<String> {
        var found: Set<String> = []
        for table in schema.tableNames where sql.contains("\"\(table)\"") { found.insert(table) }
        return found
    }

    private func runQuery(_ sql: String, _ params: [SQLiteValue]) -> [SQLiteRow] {
        guard let driver = store.driver else { return [] }
        do {
            return try driver.select(sql, params)
        } catch {
            // Before the schema exists, tables may be missing — treat as empty.
            // After, a failure is a real DB error: surface it once.
            if schemaReady {
                if !reportedError {
                    reportedError = true
                    onError?(error.localizedDescription)
                }
            }
            return []
        }
    }

    private func entry<Row>(for query: Query<Row>) -> Entry {
        let key = query.key
        if let existing = entries[key] { return existing }
        let entry = Entry(
            sql: query.sql,
            parameters: query.parameters,
            tables: tablesInSql(query.sql),
            rows: store.driver != nil ? runQuery(query.sql, query.parameters) : [])
        entries[key] = entry
        return entry
    }

    func rawRows<Row>(_ query: Query<Row>) -> [SQLiteRow] { entry(for: query).rows }

    /// Eager re-read: re-run now and refresh the cached entry if present.
    func loadRawRows<Row>(_ query: Query<Row>) -> [SQLiteRow] {
        let rows = runQuery(query.sql, query.parameters)
        entries[query.key]?.rows = rows
        return rows
    }

    func refreshQueries(_ changedTables: Set<String>) {
        for entry in entries.values where !entry.tables.isDisjoint(with: changedTables) {
            entry.rows = runQuery(entry.sql, entry.parameters)
            for listener in entry.listeners.values { listener() }
        }
    }

    /// Refresh every cached query (used after restore/reset wipes/replaces data).
    func refreshAll() { refreshQueries(Set(schema.tableNames)) }

    func subscribe<Row>(_ query: Query<Row>, _ listener: @escaping () -> Void) -> () -> Void {
        let entry = entry(for: query)
        let id = UUID()
        entry.listeners[id] = listener
        let key = query.key
        return { [weak self] in
            guard let self, let entry = self.entries[key] else { return }
            entry.listeners[id] = nil
            if entry.listeners.isEmpty { self.entries[key] = nil }
        }
    }
}

/// A reactive query result — the Swift analog of React's `useQuery`. Observe it
/// from SwiftUI (`@StateObject` / `@ObservedObject`); `rows` is republished on
/// the main thread whenever a local write or an incoming sync changes the data
/// this query depends on.
final class LiveQuery<Row: Decodable>: ObservableObject {
    @Published private(set) var rows: [Row]
    fileprivate var unsubscribe: (() -> Void)?
    private let reload: () -> [Row]

    fileprivate init(initial: [Row], reload: @escaping () -> [Row]) {
        self.rows = initial
        self.reload = reload
    }

    fileprivate func refresh() {
        let next = reload()
        if Thread.isMainThread {
            rows = next
        } else {
            DispatchQueue.main.async { [weak self] in self?.rows = next }
        }
    }

    func makeLive(_ subscribe: (@escaping () -> Void) -> (() -> Void)) {
        unsubscribe = subscribe { [weak self] in self?.refresh() }
    }

    deinit { unsubscribe?() }
}

extension LiveQuery {
    static func make(initial: [Row], reload: @escaping () -> [Row]) -> LiveQuery<Row> {
        LiveQuery(initial: initial, reload: reload)
    }
}
