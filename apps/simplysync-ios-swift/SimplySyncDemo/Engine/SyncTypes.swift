import Foundation

/// The result of a mutation — the Swift port of the engine's `MutationResult`.
/// `switch` on it, or use `isOk` / `id` / `errorMessage`.
enum MutationResult: Equatable {
    case ok(id: String)
    case failure(message: String)

    var isOk: Bool { if case .ok = self { return true }; return false }
    var id: String? { if case .ok(let id) = self { return id }; return nil }
    var errorMessage: String? { if case .failure(let m) = self { return m }; return nil }
}

/// The result of an atomic `batch` — the Swift port of the engine's `BatchResult`.
enum BatchResult: Equatable {
    case ok(ids: [String])
    case failure(message: String)

    var isOk: Bool { if case .ok = self { return true }; return false }
    var ids: [String] { if case .ok(let ids) = self { return ids }; return [] }
    var errorMessage: String? { if case .failure(let m) = self { return m }; return nil }
}

/// The current owner — the Swift port of `AppOwner`. `recoveryKey` is the secret
/// to back up (an `sf1_` key or a 24-word phrase); `mnemonic` is non-nil only
/// when the owner was derived from a phrase. `writeKey` is the relay bearer token.
struct AppOwner: Equatable {
    let id: String
    let recoveryKey: String
    let writeKey: String
    let mnemonic: String?
}

/// A relay endpoint — the Swift port of `Transport`.
struct Transport: Equatable {
    enum Kind: String { case http = "Http", webSocket = "WebSocket" }
    let type: Kind
    let url: String
    init(type: Kind = .http, url: String) { self.type = type; self.url = url }
}

/// Live sync status — the Swift port of `SyncState`. A `terminal` failure
/// (auth/quota/bad-request) won't fix itself by retrying the same batch, so the
/// engine backs the poller off.
enum SyncState: Equatable {
    case initial
    case syncing
    case synced(lastSyncedAt: String)
    case notSynced(error: String?, terminal: Bool, status: Int?)
}

/// A secondary index to create on boot (the `indexes` config analog).
struct Index {
    let name: String
    let table: String
    let columns: [String]
    init(_ name: String, on table: String, columns: [String]) {
        self.name = name; self.table = table; self.columns = columns
    }
}

/// Engine configuration — the Swift port of `SyncEngineConfig`.
struct SyncEngineConfig {
    let name: String
    var transports: [Transport]
    var externalAppOwner: AppOwner?
    var syncIntervalMs: Int
    var indexes: [Index]

    init(name: String, transports: [Transport] = [], externalAppOwner: AppOwner? = nil,
         syncIntervalMs: Int = 5000, indexes: [Index] = []) {
        self.name = name
        self.transports = transports
        self.externalAppOwner = externalAppOwner
        self.syncIntervalMs = syncIntervalMs
        self.indexes = indexes
    }
}

/// Platform plumbing injected once — the Swift port of `SyncEngineDeps`. Provide
/// a SQLite driver factory and a secure store; `reloadApp` is called after
/// restore/reset so the UI re-evaluates against the new owner.
struct SyncEngineDeps {
    let makeDriver: (String) throws -> SqliteDriver
    let secureStorage: SecureStorage
    var reloadApp: (() -> Void)?
    var urlSession: URLSession

    init(makeDriver: @escaping (String) throws -> SqliteDriver,
         secureStorage: SecureStorage,
         reloadApp: (() -> Void)? = nil,
         urlSession: URLSession = .shared) {
        self.makeDriver = makeDriver
        self.secureStorage = secureStorage
        self.reloadApp = reloadApp
        self.urlSession = urlSession
    }
}
