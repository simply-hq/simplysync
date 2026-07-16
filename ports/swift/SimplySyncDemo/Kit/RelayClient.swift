import Foundation

/// Talks to the simplysync relay's `/v1/events` endpoints. The relay only ever
/// sees opaque ciphertext — this client uploads/downloads `SyncEnvelope`s and
/// authenticates with the owner's `relayAuth` as a bearer token.
struct RelayClient {
    let baseURL: URL
    let ownerId: String
    let relayAuth: String
    var session: URLSession = .shared
    var pullLimit = 500

    struct PushResult { let accepted: Int; let duplicate: Int }
    struct PullResult { let events: [SyncEnvelope]; let nextCursor: String }

    /// GET /v1/status response — per-owner health + quota + head cursor. The
    /// shape is identical across all reference relays (Bun, Go, Cloudflare).
    struct Status: Decodable {
        struct Server: Decodable {
            let version: String
            let serverTime: String
        }
        struct Account: Decodable {
            let ownerId: String
            let quotaBytes: Int64
            let usedBytes: Int64
            let usedPct: Double
            let headSeq: Int64
            let streams: Int64
            let events: Int64
            let createdAt: String
        }
        let server: Server
        let account: Account
    }

    /// GET /health response — public liveness probe (no auth).
    struct Health: Decodable {
        let ok: Bool
        let service: String
        let version: String?
        let serverTime: String?
    }

    private struct PushBody: Encodable { let ownerId: String; let events: [SyncEnvelope] }
    private struct PushResponse: Decodable { let accepted: Int; let duplicate: Int }
    private struct PullResponse: Decodable { let events: [SyncEnvelope]; let nextCursor: String }

    enum RelayError: Error { case http(status: Int, body: String), badURL }

    /// POST /v1/events — upload local events. Idempotent: the relay dedupes by
    /// `(ownerId, eventId)`.
    func push(_ events: [SyncEnvelope]) async throws -> PushResult {
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
    func pull(after cursor: String) async throws -> PullResult {
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
    func status() async throws -> Status {
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
    func health() async throws -> Health {
        let request = URLRequest(url: baseURL.appendingPathComponent("health"))
        let (data, response) = try await session.data(for: request)
        try check(response, data)
        return try JSONDecoder().decode(Health.self, from: data)
    }

    private func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw RelayError.http(status: http.statusCode,
                                  body: String(data: data, encoding: .utf8) ?? "")
        }
    }
}
