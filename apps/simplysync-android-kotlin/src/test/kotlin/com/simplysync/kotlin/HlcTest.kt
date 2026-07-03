package com.simplysync.kotlin

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors `packages/simplysync-engine/test/hlc-clock.test.ts` (plan 010): the
 * drift clamp on `observe` and the counter-overflow rollover in `next`.
 */
class HlcTest {
    @Test
    fun farFutureObserveDoesNotRaiseBeyondDriftBound() {
        val now = System.currentTimeMillis()
        val clock = HlcClock("devA") { now }
        val farFuture = now + 10L * 365 * 24 * 3600_000 // +10 years
        clock.observe(Hlc.make("otherDevice", farFuture, 0))

        val (highWaterMillis, _) = clock.highWater()
        assertTrue(
            "far-future observe must not poison the clock",
            highWaterMillis < now + 10 * 60_000L,
        )

        val minted = clock.next()
        val mintedMillis = minted.split("-")[0].toLong(36)
        assertTrue(
            "next() after a rejected far-future observe should stay near real time",
            Math.abs(mintedMillis - now) < 10_000L,
        )
    }

    @Test
    fun legitimateSkewIsStillAbsorbed() {
        val now = System.currentTimeMillis()
        val clock = HlcClock("devA") { now }
        val skewed = now + 60_000L // 1 minute ahead, within MAX_DRIFT_MS
        clock.observe(Hlc.make("otherDevice", skewed, 0))

        val (highWaterMillis, _) = clock.highWater()
        assertEquals(skewed, highWaterMillis)
    }

    @Test
    fun counterOverflowRollsIntoTimeWithoutWideningTheField() {
        val now = System.currentTimeMillis()
        val pinnedTime = now + 60_000L
        val counterMax = 36 * 36 * 36 * 36 - 1
        val clock = HlcClock("devA") { now }
        clock.seed(pinnedTime, counterMax - 1)

        val first = clock.next() // counter -> counterMax, no rollover yet
        var (millis, counter) = clock.highWater()
        assertEquals(pinnedTime, millis)
        assertEquals(counterMax, counter)
        assertEquals(counterMax.toString(36).padStart(4, '0'), first.split("-")[1])

        val second = clock.next() // would overflow -> rolls into time
        val after = clock.highWater()
        assertEquals(pinnedTime + 1, after.first)
        assertEquals(0, after.second)
        assertEquals("0000", second.split("-")[1])

        // Fixed-width field: length unchanged across the rollover.
        assertEquals(10, first.split("-")[0].length)
        assertEquals(10, second.split("-")[0].length)
        assertEquals(4, first.split("-")[1].length)
        assertEquals(4, second.split("-")[1].length)

        assertTrue(Hlc.compare(first, second) < 0)
    }
}
