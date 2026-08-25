import { describe, expect, test } from "bun:test";

import {
  createHlc,
  getHlcAdmissibility,
  HLC_MAX_FUTURE_DRIFT_MS,
  parseHlc,
} from "../src/index";

describe("HLC admissibility", () => {
  test("strictly parses the canonical fixed-width representation", () => {
    const hlc = createHlc("device.with-tab-suffix", 1_700_000_000_000, 35);
    expect(parseHlc(hlc)).toEqual({
      millis: 1_700_000_000_000,
      counter: 35,
      deviceId: "device.with-tab-suffix",
    });

    for (const malformed of [
      "garbage",
      "0000000000-000-device",
      "0000000000-00000-device",
      "000000000!-0000-device",
      "0000000000-000!-device",
      "0000000000-0000-",
      "0000000000-0000-device space",
    ]) {
      expect(parseHlc(malformed)).toBeNull();
      expect(getHlcAdmissibility(malformed)).toBe("malformed");
    }
  });

  test("distinguishes admissible skew from a future value", () => {
    const now = 1_700_000_000_000;
    expect(
      getHlcAdmissibility(
        createHlc("peer", now + HLC_MAX_FUTURE_DRIFT_MS, 0),
        now,
      ),
    ).toBe("admissible");
    expect(
      getHlcAdmissibility(
        createHlc("peer", now + HLC_MAX_FUTURE_DRIFT_MS + 1, 0),
        now,
      ),
    ).toBe("future");
  });
});

describe("HLC numeric bounds", () => {
  test("the fixed-width grammar, not the safe-integer guard, is what bounds a stamp", () => {
    // Worth stating because the safe-integer check in parseHlc reads like the
    // real bound and is not: the largest value 10 base-36 digits can express is
    // 36^10 - 1, comfortably inside Number's exact range. The width is the
    // bound, which is also why widening the field would be a wire break.
    expect(36 ** 10 - 1).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(36 ** 10 - 1)).toBe(true);

    // So the field's maximum parses, and classifies as future — retryable and
    // quarantined, never discarded.
    const maxWidth = "zzzzzzzzzz-0000-device";
    expect(parseHlc(maxWidth)?.millis).toBe(36 ** 10 - 1);
    expect(getHlcAdmissibility(maxWidth)).toBe("future");

    // A time that needs an 11th digit cannot be expressed at all: createHlc
    // emits it, and parseHlc refuses it, so it is terminal rather than a
    // silently truncated ordering key.
    const overflowed = createHlc("device", Number.MAX_SAFE_INTEGER - 1, 0);
    expect(overflowed.split("-")[0]).toHaveLength(11);
    expect(parseHlc(overflowed)).toBeNull();
    expect(getHlcAdmissibility(overflowed)).toBe("malformed");
  });
});
