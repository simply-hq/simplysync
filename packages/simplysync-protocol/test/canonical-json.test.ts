import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/crypto.ts";

describe("canonicalJson", () => {
  test("sorts object keys by code unit, recursively", () => {
    expect(canonicalJson({ b: 1, a: 2, A: 3 })).toBe('{"A":3,"a":2,"b":1}');
    expect(canonicalJson({ z: { y: 1, x: 2 } })).toBe('{"z":{"x":2,"y":1}}');
  });

  test("preserves array order and passes primitives through", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalJson("hi")).toBe('"hi"');
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
  });

  test("throws on a Date instead of silently emitting {}", () => {
    // The whole point: a Date has no own enumerable keys, so the old code sealed
    // {} onto the encrypted wire. It must now fail loudly at the boundary.
    expect(() => canonicalJson({ d: new Date("2020-01-01T00:00:00Z") })).toThrow(
      /unsupported non-plain object/,
    );
  });

  test("throws on Map, Set, and class instances", () => {
    expect(() => canonicalJson(new Map([["a", 1]]))).toThrow();
    expect(() => canonicalJson(new Set([1, 2]))).toThrow();
    class Point {
      x = 1;
    }
    expect(() => canonicalJson({ p: new Point() })).toThrow();
  });

  test("accepts null-prototype objects (treated as plain)", () => {
    const bare = Object.assign(Object.create(null), { b: 1, a: 2 });
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });

  test("throws on non-finite numbers instead of emitting null", () => {
    // JSON.stringify turns these into "null", silently losing the value.
    expect(() => canonicalJson({ n: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ n: Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJson(-Infinity)).toThrow(/non-finite/);
  });

  test("escapes and unicode match JSON.stringify byte-for-byte", () => {
    // The exact characters the cross-language corpus now exercises: quote,
    // backslash, control chars, a surrogate-pair emoji, and CJK. All four ports
    // must agree on this, so pin it against JSON.stringify here too.
    const s = 'Hello "q" \\ 🌍 中文\n\t end';
    expect(canonicalJson({ title: s })).toBe(JSON.stringify({ title: s }));
  });
});
