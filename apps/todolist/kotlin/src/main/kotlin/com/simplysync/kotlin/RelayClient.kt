package com.simplysync.kotlin

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Talks to the simplysync relay's `/v1/events` endpoints. The relay only ever
 * sees opaque ciphertext — this client uploads/downloads `SyncEnvelope`s and
 * authenticates with the owner's `relayAuth` as a bearer token.
 */
/** Public boundary mirrored by app-owned native ports; HTTP construction remains internal. */
interface RelayTransport {
    suspend fun push(events: List<SyncEnvelope>): RelayClient.PushResult
    suspend fun pull(after: String): RelayClient.PullResult
    suspend fun status(): RelayClient.StatusResponse
    suspend fun health(): RelayClient.HealthResponse
}

/**
 * Internal construction seam used by hermetic engine tests. It is deliberately
 * not part of SyncEngineDeps, so existing application constructors and binaries
 * keep the same public surface.
 */
internal object RelayTransportFactory {
    private val defaultFactory: (String, String, String) -> RelayTransport =
        { base, ownerId, relayAuth -> RelayClient(base, ownerId, relayAuth) }

    var create: (String, String, String) -> RelayTransport = defaultFactory

    fun reset() {
        create = defaultFactory
    }
}

class RelayClient(
    baseUrl: String,
    private val ownerId: String,
    private val relayAuth: String,
    private val pullLimit: Int = 500,
    private val client: OkHttpClient = sharedClient,
) : RelayTransport {
    private val base: String = baseUrl.trimEnd('/')

    data class PushResult(val accepted: Int, val duplicate: Int)
    data class PullResult(val events: List<SyncEnvelope>, val nextCursor: String)

    @Serializable
    private data class PushBody(val ownerId: String, val events: List<SyncEnvelope>)

    @Serializable
    private data class PushResponse(val accepted: Int = 0, val duplicate: Int = 0)

    @Serializable
    private data class PullResponse(val events: List<SyncEnvelope> = emptyList(), val nextCursor: String = "")

    // The /v1/status response shape shared by all reference relays (Bun, Go,
    // Cloudflare). Fields we don't surface (ownerId, createdAt) are ignored.
    @Serializable
    data class StatusServer(val version: String? = null, val serverTime: String? = null)

    @Serializable
    data class StatusAccount(
        val quotaBytes: Long? = null,
        val usedBytes: Long? = null,
        val usedPct: Double? = null,
        val headSeq: Long? = null,
        val streams: Long? = null,
        val events: Long? = null,
    )

    @Serializable
    data class StatusResponse(val server: StatusServer? = null, val account: StatusAccount? = null)

    /** The public `/health` response — liveness + version, no auth. */
    @Serializable
    data class HealthResponse(val ok: Boolean = false, val version: String? = null)

    class RelayException(val status: Int, val bodyText: String) :
        Exception("relay http $status: $bodyText")

    /** POST /v1/events — upload local events. Idempotent: the relay dedupes by (ownerId, eventId). */
    override suspend fun push(events: List<SyncEnvelope>): PushResult = withContext(Dispatchers.IO) {
        val payload = json.encodeToString(PushBody.serializer(), PushBody(ownerId, events))
        val request = Request.Builder()
            .url("$base/v1/events")
            .header("Authorization", "Bearer $relayAuth")
            .post(payload.toRequestBody(JSON_MEDIA))
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw RelayException(response.code, body)
            val decoded = json.decodeFromString(PushResponse.serializer(), body)
            PushResult(decoded.accepted, decoded.duplicate)
        }
    }

    /** GET /v1/events?ownerId=&after=&limit= — download events after the cursor. */
    override suspend fun pull(after: String): PullResult = withContext(Dispatchers.IO) {
        val url = "$base/v1/events".toHttpUrl().newBuilder()
            .addQueryParameter("ownerId", ownerId)
            .addQueryParameter("after", after)
            .addQueryParameter("limit", pullLimit.toString())
            .build()
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $relayAuth")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw RelayException(response.code, body)
            val decoded = json.decodeFromString(PullResponse.serializer(), body)
            PullResult(decoded.events, decoded.nextCursor)
        }
    }

    /**
     * GET /v1/status?ownerId= — this owner's storage snapshot on the relay
     * (auth-gated). Throws [RelayException] on non-2xx; a 404 means the relay is
     * up but this owner has never pushed to it.
     */
    override suspend fun status(): StatusResponse = withContext(Dispatchers.IO) {
        val url = "$base/v1/status".toHttpUrl().newBuilder()
            .addQueryParameter("ownerId", ownerId)
            .build()
        val request = Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $relayAuth")
            .get()
            .build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw RelayException(response.code, body)
            json.decodeFromString(StatusResponse.serializer(), body)
        }
    }

    /** GET /health — public liveness + version probe. Throws [RelayException] on non-2xx. */
    override suspend fun health(): HealthResponse = withContext(Dispatchers.IO) {
        val request = Request.Builder().url("$base/health").get().build()
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) throw RelayException(response.code, body)
            json.decodeFromString(HealthResponse.serializer(), body)
        }
    }

    companion object {
        private val JSON_MEDIA = "application/json".toMediaType()
        private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
        val sharedClient: OkHttpClient by lazy { OkHttpClient() }
    }
}
