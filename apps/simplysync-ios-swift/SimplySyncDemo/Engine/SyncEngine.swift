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

    /// Per-relay outcome of the last contact, keyed by base URL (parity with the
    /// TS/Kotlin engines). `SyncState` collapses multi-relay results ("synced" as
    /// long as ANY relay works — the data is safe somewhere); this map keeps the
    /// per-relay truth so `getRelayStatuses` can show which relay is failing
    /// behind a green state.
    private struct RelayHealth {
        var lastSyncedAt: String?
        var lastFailure: RelayStatus.Failure?
    }
    private var relayHealth: [String: RelayHealth] = [:]

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
    /// Soft-delete a row by id (parity with the TS/Kotlin engines): marks it deleted so
    /// the deletion replicates as a tombstone (a hard local delete would resurrect from a
    /// peer on the next pull) and `isDeleted`-filtered queries stop returning it.
    /// Idempotent — deleting a not-yet-local id writes a superseding tombstone.
    func delete(_ table: String, id: String) -> MutationResult {
        mutate(table, ["id": .string(id)], mode: .delete)
    }

    fileprivate enum Mode { case insert, update, upsert, delete }

    private struct PreparedRow {
        let table: String
        let id: String
        let hlc: String
        let merged: [String: JSONValue]
    }

    /// Validate + merge + stamp the HLC for one write, WITHOUT touching the database.
    /// Split out of the write so `batch` can prepare every op up front and fail
    /// atomically before anything is written. Must be called under `lock`.
    private func prepareRow(_ table: String, _ values: [String: JSONValue], mode: Mode) -> (PreparedRow?, String?) {
        guard store.driver != nil, let clock else { return (nil, "Database not ready.") }
        guard schema.has(table) else { return (nil, "Unknown table: \(table)") }
        let id: String = {
            if case .string(let s)? = values["id"], !s.isEmpty { return s }
            return createId()
        }()
        let existing = mode == .insert ? nil : store.readRow(table, id: id)
        if mode == .update, existing == nil { return (nil, "Row not found: \(id)") }

        var merged: [String: JSONValue] = existing.map(Self.rowToJson) ?? [:]
        var coerceInput = values
        coerceInput["id"] = .string(id)
        let (coerced, error) = store.coerceValues(table, coerceInput)
        if let error { return (nil, error) }
        for (k, v) in coerced { merged[k] = v }
        if let provided = values["isDeleted"] { merged["isDeleted"] = provided }
        // DELETE forces the tombstone flag so the deletion replicates and wins LWW.
        if mode == .delete { merged["isDeleted"] = sqliteTrue }

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

        return (PreparedRow(table: table, id: id, hlc: hlc, merged: merged), nil)
    }

    private func mutate(_ table: String, _ values: [String: JSONValue], mode: Mode) -> MutationResult {
        let outcome: MutationResult = lock.withLock {
            guard let driver = store.driver else { return .failure(message: "Database not ready.") }
            let (prepared, error) = prepareRow(table, values, mode: mode)
            guard let prepared else { return .failure(message: error ?? "Mutation failed.") }
            do {
                try driver.transaction { try store.writeRow(prepared.table, prepared.merged) }
            } catch {
                return .failure(message: describe(error))
            }
            enqueue(table: prepared.table, rowId: prepared.id, hlc: prepared.hlc, value: prepared.merged)
            cache.refreshQueries([table])
            return .ok(id: prepared.id)
        }
        if outcome.isOk, !lock.withLock({ transports }).isEmpty {
            Task { await self.sync() }
        }
        return outcome
    }

    /// Collects writes inside `batch { ... }`; each op is applied atomically in one
    /// transaction with a single query refresh and a single sync (parity with TS/Kotlin).
    final class BatchScope {
        fileprivate var specs: [(table: String, values: [String: JSONValue], mode: Mode)] = []
        func insert(_ table: String, _ values: [String: JSONValue]) { specs.append((table, values, .insert)) }
        func update(_ table: String, _ values: [String: JSONValue]) { specs.append((table, values, .update)) }
        func upsert(_ table: String, _ values: [String: JSONValue]) { specs.append((table, values, .upsert)) }
        func delete(_ table: String, id: String) { specs.append((table, ["id": .string(id)], .delete)) }
    }

    /// Write many rows atomically: validate + merge every op first (one bad op aborts the
    /// whole batch before anything is written), then one transaction, one query refresh per
    /// affected table, and one sync. Mix in `delete` for atomic moves. Parity with TS `batch`.
    @discardableResult
    func batch(_ build: (BatchScope) -> Void) -> BatchResult {
        let scope = BatchScope()
        build(scope)
        let outcome: BatchResult = lock.withLock {
            guard let driver = store.driver else { return .failure(message: "Database not ready.") }
            var prepared: [PreparedRow] = []
            for spec in scope.specs {
                let (p, error) = prepareRow(spec.table, spec.values, mode: spec.mode)
                guard let p else { return .failure(message: error ?? "Batch failed.") }
                prepared.append(p)
            }
            do {
                try driver.transaction { for p in prepared { try store.writeRow(p.table, p.merged) } }
            } catch {
                return .failure(message: describe(error))
            }
            for p in prepared { enqueue(table: p.table, rowId: p.id, hlc: p.hlc, value: p.merged) }
            cache.refreshQueries(Set(prepared.map { $0.table }))
            return .ok(ids: prepared.map { $0.id })
        }
        if outcome.isOk, !lock.withLock({ transports }).isEmpty {
            Task { await self.sync() }
        }
        return outcome
    }

    /// Soft-delete many rows of one table in a single atomic batch.
    @discardableResult
    func deleteMany(_ table: String, ids: [String]) -> BatchResult {
        batch { scope in for id in ids { scope.delete(table, id: id) } }
    }

    /// Reclaim local storage by hard-deleting soft-deleted rows (tombstones) older than
    /// [olderThanMs] (default 30 days). Safe (parity with the TS/Kotlin engines): the grace
    /// window lets the deletion replicate, unpushed deletes are kept while relays are
    /// configured, and the relay retains tombstones so a re-sync re-applies them.
    @discardableResult
    func purgeDeleted(olderThanMs: Int64 = 30 * 24 * 60 * 60 * 1000) -> Int {
        lock.withLock {
            let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
            return store.purgeDeleted(olderThanMs: olderThanMs, nowMs: nowMs, requirePushed: !transports.isEmpty)
        }
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
        lock.withLock {
            transports = next
            // Drop health for relays no longer configured so statuses don't linger.
            let active = Set(next.map { Self.normalizeBase($0.url) })
            relayHealth = relayHealth.filter { active.contains($0.key) }
        }
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
        var anySuccess = false
        var firstFailure: (kind: String, status: Int?, message: String)?
        // Contact every relay so each one's health is recorded independently
        // (per-relay entries, not collapsed to the first failure) and one bad
        // relay can't starve the rest — parity with the TS/Kotlin engines.
        for base in bases {
            do {
                try await pushOutbox(base: base, identity: identity)
                changed.formUnion(try await pullAndApply(base: base, identity: identity))
                anySuccess = true
                lock.withLock {
                    relayHealth[base] = RelayHealth(lastSyncedAt: Self.isoNow(), lastFailure: nil)
                }
            } catch {
                let failure = classifyFailure(error)
                if firstFailure == nil { firstFailure = failure }
                lock.withLock {
                    // Keep the last good sync time so "failing since when" is visible.
                    relayHealth[base] = RelayHealth(
                        lastSyncedAt: relayHealth[base]?.lastSyncedAt,
                        lastFailure: RelayStatus.Failure(kind: failure.kind, message: failure.message,
                                                         at: Self.isoNow()))
                }
            }
        }
        lock.withLock {
            if !changed.isEmpty { cache.refreshQueries(changed) }
            pruneSeen()
            // Drop outbox events now delivered to every relay (cursors advanced above;
            // a failed relay's cursor didn't move, so its events are kept).
            store.pruneOutbox(bases)
        }
        if anySuccess || firstFailure == nil {
            lock.withLock { if pollIntervalMs != defaultPollMs { pollIntervalMs = defaultPollMs } }
            setSyncState(.synced(lastSyncedAt: Self.isoNow()))
        } else if let failure = firstFailure {
            // A terminal failure (auth/quota/bad request) won't self-heal by retrying
            // the same batch — back the poller off. A rate limit also backs off but
            // is not "terminal" (it self-heals).
            let terminal = ["authRejected", "quotaExceeded", "badRequest"].contains(failure.kind)
            if terminal || failure.kind == "rateLimited" {
                lock.withLock { pollIntervalMs = backoffPollMs }
            }
            setSyncState(.notSynced(error: failure.message, terminal: terminal, status: failure.status))
        }
    }

    /// Map a thrown sync error to the TS `classifyError` taxonomy. HTTP errors
    /// carry a status; anything else (URLError etc.) is network-level, which we
    /// read as unreachable.
    private func classifyFailure(_ error: Error) -> (kind: String, status: Int?, message: String) {
        if let e = error as? RelayClient.RelayError, case .http(let status, _) = e {
            let kind: String
            switch status {
            case 401, 403: kind = "authRejected"
            case 413: kind = "quotaExceeded"
            case 429: kind = "rateLimited"
            case 500...: kind = "serverError"
            case 400...: kind = "badRequest"
            default: kind = "unknown"
            }
            return (kind, status, describe(error))
        }
        return ("unreachable", nil, describe(error))
    }

    private func pushOutbox(base: String, identity: Identity) async throws {
        // Per-relay push cursor (parity with the TS/Kotlin engines) so EVERY configured
        // relay receives a full copy of this device's events (write redundancy), not just
        // the first one contacted. A single global "pushed_at is null" filter let the first
        // relay drain the outbox and starve the rest. Outbox event_ids are this device's own
        // HLCs — monotonically increasing — so a string high-water mark paginates correctly.
        // On upgrade the cursor is unset and starts at "" (re-push once; relay dedupes).
        let cursorKey = "push:\(base)"
        let pending: [(eventId: String, json: String)] = lock.withLock {
            let after = store.getMeta(cursorKey) ?? ""
            guard let rows = try? store.driver?.select(
                "select event_id, envelope_json from \"\(Store.outboxTable)\" where event_id > ? order by event_id asc limit 1000",
                [.text(after)])
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
                // `pushed_at` marks "reached at least one relay" — keep the earliest via coalesce.
                try? store.driver?.exec(
                    "update \"\(Store.outboxTable)\" set pushed_at = coalesce(pushed_at, ?) where event_id = ?",
                    [.text(pushedAt), .text(item.eventId)])
            }
            if let last = pending.last?.eventId { store.setMeta(cursorKey, last) }
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

    // MARK: - Relay status

    /// One status entry per configured relay — reachability, version, and storage
    /// usage from `/v1/status`, plus this session's last sync outcome from the
    /// health map. Probes all relays concurrently — the `getRelayStatuses` analog.
    func getRelayStatuses() async -> [RelayStatus] {
        let (snapIdentity, bases): (Identity?, [String]) = lock.withLock {
            (identity, transports.map { Self.normalizeBase($0.url) })
        }
        return await withTaskGroup(of: (Int, RelayStatus).self) { group in
            for (index, base) in bases.enumerated() {
                group.addTask { [weak self] in
                    guard let self else { return (index, RelayStatus(url: base, reachable: false)) }
                    return (index, await self.fetchRelayStatus(base: base, identity: snapIdentity))
                }
            }
            var statuses = [RelayStatus?](repeating: nil, count: bases.count)
            for await (index, status) in group { statuses[index] = status }
            return statuses.compactMap { $0 }
        }
    }

    /// One relay's status probe: GET /v1/status (auth-gated, per-owner). A 404
    /// means the relay is up but this owner has never pushed to it — confirm
    /// liveness via the public /health so `reachable`/`version` still report.
    private func fetchRelayStatus(base: String, identity: Identity?) async -> RelayStatus {
        let health = lock.withLock { relayHealth[base] }
        var status = RelayStatus(url: base, reachable: false,
                                 lastSyncedAt: health?.lastSyncedAt,
                                 lastFailure: health?.lastFailure)
        guard let identity, let url = URL(string: base) else { return status }
        let relay = RelayClient(baseURL: url, ownerId: identity.ownerId,
                                relayAuth: identity.relayAuth, session: deps.urlSession)
        do {
            let body = try await relay.status()
            status.reachable = true
            status.lastFailure = nil
            status.version = body.server.version
            status.usedBytes = body.account.usedBytes
            status.quotaBytes = body.account.quotaBytes
            status.usedPct = body.account.usedPct
            status.headSeq = body.account.headSeq
            status.streams = body.account.streams
            status.events = body.account.events
        } catch {
            if let e = error as? RelayClient.RelayError, case .http(let code, _) = e, code == 404 {
                // Relay alive, owner has no account yet (never pushed here).
                let alive = try? await relay.health()
                status.reachable = alive != nil
                status.version = alive?.version
            } else {
                let failure = classifyFailure(error)
                status.lastFailure = RelayStatus.Failure(kind: failure.kind, message: failure.message,
                                                         at: Self.isoNow())
            }
        }
        return status
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
