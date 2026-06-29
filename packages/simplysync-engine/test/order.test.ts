import { describe, expect, test } from "bun:test";

import {
  compareOrderKeys,
  isOrderKey,
  keyBetween,
  keysBetween,
  ORDER_KEY_ALPHABET,
} from "../src/index";
import { FractionalIndex } from "../src/index";

describe("keyBetween", () => {
  test("first key for an empty list is a valid key", () => {
    const k = keyBetween(null, null);
    expect(isOrderKey(k)).toBe(true);
  });

  test("append produces a strictly larger key", () => {
    let prev = keyBetween(null, null);
    for (let i = 0; i < 100; i++) {
      const next = keyBetween(prev, null);
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  test("prepend produces a strictly smaller key", () => {
    let next = keyBetween(null, null);
    for (let i = 0; i < 100; i++) {
      const prev = keyBetween(null, next);
      expect(prev < next).toBe(true);
      next = prev;
    }
  });

  test("insert-between yields a key strictly between its neighbours", () => {
    const a = keyBetween(null, null);
    const c = keyBetween(a, null);
    for (let i = 0; i < 100; i++) {
      const b = keyBetween(a, c);
      expect(a < b).toBe(true);
      expect(b < c).toBe(true);
    }
  });

  test("repeated bisection between two fixed neighbours stays ordered", () => {
    // Always inserting just after `a` is the worst case for key growth; assert
    // the invariant still holds and keys stay reasonable.
    let lo = keyBetween(null, null);
    const hi = keyBetween(lo, null);
    for (let i = 0; i < 200; i++) {
      const mid = keyBetween(lo, hi);
      expect(lo < mid).toBe(true);
      expect(mid < hi).toBe(true);
      lo = mid;
    }
  });

  test("throws when bounds are out of order", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    expect(() => keyBetween(b, a)).toThrow();
    expect(() => keyBetween(a, a)).toThrow();
  });

  test("treats trailing minimum digits as equal value (rejects equal)", () => {
    // "V" and "V0" are the same fraction; minting between them is impossible.
    expect(() => keyBetween("V", "V0")).toThrow();
  });

  test("rejects malformed keys", () => {
    expect(() => keyBetween("!", null)).toThrow();
    expect(() => keyBetween(null, "no spaces allowed")).toThrow();
  });
});

describe("keysBetween", () => {
  test("returns the requested count, sorted and within bounds", () => {
    for (const n of [0, 1, 2, 3, 5, 10, 64]) {
      const keys = keysBetween(null, null, n);
      expect(keys.length).toBe(n);
      for (let i = 1; i < keys.length; i++) {
        expect(keys[i - 1]! < keys[i]!).toBe(true);
      }
      expect(keys.every(isOrderKey)).toBe(true);
    }
  });

  test("spreads keys strictly between two neighbours", () => {
    const a = keyBetween(null, null);
    const b = keyBetween(a, null);
    const keys = keysBetween(a, b, 8);
    expect(keys.length).toBe(8);
    expect(a < keys[0]!).toBe(true);
    expect(keys[keys.length - 1]! < b).toBe(true);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i - 1]! < keys[i]!).toBe(true);
    }
  });
});

describe("compareOrderKeys", () => {
  test("orders by key, then breaks ties by id", () => {
    const rows = [
      { id: "b", order: "V" },
      { id: "a", order: "V" },
      { id: "z", order: "G" },
    ];
    const sorted = [...rows].sort(compareOrderKeys);
    expect(sorted.map((r) => r.id)).toEqual(["z", "a", "b"]);
  });
});

describe("fuzz: simulated reordering never inverts or collides", () => {
  // A tiny deterministic PRNG (mulberry32) — no Date.now()/Math.random(), and
  // reproducible across runs.
  const rng = (seed: number) => () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  test("1000 random inserts keep a strictly increasing, unique sequence", () => {
    const next = rng(12345);
    // `list` holds ordering keys kept sorted ascending, mirroring a reorderable
    // list where every op inserts at a random slot.
    const list: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const slot = Math.floor(next() * (list.length + 1)); // 0..list.length
      const a = slot === 0 ? null : list[slot - 1]!;
      const b = slot === list.length ? null : list[slot]!;
      const key = keyBetween(a, b);
      list.splice(slot, 0, key);
    }
    // Strictly increasing (implies no duplicates).
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1]! < list[i]!).toBe(true);
    }
    expect(new Set(list).size).toBe(list.length);
  });
});

describe("FractionalIndex column type", () => {
  test("accepts minted keys and rejects junk", () => {
    expect(FractionalIndex.from(keyBetween(null, null)).ok).toBe(true);
    expect(FractionalIndex.from("").ok).toBe(false);
    expect(FractionalIndex.from("a b").ok).toBe(false);
    expect(FractionalIndex.from(123).ok).toBe(false);
    expect(FractionalIndex.sqlite).toBe("text");
  });

  test("alphabet is in ascending code-unit order", () => {
    for (let i = 1; i < ORDER_KEY_ALPHABET.length; i++) {
      expect(ORDER_KEY_ALPHABET[i - 1]! < ORDER_KEY_ALPHABET[i]!).toBe(true);
    }
  });
});
