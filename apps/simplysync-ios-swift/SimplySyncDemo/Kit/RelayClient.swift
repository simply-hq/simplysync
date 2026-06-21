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

    private func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }
        guard (200..<300).contains(http.statusCode) else {
            throw RelayError.http(status: http.statusCode,
                                  body: String(data: data, encoding: .utf8) ?? "")
        }
    }
}
