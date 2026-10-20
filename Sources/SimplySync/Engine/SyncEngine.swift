import Foundation
import Combine

public enum EngineError: Error, CustomStringConvertible {
    case noBackup
    case databaseNotReady
    case identityNotReady
    case outboxEncodingFailed
    /// `resetAppOwner` refused because this data can't be confirmed to exist
    /// anywhere else. The payload names the condition so the app can offer the
    /// matching next step (wait for sync, or export a backup first).
    case resetUnsafe(String)

    public var description: String {
        switch self {
        case .noBackup:
            return "No backup found for this recovery phrase (the relay is empty or unreachable). Nothing was changed. Use force to switch to a new owner."
        case .databaseNotReady:
            return "Database not ready."
        case .identityNotReady:
            return "Identity not ready."
        case .outboxEncodingFailed:
            return "Could not encode the sync outbox event."
        case .resetUnsafe(let reason):
            return reason
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
public final class SyncEngine: ObservableObject, @unchecked Sendable {
    /// Live sync status, republished on the main thread for SwiftUI.
    @Published public private(set) var syncState: SyncState = .initial
    /// The last engine error (init/query/sync), republished on the main thread.
    @Published public private(set) var lastError: String?

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
    /// behind a green state. App recovery/write gates must not turn a failed
    /// redundant replica into a permanent write lock after one replica drains.
    private struct RelayHealth {
        var lastSyncedAt: String?
        var lastFailure: RelayStatus.Failure?
    }
    private var relayHealth: [String: RelayHealth] = [:]
    /// Relays that lost their data and are being re-seeded from this device.
    /// Kept out of `relayHealth` because that entry is replaced wholesale on
    /// every contact, while a re-seed deliberately spans passes: the wipe is
    /// detected during pull, the rebuilt outbox drains on the following pass.
    private var reseedingRelays: Set<String> = []
    /// Supplies the transport behind a configured `Transport(url:)` base when
    /// that base is not an HTTP relay — `CloudKitTransport.factory(...)` for
    /// iCloud, or an in-memory log in tests. Return `nil` for any base you don't
    /// claim and the engine uses the HTTP `RelayClient`, so iCloud and relays
    /// can be configured side by side. Set it before `setTransports`; it is
    /// read without the lock.
    public var transportFactory: ((_ base: String, _ identity: Identity) -> (any SyncTransport)?)?

    private func transport(for base: String, identity: Identity) -> (any SyncTransport)? {
        if let custom = transportFactory?(base, identity) { return custom }
        guard let url = URL(string: base) else { return nil }
        return RelayClient(baseURL: url, ownerId: identity.ownerId,
                           relayAuth: identity.relayAuth, session: deps.urlSession)
    }

    private var pollTask: Task<Void, Never>?
    private let defaultPollMs: Int
    private let backoffPollMs = 5 * 60_000
    private var pollIntervalMs: Int
    private let seenCap = 50_000
    private let deferredReplayLimit = 256
    private let deferredScanActiveKey = "deferred:opaque:activeSchema"
    private let deferredScanCompleteKey = "deferred:opaque:completeSchema"
    private let deferredScanCursorKey = "deferred:opaque:cursor"

    private var bootTask: Task<Void, Never>!
    private let mnemonicKey: String
    private let deviceKey: String

    public init(schema: Schema, config: SyncEngineConfig, deps: SyncEngineDeps) {
        self.schema = schema
        self.config = config
        self.deps = deps
        self.store = Store(schema: schema, config: config)
        self.cache = QueryCache(store: store, schema: schema)
        self.transports = config.transports
        self.defaultPollMs = config.syncIntervalMs > 0 ? config.syncIntervalMs : 60_000
        self.pollIntervalMs = config.syncIntervalMs > 0 ? config.syncIntervalMs : 60_000
        self.mnemonicKey = "\(config.name):mnemonic"
        self.deviceKey = "\(config.name):deviceId"
        self.cache.onError = { [weak self] message in self?.setError(message) }
        self.bootTask = Task.detached(priority: .utility) { [weak self] in
            guard let self else { return }
            await self.boot()
        }
    }

    /// Resolves once the DB is open and the owner is loaded — the `engine.ready`
    /// analog. `await engine.ready`.
    public var ready: Void {
        get async { await bootTask.value }
    }

    // MARK: - Boot

    private func boot() async {
        do {
            let driver = try deps.makeDriver(config.name)
            try loadIdentity()
            lock.withLock {
                store.driver = driver
                try? store.ensureSchema()
                cache.schemaReady = true
                schemaReady = true
                clock?.seedFromMeta()
            }
            _ = await replayDeferredAtBoot()
            lock.withLock { cache.refreshAll() }
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
    public var appOwner: AppOwner? {
        get async {
            await bootTask.value
            return lock.withLock { appOwnerValue }
        }
    }

    /// The owner if already loaded (nil before boot resolves).
    public var currentOwner: AppOwner? { lock.withLock { appOwnerValue } }

    /// Restore an owner from its recovery key or phrase. By default refuses to
    /// wipe local data unless the relay confirms the owner has data; pass
    /// `force: true` to switch to a new/empty owner intentionally.
    public func restoreAppOwner(_ recoveryKey: String, force: Bool = false) async throws {
        let restored = try IdentityDeriver.derive(from: recoveryKey)
        if !force {
            let bases = lock.withLock { transports.map { Self.normalizeBase($0.url) } }
            var hasBackup = false
            for base in bases {
                guard let relay = transport(for: base, identity: restored) else { continue }
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
    ///
    /// Strictly more destructive than `restoreAppOwner`: it wipes local data AND
    /// adopts an owner nothing has ever synced, so there is no relay to pull the
    /// data back from. It therefore refuses unless a relay is confirmed to hold a
    /// copy, throwing `EngineError.resetUnsafe` with the condition that failed so
    /// the app can offer the right next step (wait for sync, or export a backup).
    /// Pass `force: true` once the user has confirmed.
    public func resetAppOwner(force: Bool = false) async throws {
        if !force {
            let pending = lock.withLock { pendingOutboxCount() }
            if pending > 0 {
                throw EngineError.resetUnsafe(
                    "\(pending) change(s) haven't reached a sync relay yet. Back up your data first, or wait for sync to finish. Nothing was changed.")
            }
            if lock.withLock({ transports }).isEmpty {
                throw EngineError.resetUnsafe(
                    "No sync relay is configured, so this data exists only on this device. Back up your data first. Nothing was changed.")
            }
            let statuses = await getRelayStatuses()
            if !statuses.contains(where: { $0.reachable }) {
                throw EngineError.resetUnsafe(
                    "The sync service could not be reached, so this data can't be confirmed as backed up. Back up your data first. Nothing was changed.")
            }
            // `events > 0`, not merely `reachable`: a relay that answers but
            // holds nothing for this owner is no safer than an unreachable one.
            if !statuses.contains(where: { ($0.events ?? 0) > 0 }) {
                throw EngineError.resetUnsafe(
                    "No sync relay holds a copy of this data yet. Back up your data first. Nothing was changed.")
            }
        }
        let key = IdentityDeriver.createRecoveryKey()
        if let derived = try? IdentityDeriver.derive(from: key) {
            switchOwner(recoveryKey: key, identity: derived)
        }
        deps.reloadApp?()
    }

    /// Outbox events that have not reached any relay yet. Caller holds the lock.
    private func pendingOutboxCount() -> Int {
        guard let rows = try? store.driver?.select(
            "select count(*) as c from \"\(Store.outboxTable)\" where pushed_at is null"),
              case .integer(let n)? = rows.first?["c"] else { return 0 }
        return Int(n)
    }

    /// Forget everything this device knows about one relay, so the next pass
    /// re-pulls from zero and `backfillOutboxForNewRelay` re-seeds the owner's
    /// rows. Caller holds the lock.
    private func resetRelaySyncState(base: String) {
        store.setMeta("cursor:\(base)", "")
        store.deleteMeta("push:\(base)")
        store.deleteMeta("backfill:\(base)")
    }

    /// A relay whose event log is behind our pull cursor has lost data (wiped
    /// volume, fresh deploy, restored from an older backup). Its `seq` counter
    /// restarted, so `where seq > cursor` would match nothing and this device
    /// would report "synced" forever while diverging from every peer. Forget the
    /// relay and rebuild the outbox now, and flag it so a UI can say
    /// "re-uploading" instead of lying.
    private func handleWipedRelay(base: String) {
        lock.withLock {
            guard !reseedingRelays.contains(base) else { return }
            reseedingRelays.insert(base)
            resetRelaySyncState(base: base)
        }
        backfillOutboxForNewRelay(base: base)
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
    public func createQuery<Row: Decodable>(_ sql: String, _ parameters: [SQLiteValue] = [],
                                            as _: Row.Type) -> Query<Row> {
        Query(sql, parameters)
    }

    /// One-shot read (re-runs the SQL now).
    public func loadQuery<Row: Decodable>(_ query: Query<Row>) -> [Row] {
        lock.withLock { decodeRows(cache.loadRawRows(query)) }
    }

    /// Cached snapshot (the `getQueryRows` analog).
    public func getQueryRows<Row: Decodable>(_ query: Query<Row>) -> [Row] {
        lock.withLock { decodeRows(cache.rawRows(query)) }
    }

    /// Low-level reactive primitive: subscribe a listener fired when the query's
    /// rows change. `liveQuery` wraps this.
    public func subscribeQuery<Row: Decodable>(
        _ query: Query<Row>,
        _ listener: @escaping () -> Void
    ) -> () -> Void {
        lock.withLock { cache.subscribe(query, listener) }
    }

    /// A reactive query result for SwiftUI — the `useQuery` analog.
    public func liveQuery<Row: Decodable>(_ query: Query<Row>) -> LiveQuery<Row> {
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

    public func insert(_ table: String, _ values: [String: JSONValue]) -> MutationResult {
        mutate(table, values, mode: .insert)
    }
    public func update(_ table: String, _ values: [String: JSONValue],
                       expectedUpdatedAt: String? = nil) -> MutationResult {
        mutate(table, values, mode: .update, expectedUpdatedAt: expectedUpdatedAt)
    }
    public func upsert(_ table: String, _ values: [String: JSONValue],
                       expectedUpdatedAt: String? = nil) -> MutationResult {
        mutate(table, values, mode: .upsert, expectedUpdatedAt: expectedUpdatedAt)
    }
    /// Soft-delete a row by id (parity with the TS/Kotlin engines): marks it deleted so
    /// the deletion replicates as a tombstone (a hard local delete would resurrect from a
    /// peer on the next pull) and `isDeleted`-filtered queries stop returning it.
    /// Idempotent — deleting a not-yet-local id writes a superseding tombstone.
    public func delete(_ table: String, id: String,
                       expectedUpdatedAt: String? = nil) -> MutationResult {
        mutate(table, ["id": .string(id)], mode: .delete,
               expectedUpdatedAt: expectedUpdatedAt)
    }

    /// Restore exactly the tombstone identified by `expectedUpdatedAt`. A
    /// missing, live, or newer row returns a write conflict.
    public func restore(_ table: String, id: String,
                        expectedUpdatedAt: String) -> MutationResult {
        mutate(table, ["id": .string(id)], mode: .restore,
               expectedUpdatedAt: expectedUpdatedAt, expectedDeleted: true)
    }

    fileprivate enum Mode { case insert, update, upsert, delete, restore }

    private struct PreparedRow {
        let table: String
        let id: String
        let hlc: String
        let merged: [String: JSONValue]
        let expectedUpdatedAt: String?
        let expectedDeleted: Bool
    }

    private struct PreparedOutbox {
        let eventId: String
        let envelopeJson: String
    }

    private struct PullPage {
        let changed: Set<String>
        let pulled: Int
    }

    /// Validate + merge + stamp the HLC for one write, WITHOUT touching the database.
    /// Split out of the write so `batch` can prepare every op up front and fail
    /// atomically before anything is written. Must be called under `lock`.
    private func prepareRow(_ table: String, _ values: [String: JSONValue], mode: Mode,
                            expectedUpdatedAt: String? = nil,
                            expectedDeleted: Bool = false) -> (PreparedRow?, String?) {
        guard store.driver != nil, let clock else { return (nil, "Database not ready.") }
        guard schema.has(table) else { return (nil, "Unknown table: \(table)") }
        let id: String
        if let supplied = values["id"] {
            guard case .string(let value) = supplied, !value.isEmpty else {
                return (nil, "\(table).id: Expected a non-empty id string.")
            }
            id = value
        } else {
            id = createId()
        }
        let existing = mode == .insert ? nil : store.readRow(table, id: id)
        if mode == .update, existing == nil { return (nil, "Row not found: \(id)") }

        var merged: [String: JSONValue] = existing.map(Self.rowToJson) ?? [:]
        var coerceInput = values
        coerceInput["id"] = .string(id)
        let (coerced, error) = store.coerceValues(table, coerceInput)
        if let error { return (nil, error) }
        for (k, v) in coerced { merged[k] = v }
        if let provided = values["isDeleted"] {
            guard case .int(let flag) = provided, flag == 0 || flag == 1 else {
                return (nil, "\(table).isDeleted: Expected a SQLite boolean (0 or 1).")
            }
            merged["isDeleted"] = provided
        }
        // DELETE forces the tombstone flag so the deletion replicates and wins LWW.
        if mode == .delete { merged["isDeleted"] = sqliteTrue }
        else if mode == .restore { merged["isDeleted"] = sqliteFalse }

        let hlc: String
        if let supplied = values["updatedAt"] {
            guard case .string(let provided) = supplied else {
                return (nil, "\(table).updatedAt: Expected a valid SimplySync HLC.")
            }
            guard clock.observe(provided) else {
                return (nil, "updatedAt must be a valid, non-future SimplySync HLC.")
            }
            // A caller-supplied stamp bypasses the clock, so it can sort at or
            // below the row's current version: peers would keep their copy under
            // last-writer-wins while this device overwrote its own, and the next
            // ordinary edit would replicate the regressed values. Equal is refused
            // too — the outbox is keyed by HLC, so the event would be dropped while
            // its row committed. Checked whatever the mode: insert overwrites too.
            let current = store.readRow(table, id: id)
            if case .text(let currentHlc)? = current?["updatedAt"],
               HLC.compare(currentHlc, provided) >= 0 {
                return (nil, "\(table).updatedAt: must be newer than the row's current version.")
            }
            if store.hasQueuedEvent(provided) {
                return (nil, "\(table).updatedAt: collides with an event already queued for sync.")
            }
            hlc = provided
        } else {
            hlc = clock.nextHlc()
        }
        merged["id"] = .string(id)
        merged["updatedAt"] = .string(hlc)
        // Keep an existing createdAt; on insert use a caller-provided one
        // (demo/legacy backfill) or stamp now.
        if let provided = values["createdAt"] {
            guard case .string(let createdAt) = provided else {
                return (nil, "\(table).createdAt: Expected a string.")
            }
            if existing == nil { merged["createdAt"] = .string(createdAt) }
        }
        if merged["createdAt"] == nil { merged["createdAt"] = .string(Self.isoNow()) }
        if merged["isDeleted"] == nil { merged["isDeleted"] = sqliteFalse }

        return (PreparedRow(table: table, id: id, hlc: hlc, merged: merged,
                            expectedUpdatedAt: expectedUpdatedAt,
                            expectedDeleted: expectedDeleted), nil)
    }

    private struct MutationConflictError: LocalizedError {
        let table: String
        let rowId: String
        var errorDescription: String? {
            "Write conflict: \(table)/\(rowId) changed or was deleted."
        }
    }

    private func assertExpectedVersion(_ row: PreparedRow, driver: SqliteDriver) throws {
        guard let expected = row.expectedUpdatedAt else { return }
        let current = try driver.select(
            "select updatedAt, isDeleted from \"\(row.table)\" where id = ?",
            [.text(row.id)]
        ).first
        let expectedFlag: Int64 = row.expectedDeleted ? 1 : 0
        guard case .text(let actual)? = current?["updatedAt"], actual == expected,
              case .integer(let isDeleted)? = current?["isDeleted"],
              isDeleted == expectedFlag else {
            throw MutationConflictError(table: row.table, rowId: row.id)
        }
    }

    private func mutate(_ table: String, _ values: [String: JSONValue], mode: Mode,
                        expectedUpdatedAt: String? = nil,
                        expectedDeleted: Bool = false) -> MutationResult {
        let outcome: MutationResult = lock.withLock {
            guard let driver = store.driver else { return .failure(message: "Database not ready.") }
            let (prepared, error) = prepareRow(
                table, values, mode: mode, expectedUpdatedAt: expectedUpdatedAt,
                expectedDeleted: expectedDeleted)
            guard let prepared else { return .failure(message: error ?? "Mutation failed.") }
            do {
                let outbox = try prepareOutbox(
                    table: prepared.table, rowId: prepared.id,
                    hlc: prepared.hlc, value: prepared.merged)
                try driver.transaction {
                    try assertExpectedVersion(prepared, driver: driver)
                    try store.writeRow(prepared.table, prepared.merged)
                    try writeOutbox(outbox, using: driver)
                }
            } catch {
                return .failure(message: describe(error))
            }
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
    public final class BatchScope {
        fileprivate var specs: [(table: String, values: [String: JSONValue], mode: Mode,
                                 expectedUpdatedAt: String?)] = []
        public func insert(_ table: String, _ values: [String: JSONValue]) {
            specs.append((table, values, .insert, nil))
        }
        public func update(_ table: String, _ values: [String: JSONValue],
                           expectedUpdatedAt: String? = nil) {
            specs.append((table, values, .update, expectedUpdatedAt))
        }
        public func upsert(_ table: String, _ values: [String: JSONValue],
                           expectedUpdatedAt: String? = nil) {
            specs.append((table, values, .upsert, expectedUpdatedAt))
        }
        public func delete(_ table: String, id: String,
                           expectedUpdatedAt: String? = nil) {
            specs.append((table, ["id": .string(id)], .delete, expectedUpdatedAt))
        }
    }

    /// Immutable copy of a built batch that can cross into detached work. The
    /// operation dictionaries contain value-semantic `JSONValue`s; the engine
    /// itself serializes all clock/database state behind `lock`.
    private struct DetachedBatch: @unchecked Sendable {
        let specs: [(table: String, values: [String: JSONValue], mode: Mode,
                    expectedUpdatedAt: String?)]
    }

    /// Write many rows atomically: validate + merge every op first (one bad op aborts the
    /// whole batch before anything is written), then one transaction, one query refresh per
    /// affected table, and one sync. Mix in `delete` for atomic moves. Parity with TS `batch`.
    @discardableResult
    public func batch(_ build: (BatchScope) -> Void) -> BatchResult {
        let scope = BatchScope()
        build(scope)
        return executeBatch(scope.specs)
    }

    /// Async batch convenience for UI-isolated callers. Building the lightweight
    /// operation list stays on the caller; validation, row merging, HLC stamping,
    /// outbox sealing, and the SQLite transaction run on detached work so a large
    /// import cannot monopolize the main actor before its first suspension.
    @discardableResult
    public func batchAsync(_ build: (BatchScope) -> Void) async -> BatchResult {
        let scope = BatchScope()
        build(scope)
        let detached = DetachedBatch(specs: scope.specs)
        let work = Task.detached(priority: .userInitiated) { [self, detached] in
            executeBatch(detached.specs, cancelWhenTaskCancelled: true)
        }
        return await withTaskCancellationHandler {
            await work.value
        } onCancel: {
            work.cancel()
        }
    }

    private func executeBatch(
        _ specs: [(table: String, values: [String: JSONValue], mode: Mode,
                  expectedUpdatedAt: String?)],
        cancelWhenTaskCancelled: Bool = false
    ) -> BatchResult {
        let outcome: BatchResult = lock.withLock {
            guard let driver = store.driver else { return .failure(message: "Database not ready.") }
            var prepared: [PreparedRow] = []
            for spec in specs {
                if cancelWhenTaskCancelled, Task.isCancelled {
                    return .failure(message: "Batch cancelled.")
                }
                let (p, error) = prepareRow(
                    spec.table, spec.values, mode: spec.mode,
                    expectedUpdatedAt: spec.expectedUpdatedAt)
                guard let p else { return .failure(message: error ?? "Batch failed.") }
                prepared.append(p)
            }
            // Engine-minted HLCs are unique by construction; caller-supplied ones
            // are not, and two ops sharing one would leave a single outbox event
            // for two row writes.
            if Set(prepared.map { $0.hlc }).count != prepared.count {
                return .failure(message: "updatedAt: two ops in one batch share an HLC.")
            }
            do {
                if cancelWhenTaskCancelled, Task.isCancelled {
                    return .failure(message: "Batch cancelled.")
                }
                let outbox = try prepared.map {
                    try prepareOutbox(
                        table: $0.table, rowId: $0.id,
                        hlc: $0.hlc, value: $0.merged)
                }
                try driver.transaction {
                    for p in prepared {
                        try assertExpectedVersion(p, driver: driver)
                        try store.writeRow(p.table, p.merged)
                    }
                    for event in outbox { try writeOutbox(event, using: driver) }
                }
            } catch {
                return .failure(message: describe(error))
            }
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
    public func deleteMany(_ table: String, ids: [String]) -> BatchResult {
        batch { scope in for id in ids { scope.delete(table, id: id) } }
    }

    /// Reclaim tombstones only for a database that has never used a relay.
    /// Durable relay history keeps this disabled after transports are detached:
    /// without a cross-device deletion watermark, a long-offline peer could
    /// otherwise resurrect the row.
    @discardableResult
    public func purgeDeleted(olderThanMs: Int64 = 30 * 24 * 60 * 60 * 1000) -> Int {
        lock.withLock {
            if !transports.isEmpty || store.hasRelayHistory() { return 0 }
            let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
            return store.purgeDeleted(olderThanMs: olderThanMs, nowMs: nowMs, requirePushed: false)
        }
    }

    /// Encrypt before entering the SQLite transaction. The row and the resulting
    /// envelope are committed together, so a failed crypto/outbox write cannot
    /// leave a durable local mutation that will never replicate.
    private func prepareOutbox(
        table: String, rowId: String, hlc: String,
        value: [String: JSONValue]
    ) throws -> PreparedOutbox {
        guard let identity else { throw EngineError.identityNotReady }
        let payload = SyncPayload(schemaVersion: config.schemaVersion, table: table, op: "upsert",
                                  rowId: rowId, hlc: hlc, value: value)
        let envelope = try Envelope.encrypt(
            identity: identity, eventId: hlc, deviceId: deviceId,
            createdAt: Self.isoNow(), payload: payload)
        let data = try JSONEncoder().encode(envelope)
        guard let json = String(data: data, encoding: .utf8) else {
            throw EngineError.outboxEncodingFailed
        }
        return PreparedOutbox(eventId: hlc, envelopeJson: json)
    }

    private func writeOutbox(_ event: PreparedOutbox, using driver: SqliteDriver) throws {
        try driver.exec(
            "insert or ignore into \"\(Store.outboxTable)\" (event_id, envelope_json) values (?, ?)",
            [.text(event.eventId), .text(event.envelopeJson)])
    }

    /// Best-effort wrapper used only for a new relay's state backfill. Normal app
    /// mutations write their outbox entry atomically with the row above.
    private func enqueue(table: String, rowId: String, hlc: String, value: [String: JSONValue]) {
        guard let driver = store.driver,
              let event = try? prepareOutbox(
                table: table, rowId: rowId, hlc: hlc, value: value)
        else { return }
        try? writeOutbox(event, using: driver)
    }

    // MARK: - Sync

    /// Set transports (relays). Triggers an immediate sync and starts polling, or
    /// stops polling if cleared.
    public func setTransports(_ next: [Transport]) {
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
    public func sync() async {
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
        let replayed = await Task.detached(priority: .utility) { [self] in
            lock.withLock {
                var changed = replayEligibleOpaquePage()
                changed.formUnion(replayDueDeferred())
                return changed
            }
        }.value
        lock.withLock {
            if !replayed.isEmpty { cache.refreshQueries(replayed) }
        }
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
                backfillOutboxForNewRelay(base: base)
                // A full batch means more local events may remain. Drain them in
                // this sync pass so `.synced` never means "up to 1000 pushed."
                var pushed = 0
                while true {
                    let batch = try await pushOutbox(base: base, identity: identity)
                    pushed += batch
                    if batch < 1000 { break }
                }
                // Nothing left to send means the post-wipe re-seed has landed and
                // this relay holds a full copy again. Checked after the drain, so
                // the pass that detects the wipe (push runs before pull) can't
                // clear it.
                if pushed == 0 { lock.withLock { reseedingRelays.remove(base) } }
                // Pull every relay page as well. A non-empty page that does not
                // advance its cursor is a relay bug/replay; stop rather than
                // spinning forever and retry it on the next sync.
                while true {
                    let cursorKey = "cursor:\(base)"
                    let before = lock.withLock { store.getMeta(cursorKey) ?? "" }
                    let page = try await pullAndApply(base: base, identity: identity)
                    changed.formUnion(page.changed)
                    let after = lock.withLock { store.getMeta(cursorKey) ?? "" }
                    if page.pulled == 0 || after == before { break }
                }
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
        if let failure = error as? SyncTransportFailure {
            return (failure.kind, nil, failure.message)
        }
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

    private func pushOutbox(base: String, identity: Identity) async throws -> Int {
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
        if pending.isEmpty { return 0 }
        let envelopes = pending.compactMap { item -> SyncEnvelope? in
            guard let data = item.json.data(using: .utf8) else { return nil }
            return try? JSONDecoder().decode(SyncEnvelope.self, from: data)
        }
        guard let relay = transport(for: base, identity: identity) else { return 0 }
        _ = try await relay.push(envelopes)
        let pushedAt = Self.isoNow()
        lock.withLock {
            // The owner changed while this request was in flight (restore/reset
            // wiped the outbox). Recording delivery now would write the OLD
            // owner's push cursor into the NEW owner's metadata, which skips
            // its first backfill.
            guard self.identity?.ownerId == identity.ownerId else { return }
            for item in pending {
                // `pushed_at` marks "reached at least one relay" — keep the earliest via coalesce.
                try? store.driver?.exec(
                    "update \"\(Store.outboxTable)\" set pushed_at = coalesce(pushed_at, ?) where event_id = ?",
                    [.text(pushedAt), .text(item.eventId)])
            }
            if let last = pending.last?.eventId { store.setMeta(cursorKey, last) }
        }
        return pending.count
    }

    /// A relay added after the bounded outbox was pruned still needs the current
    /// owner state. Re-emit each row once under its existing HLC. The separate
    /// marker prevents rows pulled into an initially empty database from being
    /// echoed back to that same relay on the next cycle.
    private func backfillOutboxForNewRelay(base: String) {
        lock.withLock {
            let marker = "backfill:\(base)"
            guard store.getMeta(marker) == nil else { return }
            if store.getMeta("push:\(base)") != nil {
                store.setMeta(marker, "1")
                return
            }
            for table in schema.tableNames {
                let rows = (try? store.driver?.select("select * from \"\(table)\"")) ?? []
                for dbRow in rows {
                    // The row's HLC becomes the event id, and a relay refuses a
                    // whole push batch over one malformed id. A row that reached
                    // the table without a canonical stamp (raw SQL, a legacy
                    // import) can only be skipped here; queueing it would stall
                    // every later write behind it.
                    guard case .text(let rowId)? = dbRow["id"],
                          case .text(let hlc)? = dbRow["updatedAt"],
                          HLC.parse(hlc) != nil else { continue }
                    let value = Self.rowToJson(dbRow)
                    enqueue(table: table, rowId: rowId, hlc: hlc, value: value)
                }
            }
            store.setMeta(marker, "1")
        }
    }

    private func pullAndApply(base: String, identity: Identity) async throws -> PullPage {
        let cursorKey = "cursor:\(base)"
        let after = lock.withLock { store.getMeta(cursorKey) ?? "" }
        guard let relay = transport(for: base, identity: identity) else {
            return PullPage(changed: [], pulled: 0)
        }
        // An owner the relay has never seen is "nothing to pull yet", not a
        // failure: both reference relays create the owner on PUSH only, so pull
        // 404s until this account's first event lands. Treating it as an error
        // made a fresh install report a terminal sync failure and back its poller
        // off until the first write. Mirrors the TypeScript engine (relay.ts) and
        // the same 404 handling already used for /v1/status.
        let result: RelayClient.PullResult
        do {
            result = try await relay.pull(after: after)
        } catch let error as RelayClient.RelayError {
            if case .http(let status, _) = error, status == 404 {
                // A 404 for an owner we have ALREADY pulled from is different in
                // kind: the relay didn't miss our first push, it lost the
                // account. Repair, or the stale cursor stalls sync permanently
                // once the relay's seq counter restarts below it.
                if !after.isEmpty { handleWipedRelay(base: base) }
                return PullPage(changed: [], pulled: 0)
            }
            throw error
        }
        return lock.withLock {
            // The await above is a window in which restoreAppOwner/resetAppOwner
            // can swap the owner and wipe the database. This page was fetched for
            // the previous owner: applying it would leak that owner's rows into
            // the new owner's database, and recording its cursor would make the
            // new owner's first pull skip everything below it. Drop the page; the
            // pass the switch queued re-pulls under the new owner.
            guard self.identity?.ownerId == identity.ownerId else {
                return PullPage(changed: [], pulled: 0)
            }
            var changed = Set<String>()
            for envelope in result.events {
                let seen = (try? store.driver?.select(
                    "select 1 from \"\(Store.seenTable)\" where event_id = ?", [.text(envelope.eventId)])) ?? []
                if !seen.isEmpty { continue }
                let payload: SyncPayload
                do {
                    payload = try Envelope.decrypt(identity: identity, envelope: envelope)
                } catch {
                    // A GCM tag failure means storage corruption or relay
                    // tampering — the one event the threat model most wants
                    // surfaced (SECURITY.md: "the client rejects it"). The
                    // cursor still advances so it can't wedge the batch, but it
                    // must not be a silent drop.
                    setError("decrypt failed for event \(envelope.eventId)")
                    continue
                }
                let eventHlc = HLC.admissibility(envelope.eventId)
                if eventHlc == .malformed {
                    // Terminal protocol violation: mark seen below so it cannot
                    // wedge the relay cursor.
                } else if payload.schemaVersion > config.schemaVersion {
                    // Keep newer payloads opaque until an upgraded app declares
                    // support; projecting them through an older schema could
                    // silently reinterpret changed field meaning.
                    store.deferRemoteEvent(
                        eventId: envelope.eventId,
                        payloadJson: Envelope.encodePayload(payload))
                } else if payload.schemaVersion < 1 {
                    // Invalid and terminal: mark seen below so it cannot wedge
                    // the relay cursor or accumulate forever in deferred.
                } else if payload.hlc != envelope.eventId
                            || HLC.admissibility(payload.hlc) == .malformed {
                    // The signed envelope event id is the wire HLC. A mismatch
                    // would make relay compaction and client LWW disagree.
                } else if eventHlc == .future
                            || HLC.admissibility(payload.hlc) == .future {
                    // Keep authenticated future data until wall time catches
                    // up; dropping it would replace poisoning with data loss.
                    store.deferRemoteEvent(
                        eventId: envelope.eventId,
                        payloadJson: Envelope.encodePayload(payload),
                        retryAfterMs: futureRetryAfter(
                            eventId: envelope.eventId, payloadHlc: payload.hlc))
                } else if !(clock?.observe(payload.hlc) ?? false) {
                    // The wall clock moved backwards between classification and
                    // observation. Keep the event for a later retry.
                    store.deferRemoteEvent(
                        eventId: envelope.eventId,
                        payloadJson: Envelope.encodePayload(payload),
                        retryAfterMs: max(
                            Self.nowMillis() + 1_000,
                            futureRetryAfter(
                                eventId: envelope.eventId, payloadHlc: payload.hlc)))
                } else if schema.has(payload.table) {
                    switch applyRemoteRow(payload) {
                    case .applied: changed.insert(payload.table)
                    case .unchanged: break
                    case .failed:
                        // Authenticated data this build cannot write (a column
                        // it lacks, a value its type refuses). Retained opaquely
                        // for the upgrade that can, as the TypeScript engine
                        // does — dropping it would be silent data loss.
                        store.deferRemoteEvent(
                            eventId: envelope.eventId,
                            payloadJson: Envelope.encodePayload(payload))
                        setError("could not apply event \(envelope.eventId); retained for a later build")
                    }
                } else {
                    store.deferRemoteEvent(
                        eventId: envelope.eventId,
                        payloadJson: Envelope.encodePayload(payload))
                }
                try? store.driver?.exec(
                    "insert or ignore into \"\(Store.seenTable)\" (event_id) values (?)", [.text(envelope.eventId)])
            }
            store.setMeta(cursorKey, result.nextCursor)
            return PullPage(changed: changed, pulled: result.events.count)
        }
    }

    private func futureRetryAfter(eventId: String, payloadHlc: String) -> Int64 {
        let eventMillis = HLC.parse(eventId)?.millis ?? 0
        let payloadMillis = HLC.parse(payloadHlc)?.millis ?? 0
        return max(eventMillis, payloadMillis) - HLC.maxFutureDriftMillis
    }

    @discardableResult
    private func replayDeferredRows(
        _ items: [(eventId: String, payloadJson: String)]
    ) -> Set<String> {
        var changed = Set<String>()
        for item in items {
            guard let payload = try? Envelope.decodePayload(item.payloadJson) else {
                store.dropDeferredEvent(item.eventId)
                continue
            }
            if payload.schemaVersion > config.schemaVersion {
                store.deferRemoteEvent(
                    eventId: item.eventId, payloadJson: item.payloadJson)
                continue
            }
            guard payload.schemaVersion >= 1 else {
                store.dropDeferredEvent(item.eventId)
                continue
            }
            let eventHlc = HLC.admissibility(item.eventId)
            let payloadHlc = HLC.admissibility(payload.hlc)
            if eventHlc == .future || payloadHlc == .future {
                store.deferRemoteEvent(
                    eventId: item.eventId, payloadJson: item.payloadJson,
                    retryAfterMs: futureRetryAfter(
                        eventId: item.eventId, payloadHlc: payload.hlc))
                continue
            }
            guard eventHlc != .malformed,
                  payloadHlc != .malformed,
                  payload.hlc == item.eventId else {
                store.dropDeferredEvent(item.eventId)
                continue
            }
            guard schema.has(payload.table) else {
                store.deferRemoteEvent(
                    eventId: item.eventId, payloadJson: item.payloadJson)
                continue
            }
            guard clock?.observe(payload.hlc) ?? false else {
                store.deferRemoteEvent(
                    eventId: item.eventId, payloadJson: item.payloadJson,
                    retryAfterMs: max(
                        Self.nowMillis() + 1_000,
                        futureRetryAfter(
                            eventId: item.eventId, payloadHlc: payload.hlc)))
                continue
            }
            switch applyRemoteRow(payload) {
            case .applied:
                changed.insert(payload.table)
                store.dropDeferredEvent(item.eventId)
            case .unchanged:
                store.dropDeferredEvent(item.eventId)
            case .failed:
                // Still unwritable against this schema: keep it opaque (no retry
                // time) so only the once-per-schema sweep reconsiders it.
                store.deferRemoteEvent(
                    eventId: item.eventId, payloadJson: item.payloadJson)
            }
        }
        return changed
    }

    private var deferredSchemaToken: String {
        let tableTokens = schema.tableNames.map { table in
            let columns = schema.columns(of: table) ?? [:]
            let columnToken = columns.keys.sorted().map { name in
                let column = columns[name]!
                return "\(name):\(column.name):\(column.sqlite):\(column.nullable)"
            }.joined(separator: ",")
            return "\(table){\(columnToken)}"
        }
        return "\(config.schemaVersion)|\(tableTokens.joined(separator: ";"))"
    }

    /// Advance at most one opaque page for a new supported-schema token. The
    /// target and cursor are durable, so later syncs finish a large backlog
    /// without ever rescanning it after this schema's pass completes.
    private func replayEligibleOpaquePage() -> Set<String> {
        let token = deferredSchemaToken
        if store.getMeta(deferredScanCompleteKey) == token { return [] }
        if store.getMeta(deferredScanActiveKey) != token {
            store.setMeta(deferredScanActiveKey, token)
            store.setMeta(deferredScanCursorKey, "")
        }
        let cursor = store.getMeta(deferredScanCursorKey).flatMap {
            $0.isEmpty ? nil : $0
        }
        let page = store.opaqueDeferredEvents(
            afterEventId: cursor, limit: deferredReplayLimit)
        let changed = replayDeferredRows(page)
        if page.count < deferredReplayLimit {
            store.setMeta(deferredScanCompleteKey, token)
            store.setMeta(deferredScanActiveKey, "")
            store.setMeta(deferredScanCursorKey, "")
        } else if let last = page.last?.eventId {
            store.setMeta(deferredScanCursorKey, last)
        }
        return changed
    }

    private func replayDeferredAtBoot() async -> Set<String> {
        lock.withLock {
            var changed = replayEligibleOpaquePage()
            changed.formUnion(replayDueDeferred())
            return changed
        }
    }

    private func replayDueDeferred() -> Set<String> {
        replayDeferredRows(store.dueDeferredEvents(
            nowMs: Self.nowMillis(), limit: deferredReplayLimit))
    }

    /// What became of one decrypted row. `unchanged` means last-writer-wins
    /// kept the local copy; `failed` means this build could not write it, which
    /// callers retain rather than discard.
    private enum ApplyOutcome { case applied, unchanged, failed }

    /// Apply one decrypted row, last-writer-wins by `updatedAt`. Called under lock.
    private func applyRemoteRow(_ payload: SyncPayload) -> ApplyOutcome {
        guard !payload.rowId.isEmpty else { return .failed }
        if let existing = store.readRow(payload.table, id: payload.rowId),
           case .text(let updatedAt)? = existing["updatedAt"],
           HLC.compare(updatedAt, payload.hlc) >= 0 {
            return .unchanged
        }
        var row = payload.value
        row["id"] = .string(payload.rowId)
        // The top-level HLC is canonical on the wire; the nested row can carry
        // a stale value from a partial update (or omit it entirely).
        row["updatedAt"] = .string(payload.hlc)
        let projected = store.projectRemoteRow(payload.table, row)
        guard projected.error == nil else { return .failed }
        do {
            try store.writeRow(payload.table, projected.row)
            return .applied
        } catch {
            return .failed
        }
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
    public func getRelayStatuses() async -> [RelayStatus] {
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
        status.reseeding = lock.withLock { reseedingRelays.contains(base) }
        guard let identity else { return status }
        // A transport the app supplied (iCloud, …) has no `/v1/status` to probe:
        // its reachability is simply how the last sync pass went.
        if transportFactory?(base, identity) != nil {
            status.reachable = health?.lastSyncedAt != nil && health?.lastFailure == nil
            return status
        }
        guard let url = URL(string: base) else { return status }
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
            // The relay still knows the owner but holds nothing for it while we
            // have pulled from it before: truncated, or restored from an older
            // backup, which the pull 404 can't see because the owner row
            // survived. `events == 0` is required as well as a `headSeq` behind
            // our cursor — stream compaction legitimately lowers `max(seq)` over
            // surviving rows and must not look like data loss.
            let localCursor = Int64(lock.withLock { store.getMeta("cursor:\(base)") ?? "" }) ?? 0
            if body.account.headSeq < localCursor, body.account.events == 0 {
                handleWipedRelay(base: base)
            }
            status.reseeding = lock.withLock { reseedingRelays.contains(base) }
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
                    let ms = self?.lock.withLock { self?.pollIntervalMs } ?? 60_000
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

    public func getSyncState() -> SyncState { lock.withLock { syncStateValue } }

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

    private static func nowMillis() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1_000)
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
public func createSync(
    _ deps: SyncEngineDeps
) -> (Schema, SyncEngineConfig) -> SyncEngine {
    { schema, config in SyncEngine(schema: schema, config: config, deps: deps) }
}
