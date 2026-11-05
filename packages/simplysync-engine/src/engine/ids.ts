import { base64UrlDecode, base64UrlEncode } from "@simplysync/protocol";
import type { Id } from "../type.js";

/** Random row id (base64url, 16 bytes). */
export function createId(): Id {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes) as Id;
}

/**
 * Deterministic row id: SHA-256 of the UTF-8 input, first 16 bytes, base64url —
 * the same shape as {@link createId}. Derive a row's id from something stable
 * (a parent's id, an external key, "shipment-for-order-X") so two devices that
 * do the same follow-up work concurrently write the SAME row instead of two.
 * The input is not recoverable from the id; keep it in a column if needed.
 *
 * Async because WebCrypto's digest is; there is no synchronous SHA-256 in the
 * engine's dependencies and adding one for this is not worth it.
 */
export async function createIdFromString(input: string): Promise<Id> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return base64UrlEncode(new Uint8Array(digest, 0, 16)) as Id;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A UUID's 16 bytes as a row id, so an external UUID key round-trips exactly. */
export function uuidToId(uuid: string): Id {
  if (!UUID_PATTERN.test(uuid)) throw new Error(`Not a UUID: ${uuid}`);
  const hex = uuid.replaceAll("-", "");
  const bytes = Uint8Array.from({ length: 16 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
  return base64UrlEncode(bytes) as Id;
}

/** Inverse of {@link uuidToId}. Throws unless the id decodes to 16 bytes. */
export function idToUuid(id: Id): string {
  const bytes = base64UrlDecode(id);
  if (bytes.length !== 16) throw new Error(`Not a 16-byte id: ${id}`);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
