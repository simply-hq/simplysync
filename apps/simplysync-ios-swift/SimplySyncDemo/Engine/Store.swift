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
            // Additive migration (parity with the TS/Kotlin engines): `create table if
            // not exists` is a no-op on an existing table, so a schema that has grown new
            // columns since the table was created would never get them. Add any missing
            // column — ALTER ADD COLUMN is metadata-only in SQLite and existing rows read
            // NULL until a write backfills them (merges cleanly under LWW). Additive only
            // (no rename/drop) so old and new app versions stay wire-compatible.
            let present = Set(try driver.select("pragma table_info(\"\(table)\")").compactMap {
                row -> String? in
                if case .text(let n)? = row["name"] { return n } else { return nil }
            })
            for name in columns.keys.sorted() where name != "id" && !present.contains(name) {
                try driver.exec("alter table \"\(table)\" add column \"\(name)\" \(columns[name]!.sqlite);")
            }
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

    /// Bound the outbox (a send queue, not an archive; parity with the TS/Kotlin
    /// engines): drop events confirmed delivered to EVERY current relay (event_id
    /// <= the lowest per-relay push cursor). A relay with no cursor yet (just added)
    /// makes the minimum "" so nothing is pruned — it still needs the backlog.
    @discardableResult
    func pruneOutbox(_ relayBases: [String]) -> Int {
        guard let driver, !relayBases.isEmpty else { return 0 }
        let bound = relayBases.map { getMeta("push:\($0)") ?? "" }.min() ?? ""
        if bound.isEmpty { return 0 }
        var count = 0
        if let rows = try? driver.select(
            "select count(*) as c from \"\(Self.outboxTable)\" where event_id <= ?", [.text(bound)]),
            case .integer(let n)? = rows.first?["c"] {
            count = Int(n)
        }
        if count > 0 {
            try? driver.exec("delete from \"\(Self.outboxTable)\" where event_id <= ?", [.text(bound)])
        }
        return count
    }

    /// Reclaim local storage by hard-deleting soft-deleted rows (tombstones) older than
    /// [olderThanMs] (parity with the TS/Kotlin engines). Safe: the grace window lets the
    /// deletion replicate first; when [requirePushed] (relays configured), a tombstone whose
    /// delete event is still pending in the outbox is kept; the relay retains tombstones so
    /// a re-sync re-applies them — synced peers are never resurrected. Returns rows purged.
    @discardableResult
    func purgeDeleted(olderThanMs: Int64, nowMs: Int64, requirePushed: Bool) -> Int {
        guard let driver else { return 0 }
        let cutoff = nowMs - olderThanMs
        var purged = 0
        for table in schema.tableNames {
            guard let rows = try? driver.select(
                "select id, updatedAt from \"\(table)\" where isDeleted = 1") else { continue }
            for row in rows {
                guard case .text(let id)? = row["id"], case .text(let updatedAt)? = row["updatedAt"]
                else { continue }
                // HLC millis = first dash-segment, base36.
                let first = updatedAt.split(separator: "-").first.map(String.init) ?? ""
                guard first.count == 10, let millis = Int64(first, radix: 36) else { continue }
                if millis > cutoff { continue } // too new -> keep
                if requirePushed {
                    if let pending = try? driver.select(
                        "select 1 from \"\(Self.outboxTable)\" where event_id = ? and pushed_at is null limit 1",
                        [.text(updatedAt)]), !pending.isEmpty { continue } // not on the relay yet
                }
                try? driver.exec("delete from \"\(table)\" where id = ?", [.text(id)])
                purged += 1
            }
        }
        return purged
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
///
/// Two guards keep a single bad device from poisoning the whole fleet (plan 010),
/// mirroring the TS engine's `createClock` (`packages/simplysync-engine/src/engine/store.ts`)
/// and the Kotlin port so all four stay convergent:
///  - `maxDriftMillis` bounds how far `observe` will raise the high-water mark
///    for a *remote* time. All of an owner's events come from that owner's own
///    devices, so without a bound one device with a far-future wall clock would
///    mint far-future HLCs that every peer absorbs on pull, permanently detaching
///    the fleet from wall-clock time. 5 minutes is a generous bound on real clock
///    skew (NTP-class drift is seconds, not minutes) while still rejecting
///    "clock reset to year 2099" style corruption. Times beyond it are ignored —
///    same defensive posture as a malformed HLC.
///  - `hlcCounterMax` guards the counter `nextHlc` increments on repeat writes
///    within the same millisecond. `HLC.make` encodes the counter in a fixed
///    4-digit base-36 field; widening it would change every stored HLC's string
///    length and break the fixed-width lexical ordering the whole system relies
///    on. Instead, once the counter would overflow the field, logical time rolls
///    forward by 1ms and the counter resets to 0 — standard HLC "counter rollover
///    advances logical time" behavior, self-correcting on the next `nextHlc`.
final class Clock {
    static let maxDriftMillis: Int64 = 5 * 60_000
    static let hlcCounterMax = 36 * 36 * 36 * 36 - 1 // HLC.make pads the counter to 4 base-36 digits

    private let store: Store
    let deviceId: String
    private(set) var time: Int64 = 0
    private(set) var counter: Int = 0
    private let lock = NSLock()

    init(store: Store, deviceId: String) {
        self.store = store
        self.deviceId = deviceId
    }

    /// Re-seed the in-memory high-water mark from persisted metadata (on boot).
    func seedFromMeta() {
        lock.lock(); defer { lock.unlock() }
        time = Int64(store.getMeta("hlc:time") ?? "0") ?? 0
        counter = Int(store.getMeta("hlc:counter") ?? "0") ?? 0
    }

    private func persist() {
        store.setMeta("hlc:time", String(time))
        store.setMeta("hlc:counter", String(counter))
    }

    func nextHlc() -> String {
        lock.lock(); defer { lock.unlock() }
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        var nextTime = max(now, time)
        var nextCounter = nextTime == time ? counter + 1 : 0
        if nextCounter > Self.hlcCounterMax {
            // Counter rollover: the 4-digit base-36 field can't hold this value.
            // Advance logical time by 1ms and reset the counter rather than
            // widening the field (see the class doc above).
            nextTime += 1
            nextCounter = 0
        }
        counter = nextCounter
        time = nextTime
        persist()
        return HLC.make(deviceId: deviceId, millis: nextTime, counter: nextCounter)
    }

    func observe(_ remote: String) {
        let parts = remote.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].count == 10,
              let millis = Int64(parts[0], radix: 36) else { return }
        // Absurd future drift is treated like a malformed value (see class doc).
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if millis > now + Self.maxDriftMillis { return }
        let c = Int(parts[1], radix: 36) ?? 0
        lock.lock(); defer { lock.unlock() }
        if millis > time { time = millis; counter = c }
        else if millis == time && c > counter { counter = c }
        else { return }
        persist()
    }
}
