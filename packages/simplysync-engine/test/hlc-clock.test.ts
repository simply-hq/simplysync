import { describe, expect, test } from "bun:test";

import { compareHlc } from "@simplysync/protocol";

import { createEngineState } from "../src/engine/state";
import { createClock, createStore } from "../src/engine/store";

// No schema/driver needed: `createClock`'s `persist()` writes through
// `store.setMeta`, which no-ops when `state.driver` is null (see store.ts) —
// so these tests exercise the clock's in-memory logic directly, the way
// `purge.test.ts` builds a bare `state`/`store` pair for store-level tests.
function makeClock() {
  const state = createEngineState({ name: "clock-test" });
  const store = createStore(state, {}, { name: "clock-test" });
  return { state, clock: createClock(state, store) };
}

describe("observeHlc: drift clamp", () => {
  test("far-future remote HLC does not raise hlcTime beyond the drift bound", () => {
    const { state, clock } = makeClock();
    const farFuture = Date.now() + 10 * 365 * 24 * 3600_000; // +10 years
    const remote = [
      farFuture.toString(36).padStart(10, "0"),
      "0000",
      "otherDevice",
    ].join("-");

    clock.observeHlc(remote);

    // 5 minutes is the documented MAX_DRIFT_MS in store.ts; assert well within
    // a generous bound rather than hard-coding the exact constant.
    expect(state.hlcTime).toBeLessThan(Date.now() + 10 * 60_000);

    // A subsequent local write is near real time, not poisoned by the bogus
    // future value.
    const hlc = clock.nextHlc();
    const mintedMillis = Number.parseInt(hlc.split("-")[0]!, 36);
    expect(Math.abs(mintedMillis - Date.now())).toBeLessThan(10_000);
  });

  test("legitimate skew (1 minute ahead) is still absorbed", () => {
    const { state, clock } = makeClock();
    const skewed = Date.now() + 60_000;
    const remote = [
      skewed.toString(36).padStart(10, "0"),
      "0000",
      "otherDevice",
    ].join("-");

    clock.observeHlc(remote);

    expect(state.hlcTime).toBe(skewed);
  });

  test("malformed and non-drifting values behave as before", () => {
    const { state, clock } = makeClock();
    clock.observeHlc("garbage");
    expect(state.hlcTime).toBe(0);

    const past = Date.now() - 60_000;
    const remote = [past.toString(36).padStart(10, "0"), "0000", "dev"].join(
      "-",
    );
    clock.observeHlc(remote);
    expect(state.hlcTime).toBe(past);

    // An older observed time does not lower the high-water mark.
    const older = past - 5_000;
    const olderRemote = [
      older.toString(36).padStart(10, "0"),
      "0000",
      "dev",
    ].join("-");
    clock.observeHlc(olderRemote);
    expect(state.hlcTime).toBe(past);
  });
});

describe("nextHlc: counter overflow rollover", () => {
  test("overflowing the counter rolls into hlcTime without widening the field", () => {
    const { state, clock } = makeClock();
    const HLC_COUNTER_MAX = 36 ** 4 - 1;

    // Pin the clock's high-water mark slightly ahead of the wall clock (so
    // `Math.max(now, hlcTime)` in `nextHlc` keeps picking `hlcTime`) with the
    // counter one step from overflow, mimicking sustained same-millisecond
    // writes.
    const pinnedTime = Date.now() + 60_000;
    state.hlcTime = pinnedTime;
    state.hlcCounter = HLC_COUNTER_MAX - 1;

    const first = clock.nextHlc(); // counter -> HLC_COUNTER_MAX, no rollover yet
    expect(state.hlcTime).toBe(pinnedTime);
    expect(state.hlcCounter).toBe(HLC_COUNTER_MAX);
    expect(first.split("-")[1]).toBe(
      HLC_COUNTER_MAX.toString(36).padStart(4, "0"),
    );

    const second = clock.nextHlc(); // would overflow -> rolls into time
    expect(state.hlcTime).toBe(pinnedTime + 1);
    expect(state.hlcCounter).toBe(0);
    expect(second.split("-")[1]).toBe("0000");

    // Fixed-width field: length unchanged across the rollover.
    expect(first.split("-")[0]!.length).toBe(10);
    expect(second.split("-")[0]!.length).toBe(10);
    expect(first.split("-")[1]!.length).toBe(4);
    expect(second.split("-")[1]!.length).toBe(4);

    // Strictly increasing across the rollover.
    expect(compareHlc(first, second)).toBeLessThan(0);
  });
});

describe("nextHlc: ordering", () => {
  test("a sequence of nextHlc outputs is strictly increasing under compareHlc", () => {
    const { clock } = makeClock();
    let prev: string | null = null;
    for (let i = 0; i < 500; i++) {
      const hlc = clock.nextHlc();
      if (prev !== null) {
        expect(compareHlc(prev, hlc)).toBeLessThan(0);
      }
      prev = hlc;
    }
  });
});
