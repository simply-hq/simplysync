// The two pieces of src/store.ts that are worth testing away from a relay: the
// D1 statement-arity chunking and the seq-range reservation. Both are silent
// when wrong — an unchunked IN list 500s only once a push is big enough, and a
// bad range mis-charges quota rather than failing — so the conformance suite
// catches them late or not at all.
//
// Runs on plain `node --test` with a stub D1: the store builds statements and
// reads results, and never needs workerd to do either. That is the whole point
// of the seam.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  D1_MAX_BOUND_IDS,
  chargeableBytes,
  chunked,
  reserveSeqRange,
} from "../src/store.ts";

/**
 * A D1Database stub that records every statement it is handed. `respond` is
 * given the SQL and its bound parameters and returns whatever that statement's
 * result should be.
 */
function stubDb(respond) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...params) {
          calls.push({ sql, params });
          const result = () => respond(sql, params);
          return {
            all: async () => result(),
            first: async () => result(),
            run: async () => result(),
          };
        },
      };
    },
  };
}

const events = (count, bytes = 10) =>
  Array.from({ length: count }, (_, i) => ({
    event: { eventId: `event-${i}` },
    json: "{}",
    bytes,
  }));

test("chunked splits exactly at the D1 bound-parameter ceiling", () => {
  const sizes = (count) =>
    chunked(Array.from({ length: count }, (_, i) => i)).map((c) => c.length);

  assert.deepEqual(sizes(0), []);
  assert.deepEqual(sizes(1), [1]);
  assert.deepEqual(sizes(D1_MAX_BOUND_IDS), [D1_MAX_BOUND_IDS]);
  assert.deepEqual(sizes(D1_MAX_BOUND_IDS + 1), [D1_MAX_BOUND_IDS, 1]);
  assert.deepEqual(sizes(D1_MAX_BOUND_IDS * 2), [
    D1_MAX_BOUND_IDS,
    D1_MAX_BOUND_IDS,
  ]);
  assert.deepEqual(sizes(D1_MAX_BOUND_IDS * 2 + 1), [
    D1_MAX_BOUND_IDS,
    D1_MAX_BOUND_IDS,
    1,
  ]);

  // Nothing is dropped or duplicated on the way through.
  const items = Array.from({ length: 205 }, (_, i) => i);
  assert.deepEqual(chunked(items).flat(), items);
});

test("chargeableBytes keeps every statement under the bound-parameter ceiling", async () => {
  const db = stubDb(() => ({ results: [] }));
  const count = D1_MAX_BOUND_IDS * 2 + 1;

  const bytes = await chargeableBytes(db, "owner", events(count));

  assert.equal(bytes, count * 10, "nothing stored yet, so everything is new");
  assert.equal(db.calls.length, 3, "one statement per chunk");
  for (const call of db.calls) {
    // ownerId + the chunk's ids, and the placeholder count has to match.
    assert.ok(call.params.length <= D1_MAX_BOUND_IDS + 1);
    assert.equal(
      call.sql.split("?").length - 1,
      call.params.length,
      "a placeholder for every bound parameter",
    );
  }
});

test("chargeableBytes charges only for events the relay does not already hold", async () => {
  // The invariant behind an idempotent retry: a re-push of stored events must
  // cost nothing, even for an owner sitting exactly at its cap.
  const stored = new Set(["event-0", "event-1", "event-90"]);
  const db = stubDb((_sql, params) => ({
    results: params
      .slice(1)
      .filter((id) => stored.has(id))
      .map((id) => ({ event_id: id })),
  }));

  const all = events(100);
  assert.equal(await chargeableBytes(db, "owner", all), (100 - 3) * 10);
  assert.equal(await chargeableBytes(db, "owner", []), 0);
  assert.equal(db.calls.length, 2, "an empty push asks D1 nothing");
});

test("reserveSeqRange hands consecutive pushes disjoint, monotonic ranges", async () => {
  let counter = 0;
  const db = stubDb((_sql, [by]) => {
    counter += by;
    return { value: counter };
  });

  const first = await reserveSeqRange(db, 3);
  const second = await reserveSeqRange(db, 2);

  // base is exclusive, high inclusive: the rows a push inserts are the ones
  // with base < seq <= high, which is what the usage subquery sums.
  assert.deepEqual(first, { base: 0, high: 3 });
  assert.deepEqual(second, { base: 3, high: 5 });
  assert.ok(second.base >= first.high, "ranges never overlap");

  // An empty batch reserves nothing but still names a valid, empty range.
  assert.deepEqual(await reserveSeqRange(db, 0), { base: 5, high: 5 });
});

test("reserveSeqRange with no counter row still yields an empty-safe range", async () => {
  // A relay whose relay_meta row is missing must not hand out seq 0 twice or
  // charge an unbounded range; the fallback collapses to base = high.
  const db = stubDb(() => null);
  assert.deepEqual(await reserveSeqRange(db, 4), { base: 0, high: 4 });
});
