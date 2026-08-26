import { describe, expect, test } from "bun:test";
import { base64UrlEncode, base64UrlDecode } from "../src/crypto.ts";

// Reference encoder using the browser globals, used only to assert that our
// pure-JS implementation produces identical output.
function refEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

describe("base64url", () => {
  test("round-trips and matches btoa/atob output for lengths 0..256", () => {
    for (let len = 0; len <= 256; len += 1) {
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) bytes[i] = (i * 97 + len * 13) % 256;

      const encoded = base64UrlEncode(bytes);
      expect(encoded).toBe(refEncode(bytes));
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      expect(encoded).not.toContain("=");

      expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
    }
  });

  test("decodes standard base64 alphabet and padding too", () => {
    const bytes = new Uint8Array([0xff, 0xee, 0xdd, 0xcc, 0xbb]);
    const standardPadded = btoa(String.fromCharCode(...bytes)); // uses + / and =
    expect([...base64UrlDecode(standardPadded)]).toEqual([...bytes]);
  });

  test("works without btoa/atob in the runtime", () => {
    const realBtoa = globalThis.btoa;
    const realAtob = globalThis.atob;
    // Simulate a bare React Native runtime where these globals are absent.
    // @ts-expect-error deliberately removing globals
    delete globalThis.btoa;
    // @ts-expect-error deliberately removing globals
    delete globalThis.atob;
    try {
      const bytes = new Uint8Array([1, 2, 3, 250, 0, 128, 64]);
      const encoded = base64UrlEncode(bytes);
      expect([...base64UrlDecode(encoded)]).toEqual([...bytes]);
    } finally {
      globalThis.btoa = realBtoa;
      globalThis.atob = realAtob;
    }
  });

  test("rejects invalid characters", () => {
    expect(() => base64UrlDecode("not valid!")).toThrow();
  });

  test("rejects an illegal length (remainder of one char)", () => {
    // 5 chars = one full group + one leftover, which encodes no whole byte.
    // Java/Swift decoders reject this; TS must too, so a recovery key can't be
    // accepted on web and rejected on mobile.
    expect(() => base64UrlDecode("abcde")).toThrow(/length/);
  });

  test("rejects non-canonical trailing bits (multiple spellings of one value)", () => {
    // "AB" decodes to a single byte using only the top 8 of 12 bits; the low 4
    // must be zero. "AB" (B = 000001) leaves bit set, so it is non-canonical.
    // The canonical single-byte-0x00 spelling is "AA".
    expect([...base64UrlDecode("AA")]).toEqual([0]);
    expect(() => base64UrlDecode("AB")).toThrow(/canonical/);
  });
});
