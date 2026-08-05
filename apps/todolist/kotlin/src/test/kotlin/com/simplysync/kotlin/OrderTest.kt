package com.simplysync.kotlin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.random.Random

class OrderTest {
    @Test
    fun firstKeyIsValidAndAppendPrependStayOrdered() {
        val first = keyBetween(null, null)
        assertTrue(isOrderKey(first))

        var prev = first
        for (i in 0 until 100) {
            val next = keyBetween(prev, null)
            assertTrue("append grows", next > prev)
            prev = next
        }
        var next = first
        for (i in 0 until 100) {
            val before = keyBetween(null, next)
            assertTrue("prepend shrinks", before < next)
            next = before
        }
    }

    @Test
    fun insertBetweenStaysStrictlyBetween() {
        val a = keyBetween(null, null)
        val c = keyBetween(a, null)
        var lo = a
        for (i in 0 until 200) {
            val b = keyBetween(lo, c)
            assertTrue(a <= lo && lo < b && b < c)
            lo = b
        }
    }

    @Test
    fun outOfOrderBoundsThrow() {
        val a = keyBetween(null, null)
        val b = keyBetween(a, null)
        var threw = false
        try { keyBetween(b, a) } catch (e: IllegalArgumentException) { threw = true }
        assertTrue("b > a rejected", threw)
        threw = false
        try { keyBetween(a, a) } catch (e: IllegalArgumentException) { threw = true }
        assertTrue("equal rejected", threw)
        // "V" and "V0" are the same fractional value -> rejected.
        threw = false
        try { keyBetween("V", "V0") } catch (e: IllegalArgumentException) { threw = true }
        assertTrue("trailing-min-equal rejected", threw)
    }

    @Test
    fun keysBetweenReturnsSortedCount() {
        for (n in listOf(0, 1, 2, 3, 5, 10, 64)) {
            val keys = keysBetween(null, null, n)
            assertEquals(n, keys.size)
            for (i in 1 until keys.size) assertTrue(keys[i - 1] < keys[i])
            assertTrue(keys.all { isOrderKey(it) })
        }
        val a = keyBetween(null, null)
        val b = keyBetween(a, null)
        val spread = keysBetween(a, b, 8)
        assertEquals(8, spread.size)
        assertTrue(a < spread.first() && spread.last() < b)
    }

    @Test
    fun fuzzThousandRandomInsertsStayStrictlyIncreasingAndUnique() {
        val rng = Random(12345)
        val list = ArrayList<String>()
        repeat(1000) {
            val slot = rng.nextInt(list.size + 1)
            val a = if (slot == 0) null else list[slot - 1]
            val b = if (slot == list.size) null else list[slot]
            list.add(slot, keyBetween(a, b))
        }
        for (i in 1 until list.size) assertTrue("strictly increasing", list[i - 1] < list[i])
        assertEquals("no duplicates", list.size, list.toHashSet().size)
    }

    @Test
    fun compareOrderKeysBreaksTiesById() {
        val rows = listOf("V" to "b", "V" to "a", "G" to "z")
        val sorted = rows.sortedWith { x, y -> compareOrderKeys(x.first, x.second, y.first, y.second) }
        assertEquals(listOf("z", "a", "b"), sorted.map { it.second })
    }

    @Test
    fun alphabetIsAscending() {
        for (i in 1 until ORDER_KEY_ALPHABET.length) {
            assertTrue(ORDER_KEY_ALPHABET[i - 1] < ORDER_KEY_ALPHABET[i])
        }
    }
}
