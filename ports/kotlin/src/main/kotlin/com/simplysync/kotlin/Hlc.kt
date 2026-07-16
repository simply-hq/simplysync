package com.simplysync.kotlin

/**
 * Hybrid Logical Clock string, matching `createHlc` / `compareHlc`. Format:
 * `<millis base36, 10 chars>-<counter base36, 4 chars>-<deviceId>`, sortable as
 * a plain string.
 */
object Hlc {
    fun make(deviceId: String, millis: Long, counter: Int = 0): String {
        val time = pad(millis.toString(36), 10)
        val count = pad(counter.toString(36), 4)
        return "$time-$count-$deviceId"
    }

    /** Returns negative / 0 / positive by natural UTF-16 code-unit order, matching `@simplysync/protocol`'s `compareHlc`. A null/empty left is always less. */
    fun compare(left: String?, right: String): Int {
        if (left == null || left.isEmpty()) return -1
        if (left == right) return 0
        return if (left < right) -1 else 1
    }

    /** Parses the physical-time + counter out of a well-formed HLC, or null if malformed. */
    fun parse(hlc: String): Pair<Long, Int>? {
        val parts = hlc.split("-")
        if (parts.size < 3 || parts[0].length != 10) return null
        val millis = parts[0].toLongOrNull(36) ?: return null
        val counter = parts[1].toIntOrNull(36) ?: 0
        return millis to counter
    }

    private fun pad(s: String, width: Int): String =
        if (s.length >= width) s else "0".repeat(width - s.length) + s
}

// Bounds how far `observe` will raise the high-water mark for a *remote* time,
// and how high the counter can climb before the fixed 4-digit base-36 field
// in `Hlc.make` would overflow. Mirrors the TS engine's `store.ts` guards
// (plan 010) so the two ports stay convergent:
//  - MAX_DRIFT_MS: all of an owner's events come from that owner's own
//    devices, so without a bound a single device with a far-future wall clock
//    would mint far-future HLCs that every peer absorbs on pull, permanently
//    detaching the fleet from wall-clock time. 5 minutes is generous relative
//    to real clock skew while rejecting "clock reset to year 2099" style
//    corruption; times beyond it are ignored, same as a malformed HLC.
//  - HLC_COUNTER_MAX: widening the counter field would change every stored
//    HLC's string length and break fixed-width lexical ordering. Instead the
//    counter rolls over into logical time (advance by 1ms, reset to 0) —
//    standard HLC behavior, and no wire-format change.
private const val MAX_DRIFT_MS = 5 * 60_000L
private const val HLC_COUNTER_MAX = 36 * 36 * 36 * 36 - 1 // Hlc.make pads the counter to 4 base-36 digits

/**
 * A monotonic clock that never emits a duplicate HLC for this device, bumping
 * the counter when the wall clock doesn't advance. `observe` is the HLC
 * "receive" step; `seed` restores the high-water mark across launches.
 * Thread-safe.
 */
class HlcClock(private val deviceId: String, private val nowMillis: () -> Long = { System.currentTimeMillis() }) {
    private var lastMillis: Long = 0
    private var counter: Int = 0
    private val lock = Any()

    fun next(): String = synchronized(lock) {
        val now = nowMillis()
        var nextMillis = lastMillis
        var nextCounter = counter
        if (now > lastMillis) {
            nextMillis = now
            nextCounter = 0
        } else {
            nextCounter += 1
        }
        if (nextCounter > HLC_COUNTER_MAX) {
            // Counter rollover: the 4-digit base-36 field can't hold this value.
            // Advance logical time by 1ms and reset the counter rather than
            // widening the field (see file-level comment above).
            nextMillis += 1
            nextCounter = 0
        }
        lastMillis = nextMillis
        counter = nextCounter
        Hlc.make(deviceId, lastMillis, counter)
    }

    fun seed(millis: Long, counter: Int) = synchronized(lock) { raise(millis, counter) }

    fun observe(hlc: String): Boolean {
        val parsed = Hlc.parse(hlc) ?: return false
        // Absurd future drift is treated like a malformed value (see above).
        if (parsed.first > nowMillis() + MAX_DRIFT_MS) return false
        synchronized(lock) { raise(parsed.first, parsed.second) }
        return true
    }

    fun highWater(): Pair<Long, Int> = synchronized(lock) { lastMillis to counter }

    private fun raise(millis: Long, counter: Int) {
        if (millis > lastMillis) {
            lastMillis = millis
            this.counter = counter
        } else if (millis == lastMillis && counter > this.counter) {
            this.counter = counter
        }
    }
}
