import Foundation
import Combine

enum EngineError: Error, CustomStringConvertible {
    case noBackup
    case databaseNotReady

    var description: String {
        switch self {
        case .noBackup:
            return "No backup found for this recovery phrase (the relay is empty or unreachable). Nothing was changed. Use force to switch to a new owner."
        case .databaseNotReady:
            return "Database not ready."
        }
    }
}

/// The local-first sync engine — the Swift port of `@simplysync/engine`. It owns
/// the local SQLite database, the HLC clock, the outbox, the reactive query
/// cache, and the sync loop, so app code calls `insert`/`update`/`upsert` and
/// reads reactive queries rather than touching the protocol directly.
///
/// Single-threaded by design (like the TS engine): one recursive lock serializes
/// all state + DB access, and network I/O happens between critical sections, never
/// while the lock is held.
final class SyncEngine: ObservableObject {
    /// Live sync status, republished on the main thread for SwiftUI.
    @Published private(set) var syncState: SyncState = .initial
    /// The last engine error (init/query/sync), republished on the main thread.
    @Published private(set) var lastError: String?

    private let schema: Schema
    private let config: SyncEngineConfig
    private let deps: SyncEngineDeps
    private let store: Store
    private let cache: QueryCache
    private let lock = NSRecursiveLock()

    private var identity: Identity?
    private var clock: Clock?
    private var deviceId = "local"
    private var appOwnerValue: AppOwner?
    private var transports: [Transport]
    private var schemaReady = false
    private var currentSync: Task<Void, Never>?
    private var syncRequested = false
    private var syncStateValue: SyncState = .initial

    private var pollTask: Task<Void, Never>?
    private let defaultPollMs: Int
    private let backoffPollMs = 5 * 60_000
    private var pollIntervalMs: Int
    private let seenCap = 50_000

    private var bootTask: Task<Void, Never>!
    private let mnemonicKey: String
    private let deviceKey: String

    init(schema: Schema, config: SyncEngineConfig, deps: SyncEngineDeps) {
        self.schema = schema
        self.config = config
        self.deps = deps
        self.store = Store(schema: schema, config: config)
        self.cache = QueryCache(store: store, schema: schema)
        self.transports = config.transports
        self.defaultPollMs = config.syncIntervalMs > 0 ? config.syncIntervalMs : 5000
        self.pollIntervalMs = config.syncIntervalMs > 0 ? config.syncIntervalMs : 5000
        self.mnemonicKey = "\(config.name):mnemonic"
        self.deviceKey = "\(config.name):deviceId"
        self.cache.onError = { [weak self] message in self?.setError(message) }
        self.bootTask = Task { [weak self] in self?.boot() }
    }

    /// Resolves once the DB is open and the owner is loaded — the `engine.ready`
    /// analog. `await engine.ready`.
    var ready: Void {
        get async { await bootTask.value }
    }

    // MARK: - Boot

    private func boot() {
        do {
            let driver = try deps.makeDriver(config.name)
            try loadIdentity()
            lock.withLock {
                store.driver = driver
                try? store.ensureSchema()
                cache.schemaReady = true
                schemaReady = true
                clock?.seedFromMeta()
                cache.refreshAll()
            }
            if !transports.isEmpty {
                Task { await self.sync() }
                startPolling()
            }
        } catch {
            setError(describe(error))
        }
    }

    private func loadIdentity() throws {
        var secret = config.externalAppOwner?.recoveryKey ?? deps.secureStorage.getItem(mnemonicKey)
        if secret == nil || (try? IdentityDeriver.derive(from: secret!)) == nil {
            let fresh = IdentityDeriver.createRecoveryKey()
            deps.secureStorage.setItem(mnemonicKey, fresh)
            secret = fresh
        }
        let derived = try IdentityDeriver.derive(from: secret!)
        let device = deps.secureStorage.getItem(deviceKey) ?? {
            let d = Base64URL.encode(Crypto.randomBytes(8))
            deps.secureStorage.setItem(deviceKey, d)
            return d
        }()
        lock.withLock {
            self.identity = derived
            self.deviceId = device
            self.clock = Clock(store: store, deviceId: device)
            self.appOwnerValue = AppOwner(
                id: derived.ownerId, recoveryKey: derived.recoveryKey,
                writeKey: derived.relayAuth, mnemonic: derived.mnemonic)
        }
    }

