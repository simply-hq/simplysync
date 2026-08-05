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
