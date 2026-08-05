// Conflict-free counters: reaction tallies, vote counts, unread badges.
//
// A counter stored as a single integer column LOSES concurrent increments under
// last-writer-wins: if two devices each bump a like-count from 5, both write 6,
// and LWW keeps one — the other increment vanishes. This is the classic
// local-first counter footgun.
//
// The fix here needs no special merge logic: model the counter as a *delta
// log*. Every increment is its own immutable row holding a signed `delta`; the
// counter's value is `SUM(delta)` over a key. Because each increment is a
// distinct row (unique id), increments from any number of devices never touch
// the same row, so LWW never has anything to resolve — nothing is ever lost,
// and it stays convergent across the TS / Swift / Kotlin engines with zero
// extra code (it's just ordinary rows).
//
// Trade-off: row count grows with the number of increments. Ideal for
// reactions, votes, and modest tallies. For very high-frequency counters,
// periodically fold a device's own delta rows into a single summed row (each
// device compacting only the rows it authored is safe; cross-device compaction
// is not).

import { sql, type Compilable, type Kysely } from "kysely";
import type {
  MutationResult,
  Query,
  SchemaDefinition,
  SyncEngine,
} from "./engine-types.js";
import { FiniteNumber, id, NonEmptyString } from "./type.js";

/**
 * Column set for a counter table. Add it to a schema as e.g.
 * `{ counter: counterColumns(), ... }`, then drive it with `incrementCounter` /
 * `counterTotalQuery`. `counterKey` namespaces independent counters within the
 * one table (e.g. `"msg_42:like"`, `"msg_42:thumbsdown"`, `"inbox:unread"`).
 */
export const counterColumns = () => ({
  id: id("Counter"),
  counterKey: NonEmptyString,
  delta: FiniteNumber,
});

/** A table whose columns match `counterColumns()`. */
type CounterTable<S extends SchemaDefinition> = {
  [T in keyof S & string]: S[T] extends {
    counterKey: unknown;
    delta: unknown;
  }
    ? T
    : never;
}[keyof S & string];

/**
 * Add `amount` (default 1) to a counter by appending a delta row. Returns the
 * underlying insert's `MutationResult`. Safe to call rapidly / concurrently —
 * each call is an independent row, so none can clobber another.
 */
export const incrementCounter = <S extends SchemaDefinition>(
  engine: SyncEngine<S>,
  table: CounterTable<S>,
  counterKey: string,
  amount = 1,
): MutationResult =>
  engine.insert(
    table as keyof S & string,
    { counterKey, delta: amount } as never,
  );

/** Subtract `amount` (default 1) from a counter. */
export const decrementCounter = <S extends SchemaDefinition>(
  engine: SyncEngine<S>,
  table: CounterTable<S>,
  counterKey: string,
  amount = 1,
): MutationResult => incrementCounter(engine, table, counterKey, -amount);

/**
 * A reactive query for a single counter's value (`SUM(delta)`, 0 when empty).
 * Use it like any other query — `loadQuery`, `getQueryRows`, or the React
 * `useQuery` hook — so the displayed total updates live as deltas arrive.
 */
export const counterTotalQuery = <S extends SchemaDefinition>(
  engine: SyncEngine<S>,
  table: CounterTable<S>,
  counterKey: string,
): Query<{ total: number }> =>
  // The table name is dynamic and known only to be *a* counter table, so Kysely
  // can't resolve `counterKey`/`delta` at this generic call site. Build the
  // aggregate against a permissive Kysely view of the schema; the public
  // signature (and the returned Query's row type) stays fully typed.
  engine.createQuery((db) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic table name
    const k = db as unknown as Kysely<any>;
    return k
      .selectFrom(table as string)
      .select(sql<number>`coalesce(sum("delta"), 0)`.as("total"))
      .where("counterKey", "=", counterKey)
      .where("isDeleted", "=", 0) as Compilable<{ total: number }>;
  });
