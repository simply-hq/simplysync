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
class RelayClient(
    baseUrl: String,
    private val ownerId: String,
    private val relayAuth: String,
    private val pullLimit: Int = 500,
    private val client: OkHttpClient = sharedClient,
) {
    private val base: String = baseUrl.trimEnd('/')

    data class PushResult(val accepted: Int, val duplicate: Int)
    data class PullResult(val events: List<SyncEnvelope>, val nextCursor: String)

    @Serializable
    private data class PushBody(val ownerId: String, val events: List<SyncEnvelope>)

    @Serializable
    private data class PushResponse(val accepted: Int = 0, val duplicate: Int = 0)

    @Serializable
    private data class PullResponse(val events: List<SyncEnvelope> = emptyList(), val nextCursor: String = "")

    class RelayException(val status: Int, val bodyText: String) :
        Exception("relay http $status: $bodyText")

    /** POST /v1/events — upload local events. Idempotent: the relay dedupes by (ownerId, eventId). */
    suspend fun push(events: List<SyncEnvelope>): PushResult = withContext(Dispatchers.IO) {
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
    suspend fun pull(after: String): PullResult = withContext(Dispatchers.IO) {
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

    companion object {
        private val JSON_MEDIA = "application/json".toMediaType()
        private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }
        val sharedClient: OkHttpClient by lazy { OkHttpClient() }
    }
}
