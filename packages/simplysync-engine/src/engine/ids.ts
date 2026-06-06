import { base64UrlEncode } from "@simplysync/protocol";
import type { Id } from "../type";

/** Random row id (base64url, 16 bytes). */
export function createId(): Id {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes) as Id;
}

/**
 * Deterministic id from a string (sync), the `createIdFromString` idiom
 * so callers like `seedDefaultCategories` can upsert by a stable id. Uses a sync
 * 128-bit hash so it runs without WebCrypto on the JS thread.
 */
export function createIdFromString<_B extends string = never>(
  value: string,
): Id {
  let h1 = 0x9e3779b1 ^ value.length;
  let h2 = 0x85ebca77 ^ value.length;
  let h3 = 0xc2b2ae3d;
  let h4 = 0x27d4eb2f;
  for (let i = 0; i < value.length; i += 1) {
    const k = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ k, 2654435761);
    h2 = Math.imul(h2 ^ k, 1597334677);
    h3 = Math.imul(h3 ^ k, 2246822519);
    h4 = Math.imul(h4 ^ k, 3266489917);
  }
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, h1 >>> 0);
  view.setUint32(4, h2 >>> 0);
  view.setUint32(8, h3 >>> 0);
  view.setUint32(12, h4 >>> 0);
  return base64UrlEncode(bytes) as Id;
}