    // MARK: - Owner

    /// The current owner (`{ id, recoveryKey, writeKey, mnemonic? }`), once boot
    /// has resolved.
    var appOwner: AppOwner? {
        get async {
            await bootTask.value
            return lock.withLock { appOwnerValue }
        }
    }

    /// The owner if already loaded (nil before boot resolves).
    var currentOwner: AppOwner? { lock.withLock { appOwnerValue } }

    /// Restore an owner from its recovery key or phrase. By default refuses to
    /// wipe local data unless the relay confirms the owner has data; pass
    /// `force: true` to switch to a new/empty owner intentionally.
    func restoreAppOwner(_ recoveryKey: String, force: Bool = false) async throws {
        let restored = try IdentityDeriver.derive(from: recoveryKey)
        if !force {
            let bases = lock.withLock { transports.map { Self.normalizeBase($0.url) } }
            var hasBackup = false
            for base in bases {
                guard let url = URL(string: base) else { continue }
                let relay = RelayClient(baseURL: url, ownerId: restored.ownerId,
                                        relayAuth: restored.relayAuth, session: deps.urlSession)
                if let result = try? await relay.pull(after: ""), !result.events.isEmpty {
                    hasBackup = true
                    break
                }
            }
            if !hasBackup { throw EngineError.noBackup }
        }
        switchOwner(recoveryKey: restored.recoveryKey, identity: restored)
        if !lock.withLock({ transports }).isEmpty { Task { await self.sync() } }
        deps.reloadApp?()
    }

    /// Mint a brand-new owner and wipe local data — the `resetAppOwner` analog.
    func resetAppOwner() async {
        let key = IdentityDeriver.createRecoveryKey()
        if let derived = try? IdentityDeriver.derive(from: key) {
            switchOwner(recoveryKey: key, identity: derived)
        }
        deps.reloadApp?()
    }

    private func switchOwner(recoveryKey: String, identity: Identity) {
        lock.withLock {
            deps.secureStorage.setItem(mnemonicKey, recoveryKey)
            store.wipeLocalData()
            store.setMeta("legacyImported", "3")
            self.identity = identity
            self.appOwnerValue = AppOwner(
                id: identity.ownerId, recoveryKey: identity.recoveryKey,
                writeKey: identity.relayAuth, mnemonic: identity.mnemonic)
            clock?.seedFromMeta()
            cache.refreshAll()
        }
    }

    // MARK: - Queries

    /// Build a reusable query from SQL (+ optional params) and the row type. Use
    /// double-quoted table names so the cache can track which writes affect it.
    func createQuery<Row: Decodable>(_ sql: String, _ parameters: [SQLiteValue] = [],
                                     as _: Row.Type) -> Query<Row> {
        Query(sql, parameters)
    }

    /// One-shot read (re-runs the SQL now).
    func loadQuery<Row: Decodable>(_ query: Query<Row>) -> [Row] {
        lock.withLock { decodeRows(cache.loadRawRows(query)) }
    }

    /// Cached snapshot (the `getQueryRows` analog).
    func getQueryRows<Row: Decodable>(_ query: Query<Row>) -> [Row] {
        lock.withLock { decodeRows(cache.rawRows(query)) }
    }

    /// Low-level reactive primitive: subscribe a listener fired when the query's
    /// rows change. `liveQuery` wraps this.
    func subscribeQuery<Row: Decodable>(_ query: Query<Row>, _ listener: @escaping () -> Void) -> () -> Void {
        lock.withLock { cache.subscribe(query, listener) }
    }

    /// A reactive query result for SwiftUI — the `useQuery` analog.
    func liveQuery<Row: Decodable>(_ query: Query<Row>) -> LiveQuery<Row> {
        lock.withLock {
            let initial: [Row] = decodeRows(cache.rawRows(query))
            let live = LiveQuery<Row>.make(initial: initial,
                                           reload: { [weak self] in self?.getQueryRows(query) ?? [] })
            live.makeLive { [weak self] fire in
                self?.subscribeQuery(query, fire) ?? {}
            }
            return live
        }
    }

