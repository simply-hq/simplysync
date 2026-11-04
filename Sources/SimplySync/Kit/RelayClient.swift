import Foundation

/// Anything that can park an owner's encrypted event log and hand it back in
/// order: the simplysync relay today, a platform store (CloudKit, Drive, …) in
/// an app port. The engine only ever moves opaque `SyncEnvelope`s through it.
///
/// `id` names this transport's cursor keys in the engine's metadata
/// (`push:<id>`, `cursor:<id>`). For a relay it is the base URL string, so
/// databases written before this seam existed keep every cursor they had.
public protocol SyncTransport {
    var id: String { get }
    /// Upload events. Idempotent: a transport dedupes by event id and reports
    /// the already-known ones as `duplicate`.
    func push(_ events: [SyncEnvelope]) async throws -> RelayClient.PushResult
    /// Download events after `cursor` (`""` = from the beginning). A page with
    /// no events, or whose `nextCursor` equals `cursor`, means "drained".
    func pull(after cursor: String) async throws -> RelayClient.PullResult
}

/// A failure from a transport that has no HTTP status to classify (iCloud, …),
/// already mapped onto the engine's failure kinds: "authRejected",
/// "quotaExceeded", "rateLimited", "serverError", "badRequest", or
/// "unreachable". The first three plus "badRequest" back the poller off,
/// exactly as the matching HTTP statuses do for a relay.
public struct SyncTransportFailure: Error, Equatable {
    public let kind: String
    public let message: String
    public init(kind: String, message: String) {
        self.kind = kind
        self.message = message
    }
}

/// Talks to the simplysync relay's `/v1/events` endpoints. The relay only ever
/// sees opaque ciphertext — this client uploads/downloads `SyncEnvelope`s and
/// authenticates with the owner's `relayAuth` as a bearer token.
public struct RelayClient {
    public let baseURL: URL
    public let ownerId: String
    public let relayAuth: String
    public var session: URLSession
    public var pullLimit: Int

    public init(
        baseURL: URL,
        ownerId: String,
        relayAuth: String,
        session: URLSession = .shared,
        pullLimit: Int = 500
    ) {
        self.baseURL = baseURL
        self.ownerId = ownerId
        self.relayAuth = relayAuth
        self.session = session
        self.pullLimit = pullLimit
    }

    public struct PushResult {
        public let accepted: Int
        public let duplicate: Int
        public init(accepted: Int, duplicate: Int) {
            self.accepted = accepted
            self.duplicate = duplicate
        }
    }
    public struct PullResult {
        public let events: [SyncEnvelope]
        public let nextCursor: String
        public init(events: [SyncEnvelope], nextCursor: String) {
            self.events = events
            self.nextCursor = nextCursor
        }
    }

    /// GET /v1/status response — per-owner health + quota + head cursor. The
    /// shape is identical across all reference relays (Bun, Go, Cloudflare).
    public struct Status: Decodable {
        public struct Server: Decodable {
            public let version: String
            public let serverTime: String
        }
        public struct Account: Decodable {
            public let ownerId: String
            public let quotaBytes: Int64
            public let usedBytes: Int64
            public let usedPct: Double
            public let headSeq: Int64
            public let streams: Int64
            public let events: Int64
            public let createdAt: String
        }
        public let server: Server
        public let account: Account
    }

    /// GET /health response — public liveness probe (no auth).
    public struct Health: Decodable {
        public let ok: Bool
        public let service: String
        public let version: String?
        public let serverTime: String?
    }

    private struct PushBody: Encodable { let ownerId: String; let events: [SyncEnvelope] }
    private struct PushResponse: Decodable { let accepted: Int; let duplicate: Int }
    private struct PullResponse: Decodable { let events: [SyncEnvelope]; let nextCursor: String }

    public enum RelayError: Error { case http(status: Int, body: String), badURL }

