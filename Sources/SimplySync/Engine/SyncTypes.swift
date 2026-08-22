import Foundation

/// The result of a mutation — the Swift port of the engine's `MutationResult`.
/// `switch` on it, or use `isOk` / `id` / `errorMessage`.
public enum MutationResult: Equatable {
    case ok(id: String)
    case failure(message: String)

    public var isOk: Bool { if case .ok = self { return true }; return false }
    public var id: String? { if case .ok(let id) = self { return id }; return nil }
    public var errorMessage: String? { if case .failure(let m) = self { return m }; return nil }
}

/// The result of an atomic `batch` — the Swift port of the engine's `BatchResult`.
public enum BatchResult: Equatable {
    case ok(ids: [String])
    case failure(message: String)

    public var isOk: Bool { if case .ok = self { return true }; return false }
    public var ids: [String] { if case .ok(let ids) = self { return ids }; return [] }
    public var errorMessage: String? { if case .failure(let m) = self { return m }; return nil }
}

/// The current owner — the Swift port of `AppOwner`. `recoveryKey` is the secret
/// to back up (an `sf1_` key or a 24-word phrase); `mnemonic` is non-nil only
/// when the owner was derived from a phrase. `writeKey` is the relay bearer token.
public struct AppOwner: Equatable {
    public let id: String
    public let recoveryKey: String
    public let writeKey: String
    public let mnemonic: String?

    public init(id: String, recoveryKey: String, writeKey: String, mnemonic: String? = nil) {
        self.id = id
        self.recoveryKey = recoveryKey
        self.writeKey = writeKey
        self.mnemonic = mnemonic
    }

    /// Derive a portable owner from either an `sf1_` key or a BIP39 phrase.
    public init(recoveryKey: String) throws {
        let identity = try IdentityDeriver.derive(from: recoveryKey)
        self.init(
            id: identity.ownerId,
            recoveryKey: identity.recoveryKey,
            writeKey: identity.relayAuth,
            mnemonic: identity.mnemonic
        )
    }
}

/// A relay endpoint — the Swift port of `Transport`.
public struct Transport: Equatable {
    public enum Kind: String { case http = "Http", webSocket = "WebSocket" }
    public let type: Kind
    public let url: String
    public init(type: Kind = .http, url: String) { self.type = type; self.url = url }
}

/// Live sync status — the Swift port of `SyncState`. A `terminal` failure
/// (auth/quota/bad-request) won't fix itself by retrying the same batch, so the
/// engine backs the poller off.
public enum SyncState: Equatable {
    case initial
    case syncing
    case synced(lastSyncedAt: String)
    case notSynced(error: String?, terminal: Bool, status: Int?)
}

/// Per-relay status + storage usage — the Swift port of `RelayStatus`. One entry
/// per configured relay from `engine.getRelayStatuses()`. The account block
/// (`usedBytes`…`events`) is absent when the relay is unreachable or this owner
/// has never pushed to it (the relay answers 404 until then).
public struct RelayStatus: Equatable {
    /// Most recent failure talking to a relay (sync or status probe). `kind` is
    /// the TS `SyncFailureKind` taxonomy this engine can produce: "authRejected"
    /// (401/403), "quotaExceeded" (413), "rateLimited" (429), "serverError"
    /// (5xx), "badRequest" (other 4xx), or "unreachable" (network-level).
    public struct Failure: Equatable {
        public let kind: String
        public let message: String
        public let at: String
    }

    /// Relay base URL, normalized (wss:// → https://).
    public let url: String
    /// True when the relay answered the status probe (even with no account).
    public var reachable: Bool
    /// Last successful sync with this relay this session (ISO8601).
    public var lastSyncedAt: String?
    /// Most recent failure talking to this relay (sync or status probe).
    public var lastFailure: Failure?
    /// Relay software version (from /v1/status, or /health when no account).
    public var version: String?
    /// Bytes of this owner's data the relay currently stores.
    public var usedBytes: Int64?
    /// The relay's per-owner storage limit in bytes.
    public var quotaBytes: Int64?
    /// usedBytes / quotaBytes × 100, as reported by the relay.
    public var usedPct: Double?
    /// The relay's newest event sequence for this owner (pull-cursor head).
    public var headSeq: Int64?
    /// Distinct streams (≈ live rows) the relay holds for this owner.
    public var streams: Int64?
    /// Raw stored event count (shrinks when the relay compacts).
    public var events: Int64?
    /// True while this device is re-uploading the owner's rows because the relay
    /// lost its data (wiped volume, fresh deploy, or a restore from an older
    /// backup). Until it clears, peers are not receiving this device's edits.
    public var reseeding: Bool = false
}

/// A secondary index to create on boot (the `indexes` config analog).
public struct Index {
    public let name: String
    public let table: String
    public let columns: [String]
    public init(_ name: String, on table: String, columns: [String]) {
        self.name = name; self.table = table; self.columns = columns
    }
}

/// Engine configuration — the Swift port of `SyncEngineConfig`.
public struct SyncEngineConfig {
    public let name: String
    /// Highest sync-payload schema this app can interpret. Additive table or
    /// column changes stay on version 1; bump only when field meaning changes.
    public let schemaVersion: Int
    public var transports: [Transport]
    public var externalAppOwner: AppOwner?
    public var syncIntervalMs: Int
    public var indexes: [Index]

    public init(name: String, transports: [Transport] = [], externalAppOwner: AppOwner? = nil,
                syncIntervalMs: Int = 60_000, indexes: [Index] = [], schemaVersion: Int = 1) {
        precondition(schemaVersion >= 1, "SimplySync schemaVersion must be positive.")
        self.name = name
        self.schemaVersion = schemaVersion
        self.transports = transports
        self.externalAppOwner = externalAppOwner
        self.syncIntervalMs = syncIntervalMs
        self.indexes = indexes
    }
}

/// Platform plumbing injected once — the Swift port of `SyncEngineDeps`. Provide
/// a SQLite driver factory and a secure store; `reloadApp` is called after
/// restore/reset so the UI re-evaluates against the new owner.
public struct SyncEngineDeps {
    public let makeDriver: (String) throws -> SqliteDriver
    public let secureStorage: SecureStorage
    public var reloadApp: (() -> Void)?
    public var urlSession: URLSession

    public init(makeDriver: @escaping (String) throws -> SqliteDriver,
                secureStorage: SecureStorage,
                reloadApp: (() -> Void)? = nil,
                urlSession: URLSession = .shared) {
        self.makeDriver = makeDriver
        self.secureStorage = secureStorage
        self.reloadApp = reloadApp
        self.urlSession = urlSession
    }
}