    private func decodeRows<Row: Decodable>(_ raw: [SQLiteRow]) -> [Row] {
        var out: [Row] = []
        out.reserveCapacity(raw.count)
        for row in raw {
            do { out.append(try RowDecoder.decode(Row.self, from: row)) }
            catch { setError("row decode failed: \(describe(error))") }
        }
        return out
    }

    // MARK: - Mutations

    func insert(_ table: String, _ values: [String: JSONValue]) -> MutationResult {
        mutate(table, values, mode: .insert)
    }
    func update(_ table: String, _ values: [String: JSONValue]) -> MutationResult {
        mutate(table, values, mode: .update)
    }
    func upsert(_ table: String, _ values: [String: JSONValue]) -> MutationResult {
        mutate(table, values, mode: .upsert)
    }

    private enum Mode { case insert, update, upsert }

    private func mutate(_ table: String, _ values: [String: JSONValue], mode: Mode) -> MutationResult {
        let outcome: MutationResult = lock.withLock {
            guard store.driver != nil, let clock else {
                return .failure(message: "Database not ready.")
            }
            guard schema.has(table) else {
                return .failure(message: "Unknown table: \(table)")
            }
            let id: String = {
                if case .string(let s)? = values["id"], !s.isEmpty { return s }
                return createId()
            }()
            let existing = mode == .insert ? nil : store.readRow(table, id: id)
            if mode == .update, existing == nil {
                return .failure(message: "Row not found: \(id)")
            }

            var merged: [String: JSONValue] = existing.map(Self.rowToJson) ?? [:]
            var coerceInput = values
            coerceInput["id"] = .string(id)
            let (coerced, error) = store.coerceValues(table, coerceInput)
            if let error { return .failure(message: error) }
            for (k, v) in coerced { merged[k] = v }
            if let provided = values["isDeleted"] { merged["isDeleted"] = provided }

            let hlc = clock.nextHlc()
            merged["id"] = .string(id)
            merged["updatedAt"] = .string(hlc)
            // Keep an existing createdAt; on insert use a caller-provided one
            // (demo/legacy backfill) or stamp now.
            if existing == nil, case .string(let provided)? = values["createdAt"] {
                merged["createdAt"] = .string(provided)
            }
            if merged["createdAt"] == nil { merged["createdAt"] = .string(Self.isoNow()) }
            if merged["isDeleted"] == nil { merged["isDeleted"] = sqliteFalse }

            do {
                try store.driver?.transaction { try store.writeRow(table, merged) }
            } catch {
                return .failure(message: describe(error))
            }
            enqueue(table: table, rowId: id, hlc: hlc, value: merged)
            cache.refreshQueries([table])
            return .ok(id: id)
        }
        if outcome.isOk, !lock.withLock({ transports }).isEmpty {
            Task { await self.sync() }
        }
        return outcome
    }

    /// Encrypt the change and append it to the outbox. Called under the lock.
    private func enqueue(table: String, rowId: String, hlc: String, value: [String: JSONValue]) {
        guard let identity else { return }
        let payload = SyncPayload(schemaVersion: 1, table: table, op: "upsert",
                                  rowId: rowId, hlc: hlc, value: value)
        guard let envelope = try? Envelope.encrypt(
            identity: identity, eventId: hlc, deviceId: deviceId,
            createdAt: Self.isoNow(), payload: payload),
            let data = try? JSONEncoder().encode(envelope),
            let json = String(data: data, encoding: .utf8) else { return }
        try? store.driver?.exec(
            "insert or ignore into \"\(Store.outboxTable)\" (event_id, envelope_json) values (?, ?)",
            [.text(hlc), .text(json)])
    }

    // MARK: - Sync

    /// Set transports (relays). Triggers an immediate sync and starts polling, or
    /// stops polling if cleared.
    func setTransports(_ next: [Transport]) {
        lock.withLock { transports = next }
        if !next.isEmpty {
            Task { await self.sync() }
            startPolling()
        } else {
            stopPolling()
        }
    }

