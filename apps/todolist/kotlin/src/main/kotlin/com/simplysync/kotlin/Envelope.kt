package com.simplysync.kotlin

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * On-the-wire encrypted event. Field names and JSON shape match `SyncEnvelope`
 * in @simplysync/protocol exactly, so the relay and JS/Swift clients accept it.
 */
@Serializable
data class SyncEnvelope(
    val version: Int,
    val ownerId: String,
    val eventId: String,
    val deviceId: String,
    val nonce: String,
    val ciphertext: String,
    val createdAt: String,
    val streamId: String? = null,
)

/** The decrypted event body — the port of `SyncPayload`. `value` carries the row's columns. */
data class SyncPayload(
    val schemaVersion: Int,
    val table: String,
    val op: String, // "upsert" | "delete"
    val rowId: String,
    val hlc: String,
    val value: Map<String, JsonValue>,
)

class EnvelopeException(message: String) : Exception(message)

object Envelope {
    private const val NONCE_BYTES = 12
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false }

    fun encrypt(
        identity: Identity,
        eventId: String,
        deviceId: String,
        createdAt: String,
        payload: SyncPayload,
    ): SyncEnvelope {
        val nonce = Crypto.randomBytes(NONCE_BYTES)
        return seal(identity, eventId, deviceId, createdAt, payload, nonce)
    }

    /**
     * The pseudonymous stream id the relay sees for a logical row:
     * HMAC(streamKey, "<table> <rowId>"), base64url, truncated to 22 chars.
     * Mirrors `deriveStreamId` in @simplysync/protocol — exposed so a client
     * can name a row's stream without sealing an envelope (e.g. to ask a
     * relay to drop a fully-purged stream via `POST /v1/streams/compact`).
     */
    fun streamId(identity: Identity, table: String, rowId: String): String {
        val hash = Crypto.hmacSha256(identity.streamKey, "$table $rowId".toByteArray(Charsets.UTF_8))
        return Base64Url.encode(hash).take(22)
    }

    /** Encrypt with an explicit nonce — used by deterministic test vectors. */
    fun seal(
        identity: Identity,
        eventId: String,
        deviceId: String,
        createdAt: String,
        payload: SyncPayload,
        nonce: ByteArray,
    ): SyncEnvelope {
        val streamId = streamId(identity, payload.table, payload.rowId)

        val aad = headerObject(1, identity.ownerId, eventId, deviceId, createdAt, streamId).canonicalData()
        val plaintext = payloadObject(payload).canonicalData()
        val ciphertext = Crypto.aesGcmSeal(identity.dataKey, nonce, plaintext, aad)

        return SyncEnvelope(
            version = 1,
            ownerId = identity.ownerId,
            eventId = eventId,
            deviceId = deviceId,
            nonce = Base64Url.encode(nonce),
            ciphertext = Base64Url.encode(ciphertext),
            createdAt = createdAt,
            streamId = streamId,
        )
    }

    fun decrypt(identity: Identity, envelope: SyncEnvelope): SyncPayload {
        if (envelope.ownerId != identity.ownerId) throw EnvelopeException("ownerMismatch")

        val aad = headerObject(
            envelope.version, envelope.ownerId, envelope.eventId,
            envelope.deviceId, envelope.createdAt, envelope.streamId,
        ).canonicalData()
        val nonce = Base64Url.decode(envelope.nonce) ?: throw EnvelopeException("decodeFailed")
        val ctTag = Base64Url.decode(envelope.ciphertext) ?: throw EnvelopeException("decodeFailed")
        val plaintext = Crypto.aesGcmOpen(identity.dataKey, nonce, ctTag, aad)
        return parsePayload(plaintext)
    }

    fun encodePayload(payload: SyncPayload): String = payloadObject(payload).canonical()

    fun decodePayload(payloadJson: String): SyncPayload =
        parsePayload(payloadJson.toByteArray(Charsets.UTF_8))

    private fun headerObject(
        version: Int, ownerId: String, eventId: String,
        deviceId: String, createdAt: String, streamId: String?,
    ): JsonValue {
        val fields = linkedMapOf<String, JsonValue>(
            "version" to JsonValue.IntVal(version.toLong()),
            "ownerId" to JsonValue.Str(ownerId),
            "eventId" to JsonValue.Str(eventId),
            "deviceId" to JsonValue.Str(deviceId),
            "createdAt" to JsonValue.Str(createdAt),
        )
        if (streamId != null) fields["streamId"] = JsonValue.Str(streamId)
        return JsonValue.Obj(fields)
    }

    private fun payloadObject(p: SyncPayload): JsonValue = JsonValue.Obj(
        linkedMapOf(
            "schemaVersion" to JsonValue.IntVal(p.schemaVersion.toLong()),
            "table" to JsonValue.Str(p.table),
            "op" to JsonValue.Str(p.op),
            "rowId" to JsonValue.Str(p.rowId),
            "hlc" to JsonValue.Str(p.hlc),
            "value" to JsonValue.Obj(p.value),
        ),
    )

    private fun parsePayload(data: ByteArray): SyncPayload {
        val obj = json.parseToJsonElement(String(data, Charsets.UTF_8)) as? JsonObject
            ?: throw EnvelopeException("decodeFailed")
        fun str(key: String) = (obj[key] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { it.isString }?.content
        val table = str("table") ?: throw EnvelopeException("decodeFailed")
        val op = str("op") ?: throw EnvelopeException("decodeFailed")
        val rowId = str("rowId") ?: throw EnvelopeException("decodeFailed")
        val hlc = str("hlc") ?: throw EnvelopeException("decodeFailed")
        // Legacy payloads written before this became an enforced boundary are v1.
        val schemaVersion = (obj["schemaVersion"] as? kotlinx.serialization.json.JsonPrimitive)
            ?.content?.toIntOrNull() ?: 1
        val value = mutableMapOf<String, JsonValue>()
        (obj["value"] as? JsonObject)?.let { raw ->
            for ((k, v) in raw) value[k] = JsonValue.from(v)
        }
        return SyncPayload(schemaVersion, table, op, rowId, hlc, value)
    }
}
