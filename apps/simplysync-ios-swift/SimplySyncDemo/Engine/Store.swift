import Foundation

/// The local SQLite layer — the Swift port of the engine's store: physical schema
/// creation (with the system columns every row carries), the `_sync_*` tables,
/// the `_sync_meta` key/value store, row upserts, and value coercion against the
/// typed schema. Not internally locked — the engine serializes all access.
final class Store {
    static let outboxTable = "_sync_outbox"
    static let seenTable = "_sync_seen"
    static let metaTable = "_sync_meta"

    private let schema: Schema
    private let config: SyncEngineConfig
    var driver: SqliteDriver?

    init(schema: Schema, config: SyncEngineConfig) {
        self.schema = schema
        self.config = config
    }

    /// Creates one physical table per schema entry — `id` primary key, the typed
    /// columns, then the three system columns — plus the sync bookkeeping tables.
    func ensureSchema() throws {
        guard let driver else { return }
        try driver.exec("pragma journal_mode = WAL;")
        for table in schema.tableNames {
            let columns = schema.columns(of: table) ?? [:]
            var defs = ["\"id\" text primary key"]
            for name in columns.keys.sorted() where name != "id" {
                defs.append("\"\(name)\" \(columns[name]!.sqlite)")
            }
            defs.append("\"createdAt\" text")
            defs.append("\"updatedAt\" text")
            defs.append("\"isDeleted\" integer default 0")
            try driver.exec("create table if not exists \"\(table)\" (\(defs.joined(separator: ", ")));")
        }
        for index in config.indexes where !index.table.isEmpty && !index.columns.isEmpty {
            let cols = index.columns.map { "\"\($0)\"" }.joined(separator: ", ")
            try driver.exec("create index if not exists \"\(index.name)\" on \"\(index.table)\" (\(cols));")
        }
        try driver.exec("create table if not exists \"\(Self.outboxTable)\" (event_id text primary key, envelope_json text not null, pushed_at text);")
        try driver.exec("create table if not exists \"\(Self.seenTable)\" (event_id text primary key);")
        try driver.exec("create table if not exists \"\(Self.metaTable)\" (key text primary key, value text not null);")
    }

    func getMeta(_ key: String) -> String? {
        guard let driver, let rows = try? driver.select(
            "select value from \"\(Self.metaTable)\" where key = ?", [.text(key)]),
            case .text(let v)? = rows.first?["value"] else { return nil }
        return v
    }

    func setMeta(_ key: String, _ value: String) {
        try? driver?.exec(
            "insert into \"\(Self.metaTable)\" (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
            [.text(key), .text(value)])
    }

    func wipeLocalData() {
        guard let driver else { return }
        for table in schema.tableNames { try? driver.exec("delete from \"\(table)\"") }
        try? driver.exec("delete from \"\(Self.outboxTable)\"")
        try? driver.exec("delete from \"\(Self.seenTable)\"")
        try? driver.exec("delete from \"\(Self.metaTable)\"")
    }

    /// Upsert a full row (`insert … on conflict(id) do update`). Values bind by
    /// their JSON kind.
    func writeRow(_ table: String, _ row: [String: JSONValue]) throws {
        guard let driver else { return }
        let keys = Array(row.keys)
        let cols = keys.map { "\"\($0)\"" }.joined(separator: ", ")
        let placeholders = keys.map { _ in "?" }.joined(separator: ", ")
        let updates = keys.filter { $0 != "id" }
            .map { "\"\($0)\" = excluded.\"\($0)\"" }.joined(separator: ", ")
        let sql = "insert into \"\(table)\" (\(cols)) values (\(placeholders)) on conflict(\"id\") do update set \(updates)"
        try driver.exec(sql, keys.map { row[$0]!.sqliteBound })
    }

    /// Validate + collect the columns present in `values` against the schema.
    /// Returns the coerced row, or the first validation error.
    func coerceValues(_ table: String, _ values: [String: JSONValue]) -> (row: [String: JSONValue], error: String?) {
        var row: [String: JSONValue] = [:]
        for (name, type) in schema.columns(of: table) ?? [:] {
            guard let value = values[name] else { continue }
            if value.isNull {
                if type.nullable { row[name] = .null; continue }
                return (row, "\(table).\(name): \(type.name) must not be null.")
            }
            if let message = type.validate(value) {
                return (row, "\(table).\(name): \(message)")
            }
            row[name] = value
        }
        return (row, nil)
    }

    /// Read one row by id (system columns included), or nil.
    func readRow(_ table: String, id: String) -> SQLiteRow? {
        try? driver?.select("select * from \"\(table)\" where id = ?", [.text(id)]).first
    }
}

/// The hybrid logical clock — the Swift port of the engine's clock. Persists its
/// high-water mark to `_sync_meta` so it stays monotonic across restarts, and
/// `observe` absorbs the physical time of every remote HLC pulled (the HLC
/// "receive" step) so a later local write can never sort below an edit we've seen.
final class Clock {
    private let store: Store
    let deviceId: String
    private(set) var time: Int64 = 0
    private(set) var counter: Int = 0

    init(store: Store, deviceId: String) {
        self.store = store
        self.deviceId = deviceId
    }

    /// Re-seed the in-memory high-water mark from persisted metadata (on boot).
    func seedFromMeta() {
        time = Int64(store.getMeta("hlc:time") ?? "0") ?? 0
        counter = Int(store.getMeta("hlc:counter") ?? "0") ?? 0
    }

    private func persist() {
        store.setMeta("hlc:time", String(time))
        store.setMeta("hlc:counter", String(counter))
    }

    func nextHlc() -> String {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let nextTime = max(now, time)
        counter = nextTime == time ? counter + 1 : 0
        time = nextTime
        persist()
        return HLC.make(deviceId: deviceId, millis: nextTime, counter: counter)
    }

    func observe(_ remote: String) {
        let parts = remote.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].count == 10,
              let millis = Int64(parts[0], radix: 36) else { return }
        let c = Int(parts[1], radix: 36) ?? 0
        if millis > time { time = millis; counter = c }
        else if millis == time && c > counter { counter = c }
        else { return }
        persist()
    }
}
