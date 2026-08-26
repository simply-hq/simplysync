// Low-level crypto primitives shared across the module: base64url, an
// HKDF-style byte derivation, HMAC (built on subtle.digest for runtime
// portability), SLIP-21, and small byte/JSON helpers. Most members are exported
// only for use within the package; base64UrlEncode/base64UrlDecode are the only
// ones re-exported from the package entry.

const DERIVATION_SALT = new TextEncoder().encode("sbt-local-first-v1");

// Pure-JS base64url so the protocol runs on any runtime (Node, Bun, browsers,
// React Native/Hermes) without depending on the browser globals btoa/atob,
// which are absent on bare React Native and older Node.
const BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const BASE64_LOOKUP = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_ALPHABET.length; i += 1) {
    table[BASE64_ALPHABET.charCodeAt(i)] = i;
  }
  // Accept standard base64 input too, so callers can pass either alphabet.
  table["+".charCodeAt(0)] = 62;
  table["/".charCodeAt(0)] = 63;
  return table;
})();

export function base64UrlEncode(bytes: Uint8Array): string {
  let output = "";
  let index = 0;

  for (; index + 2 < bytes.length; index += 3) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    output +=
      BASE64_ALPHABET[(chunk >> 18) & 63] +
      BASE64_ALPHABET[(chunk >> 12) & 63] +
      BASE64_ALPHABET[(chunk >> 6) & 63] +
      BASE64_ALPHABET[chunk & 63];
  }

  const remaining = bytes.length - index;
  if (remaining === 1) {
    const chunk = bytes[index] << 16;
    output += BASE64_ALPHABET[(chunk >> 18) & 63] + BASE64_ALPHABET[(chunk >> 12) & 63];
  } else if (remaining === 2) {
    const chunk = (bytes[index] << 16) | (bytes[index + 1] << 8);
    output +=
      BASE64_ALPHABET[(chunk >> 18) & 63] +
      BASE64_ALPHABET[(chunk >> 12) & 63] +
      BASE64_ALPHABET[(chunk >> 6) & 63];
  }

  return output;
}

export function base64UrlDecode(value: string): Uint8Array {
  // Tolerate standard base64 padding and either alphabet.
  let length = value.length;
  while (length > 0 && value.charCodeAt(length - 1) === 0x3d) {
    length -= 1;
  }

  // A base64 group is 2–4 chars; a remainder of exactly one char encodes no
  // whole byte, so it is malformed. The platform decoders (Java's
  // getUrlDecoder, Swift's Data(base64Encoded:)) reject it too — accepting it
  // here is how a recovery key validates on web but fails on iOS/Android.
  if (length % 4 === 1) {
    throw new Error("invalid base64url length.");
  }

  const byteLength = Math.floor((length * 6) / 8);
  const bytes = new Uint8Array(byteLength);

  let buffer = 0;
  let bits = 0;
  let outIndex = 0;

  for (let index = 0; index < length; index += 1) {
    const code = value.charCodeAt(index);
    const sextet = code < 128 ? BASE64_LOOKUP[code] : -1;
    if (sextet === -1) {
      throw new Error("invalid base64url input.");
    }

    buffer = (buffer << 6) | sextet;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[outIndex] = (buffer >> bits) & 0xff;
      outIndex += 1;
    }
  }

  // The final character's unused low bits must be zero. Otherwise the same
  // bytes have several valid spellings, and comparing or deduping wire values
  // (nonces, ciphertext, a persisted recovery key) stops being well-defined.
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) {
    throw new Error("non-canonical base64url trailing bits.");
  }

  return bytes;
}

