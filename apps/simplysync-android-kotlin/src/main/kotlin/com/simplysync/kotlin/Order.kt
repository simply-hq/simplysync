package com.simplysync.kotlin

// Fractional indexing: conflict-light ordering keys for reorderable lists — the
// Kotlin port of the TS engine's `order.ts`. Give each row a string key and keep
// rows sorted by it; to move a row, mint a NEW key strictly between its two new
// neighbours with [keyBetween]. Only that one row's key changes, so the move
// merges under LWW like any single-field edit and never disturbs its neighbours.
// Keys compare as plain strings, so `order by "order"` in SQL yields the intended
// sequence. Break ties between equal keys with [compareOrderKeys].

// Base-62 digits in ascending code-unit order, so lexicographic comparison agrees
// with digit value — the property the scheme rests on.
const val ORDER_KEY_ALPHABET =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

private const val ORDER_BASE = 62
private const val ORDER_MIN_DIGIT = '0'
private val ORDER_DIGIT_VALUE: Map<Char, Int> =
    ORDER_KEY_ALPHABET.withIndex().associate { (i, c) -> c to i }

/** True when [value] is a syntactically valid ordering key (1+ alphabet chars). */
fun isOrderKey(value: String): Boolean =
    value.isNotEmpty() && value.all { it in ORDER_DIGIT_VALUE }

// Trailing minimum digits don't change a key's fractional value ("V0" == "V") but
// do change string comparison; canonicalize before reasoning about order.
private fun trimTrailingMin(key: String): String {
    var end = key.length
    while (end > 0 && key[end - 1] == ORDER_MIN_DIGIT) end--
    return key.substring(0, end)
}

private fun orderDigitAt(key: String, i: Int): Int =
    if (i < key.length) ORDER_DIGIT_VALUE.getValue(key[i]) else 0

private fun orderMidpoint(lower: String, upperIn: String?): String {
    val out = StringBuilder()
    var upper = upperIn
    var i = 0
    while (true) {
        val lo = orderDigitAt(lower, i)
        // Beyond `upper`'s digits its fractional digits are 0; a null upper bound is
        // the open value 1, i.e. one past the largest digit (ORDER_BASE).
        val hi = if (upper == null) ORDER_BASE else orderDigitAt(upper, i)
        if (lo == hi) {
            out.append(ORDER_KEY_ALPHABET[lo]) // copy shared digit and descend
            i++
            continue
        }
        val mid = (lo + hi) / 2
        if (mid > lo) {
            out.append(ORDER_KEY_ALPHABET[mid])
            return out.toString()
        }
        // hi == lo + 1: no room here. Keep lower's digit; below it any digit stays
        // under `upper`, so the upper bound becomes open (null).
        out.append(ORDER_KEY_ALPHABET[lo])
        upper = null
        i++
    }
}

/**
 * Mint an ordering key strictly between [a] and [b] (null = unbounded). Always
 * satisfies `a < result < b` under plain string comparison. Throws if `a >= b`.
 */
fun keyBetween(a: String?, b: String?): String {
    if (a != null && !isOrderKey(a)) throw IllegalArgumentException("Invalid lower ordering key: $a")
    if (b != null && !isOrderKey(b)) throw IllegalArgumentException("Invalid upper ordering key: $b")
    val lower = if (a == null) "" else trimTrailingMin(a)
    val upper = if (b == null) null else trimTrailingMin(b)
    if (upper != null && lower >= upper) {
        throw IllegalArgumentException("Ordering keys out of order: $a >= $b")
    }
    return orderMidpoint(lower, upper)
}

/** Mint [n] keys evenly spread strictly between [a] and [b], ascending. */
fun keysBetween(a: String?, b: String?, n: Int): List<String> {
    if (n <= 0) return emptyList()
    if (n == 1) return listOf(keyBetween(a, b))
    val mid = keyBetween(a, b)
    val left = n / 2
    return keysBetween(a, mid, left) + mid + keysBetween(mid, b, n - left - 1)
}

/**
 * Total order for rows by ordering key, tie-broken by id so concurrently-minted
 * equal keys still sort deterministically across devices. Mirror in SQL with
 * `order by "order", id`.
 */
fun compareOrderKeys(aOrder: String, aId: String, bOrder: String, bId: String): Int = when {
    aOrder < bOrder -> -1
    aOrder > bOrder -> 1
    aId < bId -> -1
    aId > bId -> 1
    else -> 0
}