    /// POST /v1/events — upload local events. Idempotent: the relay dedupes by
    /// `(ownerId, eventId)`.
    public func push(_ events: [SyncEnvelope]) async throws -> PushResult {
        var request = URLRequest(url: baseURL.appendingPathComponent("v1/events"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(relayAuth)", forHTTPHeaderField: "Authorization")
        request.httpBody = try JSONEncoder().encode(PushBody(ownerId: ownerId, events: events))

        let (data, response) = try await session.data(for: request)
        try check(response, data)
        let decoded = try JSONDecoder().decode(PushResponse.self, from: data)
        return PushResult(accepted: decoded.accepted, duplicate: decoded.duplicate)
    }

    /// GET /v1/events?ownerId=&after=&limit= — download events after the cursor.
    /// URLSession negotiates gzip and decompresses transparently.
    public func pull(after cursor: String) async throws -> PullResult {
        guard var components = URLComponents(url: baseURL.appendingPathComponent("v1/events"),
                                             resolvingAgainstBaseURL: false) else {
            throw RelayError.badURL
        }
        components.queryItems = [
            URLQueryItem(name: "ownerId", value: ownerId),
            URLQueryItem(name: "after", value: cursor),
            URLQueryItem(name: "limit", value: String(pullLimit)),
        ]
        guard let url = components.url else { throw RelayError.badURL }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(relayAuth)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        try check(response, data)
        let decoded = try JSONDecoder().decode(PullResponse.self, from: data)
        return PullResult(events: decoded.events, nextCursor: decoded.nextCursor)
    }

    /// GET /v1/status?ownerId= — per-owner health + quota + head cursor. A
    /// reachable relay this owner has never pushed to answers 404, which the
    /// caller can read as "relay up, account empty".
    public func status() async throws -> Status {
        guard var components = URLComponents(url: baseURL.appendingPathComponent("v1/status"),
                                             resolvingAgainstBaseURL: false) else {
            throw RelayError.badURL
        }
        components.queryItems = [URLQueryItem(name: "ownerId", value: ownerId)]
        guard let url = components.url else { throw RelayError.badURL }

        var request = URLRequest(url: url)
        request.setValue("Bearer \(relayAuth)", forHTTPHeaderField: "Authorization")

        let (data, response) = try await session.data(for: request)
        try check(response, data)
        return try JSONDecoder().decode(Status.self, from: data)
    }

    /// GET /health — public liveness probe (no auth). Confirms the relay process
    /// is up independent of the owner's account state.
    public func health() async throws -> Health {
        let request = URLRequest(url: baseURL.appendingPathComponent("health"))
        let (data, response) = try await session.data(for: request)
        try check(response, data)
        return try JSONDecoder().decode(Health.self, from: data)
    }

    /// HEAD /v1/blobs/:hash — whether the relay already holds this chunk.
    public func hasBlob(_ hash: String) async throws -> Bool {
        var request = try blobRequest(hash)
        request.httpMethod = "HEAD"
        let (data, response) = try await session.data(for: request)
        if (response as? HTTPURLResponse)?.statusCode == 404 { return false }
        try check(response, data)
        return true
    }

    /// PUT /v1/blobs/:hash — upload one stored chunk (`nonce ‖ ciphertext`). The
    /// relay recomputes the hash and dedupes, so re-uploading is harmless.
    public func putBlob(_ hash: String, _ bytes: Data) async throws {
        var request = try blobRequest(hash)
        request.httpMethod = "PUT"
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.upload(for: request, from: bytes)
        try check(response, data)
    }

    /// GET /v1/blobs/:hash — the stored chunk bytes, or nil when the relay has none.
    public func getBlob(_ hash: String) async throws -> Data? {
        let (data, response) = try await session.data(for: try blobRequest(hash))
        if (response as? HTTPURLResponse)?.statusCode == 404 { return nil }
        try check(response, data)
        return data
    }

    private func blobRequest(_ hash: String) throws -> URLRequest {
        guard var components = URLComponents(url: baseURL.appendingPathComponent("v1/blobs/\(hash)"),
                                             resolvingAgainstBaseURL: false) else {
            throw RelayError.badURL
        }
        components.queryItems = [URLQueryItem(name: "ownerId", value: ownerId)]
        guard let url = components.url else { throw RelayError.badURL }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(relayAuth)", forHTTPHeaderField: "Authorization")
        return request
    }

    private func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw RelayError.http(status: http.statusCode,
                                  body: String(data: data, encoding: .utf8) ?? "")
        }
    }
}

extension RelayClient: SyncTransport {
    public var id: String { baseURL.absoluteString }
}
