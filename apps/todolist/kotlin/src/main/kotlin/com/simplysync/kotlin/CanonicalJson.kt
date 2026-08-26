package com.simplysync.kotlin

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A JSON value with deterministic, JS-`JSON.stringify`-compatible serialization
 * and recursively sorted object keys — the exact bytes the protocol feeds to
 * AES-GCM as additional authenticated data (`canonicalJson`).
 *
 * Key ordering uses natural String ordering (UTF-16 code-unit order). The
 * protocol only ever canonicalizes lowercase-ASCII keys, for which this matches
 * JS's code-unit order and Swift's `<`. Keep column names lowercase-ASCII.
 */
sealed class JsonValue {
    data class Str(val value: String) : JsonValue()
    data class IntVal(val value: Long) : JsonValue()
    data class DoubleVal(val value: Double) : JsonValue()
    data class Bool(val value: Boolean) : JsonValue()
    data object Null : JsonValue()
    data class Arr(val items: List<JsonValue>) : JsonValue()
    data class Obj(val fields: Map<String, JsonValue>) : JsonValue()

    fun canonical(): String = when (this) {
        is Str -> escape(value)
        is IntVal -> value.toString()
        is DoubleVal -> {
            // Integers-as-doubles render without a fractional part, like JS.
            if (value == Math.rint(value) && kotlin.math.abs(value) < 1e15) {
                value.toLong().toString()
            } else {
                value.toString()
            }
        }
        is Bool -> if (value) "true" else "false"
        Null -> "null"
        is Arr -> "[" + items.joinToString(",") { it.canonical() } + "]"
        is Obj -> "{" + fields.keys.sorted().joinToString(",") { key ->
            escape(key) + ":" + fields.getValue(key).canonical()
        } + "}"
    }

    fun canonicalData(): ByteArray = canonical().toByteArray(Charsets.UTF_8)

    companion object {
        /**
         * JSON string escaping matching `JSON.stringify`: escapes `"` and `\`,
         * the short escapes (\b \t \n \f \r), other control chars as `\u00xx`,
         * and an UNPAIRED surrogate as `\uXXXX` (all lowercase hex). Forward
         * slashes, non-ASCII, and valid surrogate PAIRS are left literal.
         *
         * The unpaired-surrogate case matters: without it a lone surrogate is
         * appended literally and Java's UTF-8 encoder later rewrites it to `?`,
         * silently corrupting the AEAD plaintext (and, under LWW, propagating
         * that corruption back to peers). JS's JSON.stringify escapes it instead,
         * so this keeps the two canonicalizers byte-identical.
         */
        fun escape(s: String): String {
            val out = StringBuilder("\"")
            var i = 0
            while (i < s.length) {
                val c = s[i]
                when {
                    c == '"' -> out.append("\\\"")
                    c == '\\' -> out.append("\\\\")
                    c.code == 0x08 -> out.append("\\b")
                    c.code == 0x09 -> out.append("\\t")
                    c.code == 0x0A -> out.append("\\n")
                    c.code == 0x0C -> out.append("\\f")
                    c.code == 0x0D -> out.append("\\r")
                    c.code < 0x20 -> out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
                    Character.isHighSurrogate(c) &&
                        i + 1 < s.length &&
                        Character.isLowSurrogate(s[i + 1]) -> {
                        // Valid pair (e.g. an emoji): emit both units literally.
                        out.append(c).append(s[i + 1])
                        i += 1
                    }
                    Character.isSurrogate(c) ->
                        out.append("\\u").append(c.code.toString(16).padStart(4, '0'))
                    else -> out.append(c)
                }
                i += 1
            }
            out.append("\"")
            return out.toString()
        }

        /** Builds a JsonValue from a kotlinx JsonElement (decoded plaintext). */
        fun from(element: JsonElement): JsonValue = when (element) {
            is JsonNull -> Null
            is JsonObject -> Obj(element.mapValues { from(it.value) })
            is JsonArray -> Arr(element.map { from(it) })
            is JsonPrimitive -> {
                if (element.isString) {
                    Str(element.content)
                } else {
                    when (val content = element.content) {
                        "true" -> Bool(true)
                        "false" -> Bool(false)
                        else -> content.toLongOrNull()?.let { IntVal(it) }
                            ?: content.toDoubleOrNull()?.let { DoubleVal(it) }
                            ?: Str(content)
                    }
                }
            }
        }
    }
}
