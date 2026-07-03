import { describe, expect, test } from "bun:test";

import { compareHlc } from "../src/index.ts";

// compareHlc is the sole last-write-wins tiebreaker for the whole system
// (packages/simplysync-engine/src/engine/relay.ts). It must return a
// deterministic, locale-independent code-unit order so every relay
// (SQLite BINARY comparisons) and native port (Swift/Kotlin `<`) picks the
// exact same winner as this TypeScript implementation. These cases pin
// inputs where `String.prototype.localeCompare` disagrees with code-unit
// order, so a regression back to `.localeCompare` fails loudly.
describe("compareHlc: code-unit order, not locale order", () => {
  test("mixed-case deviceId tiebreak: uppercase sorts before lowercase by code unit", () => {
    // "Z".localeCompare("a") returns > 0 in most locales (case-insensitive
    // collation treats "z" and "Z" as adjacent, after "a"), but by raw
    // code-unit order "Z" (0x5A) < "a" (0x61). This is exactly the bug: two
    // HLCs tying on time-counter and differing only in deviceId case must
    // resolve identically across TS, Swift, Kotlin, and all three relays.
    const upper = "00mpqre1qy-0000-Zzzzzzzzzzz";
    const lower = "00mpqre1qy-0000-aaaaaaaaaaa";

    expect("Z".localeCompare("a")).toBeGreaterThan(0);
    expect(compareHlc(upper, lower)).toBeLessThan(0);
    expect(compareHlc(lower, upper)).toBeGreaterThan(0);
  });

  test("deviceId tiebreak: '-' vs '_' (both valid base64url chars)", () => {
    // '-' is 0x2D, '_' is 0x5F, so '-' sorts before '_' by code unit. Locale
    // collation can treat punctuation differently (often ignored or
    // reordered), so this pins the byte-order expectation directly.
    const withHyphen = "00mpqre1qy-0000-abc-defghij";
    const withUnderscore = "00mpqre1qy-0000-abc_defghij";

    expect(compareHlc(withHyphen, withUnderscore)).toBeLessThan(0);
    expect(compareHlc(withUnderscore, withHyphen)).toBeGreaterThan(0);
  });

  test("null/undefined/empty left is always treated as earliest", () => {
    const right = "00mpqre1qy-0000-device1";
    expect(compareHlc(null, right)).toBe(-1);
    expect(compareHlc(undefined, right)).toBe(-1);
    expect(compareHlc("", right)).toBe(-1);
  });

  test("equal strings compare as 0", () => {
    const hlc = "00mpqre1qy-0000-device1";
    expect(compareHlc(hlc, hlc)).toBe(0);
  });
});