    /// Push the outbox, then pull + apply remote events. Concurrent callers
    /// coalesce onto the in-flight run; a request that arrives mid-run schedules
    /// one more cycle, so a write made just before `await engine.sync()` is always
    /// pushed before the call resolves.
    func sync() async {
        let task: Task<Void, Never> = lock.withLock {
            syncRequested = true
            if let existing = currentSync { return existing }
            let task = Task { [weak self] in
                guard let self else { return }
                await self.runSyncLoop()
            }
            currentSync = task
            return task
        }
        await task.value
    }

    private func runSyncLoop() async {
        while true {
            let shouldRun: Bool = lock.withLock {
                if syncRequested { syncRequested = false; return true }
                currentSync = nil
                return false
            }
            if !shouldRun { return }
            await runSync()
        }
    }

    private func runSync() async {
        let (snapIdentity, bases): (Identity?, [String]) = lock.withLock {
            guard let id = identity, !transports.isEmpty else { return (nil, []) }
            return (id, transports.map { Self.normalizeBase($0.url) })
        }
        guard let identity = snapIdentity, !bases.isEmpty else { return }
        setSyncState(.syncing)
        var changed = Set<String>()
        do {
            for base in bases {
                try await pushOutbox(base: base, identity: identity)
                changed.formUnion(try await pullAndApply(base: base, identity: identity))
            }
            lock.withLock {
                if !changed.isEmpty { cache.refreshQueries(changed) }
                pruneSeen()
                if pollIntervalMs != defaultPollMs { pollIntervalMs = defaultPollMs }
            }
            setSyncState(.synced(lastSyncedAt: Self.isoNow()))
        } catch {
            let status = (error as? RelayClient.RelayError).flatMap { e -> Int? in
                if case .http(let s, _) = e { return s }
                return nil
            }
            let terminal = status.map { [400, 401, 403, 413].contains($0) } ?? false
            if terminal { lock.withLock { pollIntervalMs = backoffPollMs } }
            setSyncState(.notSynced(error: describe(error), terminal: terminal, status: status))
        }
    }

    private func pushOutbox(base: String, identity: Identity) async throws {
        let pending: [(eventId: String, json: String)] = lock.withLock {
            guard let rows = try? store.driver?.select(
                "select event_id, envelope_json from \"\(Store.outboxTable)\" where pushed_at is null order by event_id asc limit 1000")
            else { return [] }
            return rows.compactMap { row in
                if case .text(let eid)? = row["event_id"], case .text(let json)? = row["envelope_json"] {
                    return (eid, json)
                }
                return nil
            }
        }
        if pending.isEmpty { return }
        let envelopes = pending.compactMap { item -> SyncEnvelope? in
            guard let data = item.json.data(using: .utf8) else { return nil }
            return try? JSONDecoder().decode(SyncEnvelope.self, from: data)
        }
        guard let url = URL(string: base) else { return }
        let relay = RelayClient(baseURL: url, ownerId: identity.ownerId,
                                relayAuth: identity.relayAuth, session: deps.urlSession)
        _ = try await relay.push(envelopes)
        let pushedAt = Self.isoNow()
        lock.withLock {
            for item in pending {
                try? store.driver?.exec(
                    "update \"\(Store.outboxTable)\" set pushed_at = ? where event_id = ?",
                    [.text(pushedAt), .text(item.eventId)])
            }
        }
    }

    private func pullAndApply(base: String, identity: Identity) async throws -> Set<String> {
        let cursorKey = "cursor:\(base)"
        let after = lock.withLock { store.getMeta(cursorKey) ?? "" }
        guard let url = URL(string: base) else { return [] }
        let relay = RelayClient(baseURL: url, ownerId: identity.ownerId,
                                relayAuth: identity.relayAuth, session: deps.urlSession)
        let result = try await relay.pull(after: after)
        return lock.withLock {
            var changed = Set<String>()
            for envelope in result.events {
                let seen = (try? store.driver?.select(
                    "select 1 from \"\(Store.seenTable)\" where event_id = ?", [.text(envelope.eventId)])) ?? []
                if !seen.isEmpty { continue }
                guard let payload = try? Envelope.decrypt(identity: identity, envelope: envelope) else { continue }
                clock?.observe(payload.hlc)
                if schema.has(payload.table) {
                    applyRemoteRow(payload)
                    changed.insert(payload.table)
                }
                try? store.driver?.exec(
                    "insert or ignore into \"\(Store.seenTable)\" (event_id) values (?)", [.text(envelope.eventId)])
            }
            store.setMeta(cursorKey, result.nextCursor)
            return changed
        }
    }

