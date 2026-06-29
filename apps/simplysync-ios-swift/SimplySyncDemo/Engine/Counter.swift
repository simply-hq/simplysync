import Foundation

// Conflict-free counters (parity with the TS/Kotlin engines): reaction tallies,
// vote counts, unread badges. A single-integer counter LOSES concurrent increments
// under last-writer-wins. Instead, model each increment as its own immutable delta
// row; the value is SUM(delta). Because every increment is a distinct row,
// increments from any number of devices never touch the same row, so LWW never
// loses one — and it replicates over the normal sync log with no special merge code.

/// Column set for a counter table. Spread into a schema: `"counter": counterColumns()`.
func counterColumns() -> [String: Column] {
    ["id": .id("Counter"), "counterKey": .nonEmptyString, "delta": .finiteNumber]
}

/// Add `amount` (default 1) to a counter by appending a delta row. Safe to call
/// rapidly / concurrently — each call is an independent row. `counterKey` namespaces
/// independent counters within one table (e.g. "msg_42:like", "inbox:unread").
@discardableResult
func incrementCounter(_ engine: SyncEngine, _ table: String, _ counterKey: String, amount: Double = 1) -> MutationResult {
    engine.insert(table, ["counterKey": .string(counterKey), "delta": .double(amount)])
}

/// Subtract `amount` (default 1) from a counter.
@discardableResult
func decrementCounter(_ engine: SyncEngine, _ table: String, _ counterKey: String, amount: Double = 1) -> MutationResult {
    incrementCounter(engine, table, counterKey, amount: -amount)
}

/// Decoded row for `counterTotalQuery`.
struct CounterTotal: Decodable { let total: Double }

/// A reactive query for one counter's value (SUM(delta), 0 when empty). Use it like
/// any query — `loadQuery` / `liveQuery` — so the total updates live.
func counterTotalQuery(_ engine: SyncEngine, _ table: String, _ counterKey: String) -> Query<CounterTotal> {
    engine.createQuery(
        "select coalesce(sum(delta), 0.0) as total from \"\(table)\" where counterKey = ? and isDeleted = 0",
        [.text(counterKey)], as: CounterTotal.self)
}
