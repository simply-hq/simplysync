package com.simplysync.kotlin

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The canonicalizer's string escaping must stay byte-identical to JS's
 * JSON.stringify — the bytes are the AES-GCM plaintext + AAD, so any divergence
 * is a cross-platform decrypt failure or silent data corruption.
 */
class CanonicalJsonTest {
    @Test
    fun escapesUnpairedSurrogateInsteadOfCorruptingToQuestionMark() {
        // A lone high surrogate. JS escapes it as \ud800; appending it literally
        // would let Java's UTF-8 encoder rewrite it to '?'.
        assertEquals("\"\\ud800\"", JsonValue.Str("\uD800").canonical())
        // A lone low surrogate too.
        assertEquals("\"\\udc00\"", JsonValue.Str("\uDC00").canonical())
    }

    @Test
    fun emitsValidSurrogatePairLiterally() {
        // U+1F30D 🌍 = high \uD83C + low \uDF0D — a valid pair, emitted literally.
        assertEquals("\"\uD83C\uDF0D\"", JsonValue.Str("\uD83C\uDF0D").canonical())
    }

    @Test
    fun shortEscapesMatchJsonStringify() {
        assertEquals("\"a\\\"b\\\\c\\nd\\te\"", JsonValue.Str("a\"b\\c\nd\te").canonical())
    }
}
