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

    /** Returns negative / 0 / positive like `localeCompare`. A null/empty left is always less. */
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
        if (now > lastMillis) {
            lastMillis = now
            counter = 0
        } else {
            counter += 1
        }
        Hlc.make(deviceId, lastMillis, counter)
    }

    fun seed(millis: Long, counter: Int) = synchronized(lock) { raise(millis, counter) }

    fun observe(hlc: String) {
        val parsed = Hlc.parse(hlc) ?: return
        synchronized(lock) { raise(parsed.first, parsed.second) }
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
