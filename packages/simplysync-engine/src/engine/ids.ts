import { base64UrlEncode } from "@simplysync/protocol";
import type { Id } from "../type.js";

/** Random row id (base64url, 16 bytes). */
export function createId(): Id {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes) as Id;
}