export async function deriveBytes(
  secret: Uint8Array,
  label: string,
  byteLength: number,
): Promise<Uint8Array> {
  const info = encodeUtf8(label);
  const prk = await hmacSha256(DERIVATION_SALT, secret);
  const output = new Uint8Array(byteLength);
  let previous: Uint8Array<ArrayBufferLike> = new Uint8Array();
  let offset = 0;
  let blockIndex = 1;

  while (offset < byteLength) {
    const blockInput = concatBytes(
      previous,
      info,
      new Uint8Array([blockIndex]),
    );
    previous = await hmacSha256(prk, blockInput);
    output.set(previous.slice(0, byteLength - offset), offset);
    offset += previous.length;
    blockIndex += 1;
  }

  return output;
}

export async function randomBytes(length: number): Promise<Uint8Array> {
  const crypto = await getCrypto();
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export async function getCrypto(): Promise<Crypto> {
  if (globalThis.crypto?.subtle) {
    return globalThis.crypto;
  }

  throw new Error("WebCrypto is required for local-first encryption.");
}

export function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function decodeUtf8(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

async function digestBytes(
  hash: "SHA-256" | "SHA-512",
  data: Uint8Array,
): Promise<Uint8Array> {
  const crypto = await getCrypto();
  return new Uint8Array(await crypto.subtle.digest(hash, toArrayBuffer(data)));
}

// HMAC implemented on top of subtle.digest (RFC 2104) rather than
// subtle.sign/importKey. subtle.digest is universally supported, whereas some
// runtimes (react-native-quick-crypto) have a broken subtle HMAC sign path.
async function hmac(
  hash: "SHA-256" | "SHA-512",
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const blockSize = hash === "SHA-512" ? 128 : 64;
  let key = keyBytes;
  if (key.length > blockSize) key = await digestBytes(hash, key);
  if (key.length < blockSize) {
    const padded = new Uint8Array(blockSize);
    padded.set(key);
    key = padded;
  }
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i += 1) {
    ipad[i] = key[i] ^ 0x36;
    opad[i] = key[i] ^ 0x5c;
  }
  const inner = await digestBytes(hash, concatBytes(ipad, data));
  return digestBytes(hash, concatBytes(opad, inner));
}

export function hmacSha256(
  keyBytes: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  return hmac("SHA-256", keyBytes, data);
}

/**
 * SLIP-21 hierarchical symmetric key derivation. Returns the lower 32 bytes of
 * the final node.
 */
export async function createSlip21(
  seed: Uint8Array,
  path: readonly string[],
): Promise<Uint8Array> {
  let node = await hmac("SHA-512", encodeUtf8("Symmetric key seed"), seed);
  for (const label of path) {
    const labelBytes = encodeUtf8(label);
    const message = new Uint8Array(labelBytes.length + 1);
    message[0] = 0;
    message.set(labelBytes, 1);
    node = await hmac("SHA-512", node.slice(0, 32), message);
  }
  return node.slice(32, 64);
}

export function concatBytes(...chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }

  return output;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  // NaN / ±Infinity have no JSON form: JSON.stringify silently turns them into
  // `null`, so the number a caller stored would decrypt as null on every peer.
  // Reject at the boundary rather than corrupt.
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonicalJson: non-finite number is not serializable.");
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  // Reject anything that isn't a plain object. A Date, Map, Set, or class
  // instance has no own enumerable keys, so the object branch below would
  // silently emit `{}` — and because canonicalJson's output is the AES-GCM
  // plaintext AND its AAD, that corruption is sealed onto the wire where every
  // peer accepts it as authentic and the original is unrecoverable. Fail at the
  // encrypt boundary instead: the caller must serialize such a value to a
  // JSON-safe form (e.g. an ISO string) itself, which is also the only way the
  // Kotlin/Swift ports can reproduce the same bytes.
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    const kind = (value as { constructor?: { name?: string } }).constructor
      ?.name;
    throw new Error(
      `canonicalJson: unsupported non-plain object${
        kind ? ` (${kind})` : ""
      }; serialize it to a JSON-safe value before encrypting.`,
    );
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nestedValue]) => [key, sortJson(nestedValue)]),
  );
}
