package com.simplysync.kotlin

// Conflict-free counters (parity with the TS engine's counter.ts): reaction
// tallies, vote counts, unread badges. A single-integer counter LOSES concurrent
// increments under last-writer-wins. Instead, model each increment as its own
// immutable delta row; the value is SUM(delta). Because every increment is a
// distinct row, increments from any number of devices never touch the same row,
// so LWW never loses one. It replicates over the normal sync log — no special
// merge code, convergent across the TS / Kotlin / Swift engines.
//
// Trade-off: rows grow with the number of increments — ideal for reactions, votes,
// and modest tallies.

/** Column set for a counter table. Add to a schema as `"counter" to counterColumns()`. */
fun counterColumns(): Map<String, Column> = mapOf(
    "id" to Column.id("Counter"),
    "counterKey" to Column.nonEmptyString,
    "delta" to Column.finiteNumber,
)

/**
 * Add [amount] (default 1) to a counter by appending a delta row. Safe to call
 * rapidly / concurrently — each call is an independent row, so none can clobber
 * another. [counterKey] namespaces independent counters within one table
 * (e.g. "msg_42:like", "inbox:unread").
 */
fun incrementCounter(
    engine: SyncEngine,
    table: String,
    counterKey: String,
    amount: Double = 1.0,
): MutationResult = engine.insert(table, "counterKey" to counterKey, "delta" to amount)

/** Subtract [amount] (default 1) from a counter. */
fun decrementCounter(
    engine: SyncEngine,
    table: String,
    counterKey: String,
    amount: Double = 1.0,
): MutationResult = incrementCounter(engine, table, counterKey, -amount)

/**
 * A reactive query for one counter's value (SUM(delta), 0 when empty). Use it like
 * any query — `loadQuery` / `getQueryRows` / `liveQuery` — so the total updates live.
 */
fun counterTotalQuery(engine: SyncEngine, table: String, counterKey: String): Query<Double> =
    engine.createQuery(
        "select coalesce(sum(delta), 0) as total from \"$table\" where counterKey = ? and isDeleted = 0",
        listOf(SqliteValue.Text(counterKey)),
    ) { it.double("total") }