    /// Apply one decrypted row, last-writer-wins by `updatedAt`. Called under lock.
    private func applyRemoteRow(_ payload: SyncPayload) {
        if let existing = store.readRow(payload.table, id: payload.rowId),
           case .text(let updatedAt)? = existing["updatedAt"],
           HLC.compare(updatedAt, payload.hlc) >= 0 {
            return
        }
        var row = payload.value
        row["id"] = .string(payload.rowId)
        try? store.writeRow(payload.table, row)
    }

    private func pruneSeen() {
        guard let driver = store.driver else { return }
        guard let rows = try? driver.select("select count(*) as c from \"\(Store.seenTable)\""),
              case .integer(let n)? = rows.first?["c"], Int(n) > seenCap else { return }
        try? driver.exec(
            "delete from \"\(Store.seenTable)\" where event_id not in (select event_id from \"\(Store.seenTable)\" order by event_id desc limit ?)",
            [.integer(Int64(seenCap))])
    }

    // MARK: - Polling

    private func startPolling() {
        lock.withLock {
            guard pollTask == nil, !transports.isEmpty else { return }
            pollTask = Task { [weak self] in
                while !Task.isCancelled {
                    let ms = self?.lock.withLock { self?.pollIntervalMs } ?? 5000
                    try? await Task.sleep(nanoseconds: UInt64(max(ms, 1000)) * 1_000_000)
                    if Task.isCancelled { break }
                    await self?.sync()
                }
            }
        }
    }

    private func stopPolling() {
        lock.withLock {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    // MARK: - State

    func getSyncState() -> SyncState { lock.withLock { syncStateValue } }

    private func setSyncState(_ next: SyncState) {
        lock.withLock { syncStateValue = next }
        publishOnMain { [weak self] in self?.syncState = next }
    }

    private func setError(_ message: String) {
        publishOnMain { [weak self] in self?.lastError = message }
    }

    private func publishOnMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread { work() } else { DispatchQueue.main.async(execute: work) }
    }

    // MARK: - Helpers

    private func createId() -> String { Base64URL.encode(Crypto.randomBytes(16)) }

    private static func rowToJson(_ row: SQLiteRow) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (k, v) in row {
            switch v {
            case .text(let s): out[k] = .string(s)
            case .integer(let n): out[k] = .int(Int(n))
            case .real(let d): out[k] = .double(d)
            case .null: out[k] = .null
            case .blob: out[k] = .null
            }
        }
        return out
    }

    private static func normalizeBase(_ url: String) -> String {
        var s = url
        if s.hasPrefix("wss://") { s = "https://" + s.dropFirst("wss://".count) }
        else if s.hasPrefix("ws://") { s = "http://" + s.dropFirst("ws://".count) }
        while s.hasSuffix("/") { s.removeLast() }
        return s
    }

    private static func isoNow() -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: Date())
    }

    private func describe(_ error: Error) -> String {
        if let e = error as? EngineError { return e.description }
        if let e = error as? SqliteError { return e.description }
        if let e = error as? RelayClient.RelayError {
            if case .http(let status, let body) = e { return "HTTP \(status): \(body)" }
            return "bad relay URL"
        }
        return (error as NSError).localizedDescription
    }
}

/// Wire the platform plumbing once, then build engines — the `createSync(deps)`
/// analog. `let engine = createSync(deps)(schema, config)`.
func createSync(_ deps: SyncEngineDeps) -> (Schema, SyncEngineConfig) -> SyncEngine {
    { schema, config in SyncEngine(schema: schema, config: config, deps: deps) }
}
