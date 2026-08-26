// Generates the cross-language conformance corpus every port asserts against.
// The ports cannot read this package's path — their CI clones are cone-mode
// sparse checkouts that do not contain it — so this script writes all three
// copies itself. Hand-copying was the previous arrangement and it could go
// stale silently: a port kept proving conformance to an older corpus while
// passing. `bun run vectors:check` fails if the copies ever diverge.
//
// The corpus locks two fixed recovery credentials (an `sf1_` key and a BIP39
// mnemonic) to their derived identity + a byte-exact sealed envelope, using a
// FIXED nonce (via `unsafeSealPayloadWithNonce`) so every platform can assert exact
// ciphertext, not just "it round-trips". Regenerate only deliberately — a
// diff here means the protocol's wire format changed.
//
// `hlcOrder` pins the last-write-wins tiebreak itself. Ordering drifted once
// already (TS used `localeCompare` while the ports used code-unit `<`), which
// silently hands two devices different winners for the same pair of events;
// the cases below are the ones where locale collation disagrees with code
// units, so a port that reaches for a locale-aware comparator fails here.
//
// Run: bun run scripts/gen-vectors.ts

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/crypto.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  compareHlc,
  deriveIdentity,
  deriveIdentityFromMnemonic,
  unsafeSealPayloadWithNonce,
  type SyncPayload,
} from "../src/index.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Fixed generator inputs. Must stay byte-identical across regenerations, and
// must match apps/todolist/swift/verify/main.swift.
const EVENT_ID = "00000abcde-0000-dev1";
const DEVICE_ID = "dev1";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const NONCE_B64 = "BRIfLDlGU2BteoeU";

// The title deliberately exercises the canonicalization edge cases the corpus
// was previously blind to: an escaped quote and backslash, control chars
// (newline/tab), a surrogate-pair emoji, and CJK. All four ports must escape
// and UTF-8-encode these identically or a client's note fails to decrypt on
// another platform. Keep this string byte-identical to the ports'
// ConformanceTest / verify payloads.
const PAYLOAD: SyncPayload<{ done: number; title: string }> = {
  schemaVersion: 1,
  table: "todo",
  op: "upsert",
  rowId: "row-123",
  hlc: EVENT_ID,
  value: { done: 0, title: 'Hello "q" \\ 🌍 中文\n\t end' },
};

interface FixedInput {
  readonly input: string;
  readonly derive: (input: string) => ReturnType<typeof deriveIdentity>;
}

const FIXED_INPUTS: Record<string, FixedInput> = {
  sf1: {
    input: "sf1_AQgPFh0kKzI5QEdOVVxjanF4f4aNlJuiqbC3vsXM09o",
    derive: deriveIdentity,
  },
  mnemonic: {
    input:
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    derive: deriveIdentityFromMnemonic,
  },
};

const REPO_ROOT = dirname(dirname(PACKAGE_ROOT));

// Every consumer of the corpus, written from this one generation. Ports read
// their own copy because their CI clones cannot see this package.
export const CORPUS_PATHS = [
  join(PACKAGE_ROOT, "test", "vectors.json"),
  join(REPO_ROOT, "apps", "todolist", "swift", "verify", "vectors.json"),
  join(
    REPO_ROOT,
    "apps",
    "todolist",
    "kotlin",
    "src",
    "test",
    "resources",
    "vectors.json",
  ),
];

// Pairs where locale collation and code-unit order disagree, plus the
// structural comparisons every port must agree on. `expect` is the sign
// `compareHlc(left, right)` must produce.
const HLC_ORDER_CASES = [
  {
    name: "mixed-case deviceId tiebreak",
    left: "00mpqre1qy-0000-Zzzzzzzzzzz",
    right: "00mpqre1qy-0000-aaaaaaaaaaa",
    expect: "lt",
    why: "'Z' (0x5A) precedes 'a' (0x61) by code unit; most locales sort them the other way.",
  },
  {
    name: "base64url punctuation tiebreak",
    left: "00mpqre1qy-0000-abc-defghij",
    right: "00mpqre1qy-0000-abc_defghij",
    expect: "lt",
    why: "'-' (0x2D) precedes '_' (0x5F); locale collation often ignores or reorders punctuation.",
  },
  {
    name: "millis dominates counter",
    left: "00mpqre1qy-zzzz-devA",
    right: "00mpqre1qz-0000-devA",
    expect: "lt",
    why: "Fixed-width millis compare before the counter ever matters.",
  },
  {
    name: "counter dominates deviceId",
    left: "00mpqre1qy-0001-devA",
    right: "00mpqre1qy-0002-devA",
    expect: "lt",
    why: "Counter breaks a same-millisecond tie before the deviceId does.",
  },
  {
    name: "identical stamps tie",
    left: "00mpqre1qy-0000-devA",
    right: "00mpqre1qy-0000-devA",
    expect: "eq",
    why: "An event id is its own HLC, so re-applying one must be a no-op, not a win.",
  },
] as const;

async function main(): Promise<void> {
  const nonce = base64UrlDecode(NONCE_B64);
  const identities: Record<string, unknown> = {};

  for (const [name, { input, derive }] of Object.entries(FIXED_INPUTS)) {
    const identity = await derive(input);

    const envelope = await unsafeSealPayloadWithNonce(
      identity,
      { eventId: EVENT_ID, deviceId: DEVICE_ID, createdAt: CREATED_AT },
      PAYLOAD,
      nonce,
    );

    // Reconstruct the exact header object unsafeSealPayloadWithNonce built internally (same
    // shape/order it feeds to canonicalJson) so we can record the literal AAD
    // string the ciphertext is bound to.
    const headerCanonical = canonicalJson({
      version: envelope.version,
      ownerId: envelope.ownerId,
      eventId: envelope.eventId,
      deviceId: envelope.deviceId,
      createdAt: envelope.createdAt,
      ...(envelope.streamId ? { streamId: envelope.streamId } : {}),
    });
    const payloadCanonical = canonicalJson(PAYLOAD);

    identities[name] = {
      input,
      ownerId: identity.ownerId,
      relayAuth: identity.relayAuth,
      streamKeyB64: identity.streamKey
        ? base64UrlEncode(identity.streamKey)
        : "",
      streamId: envelope.streamId ?? "",
      headerCanonical,
      payloadCanonical,
      nonceB64: NONCE_B64,
      ciphertextB64: envelope.ciphertext,
    };
  }

  // Generating a case the reference implementation disagrees with would ship a
  // corpus that every port must fail to match, so refuse to write one.
  for (const testCase of HLC_ORDER_CASES) {
    const actual = compareHlc(testCase.left, testCase.right);
    const sign = actual < 0 ? "lt" : actual > 0 ? "gt" : "eq";
    if (sign !== testCase.expect) {
      throw new Error(
        `hlcOrder case "${testCase.name}" expects ${testCase.expect}, ` +
          `but compareHlc returned ${sign}.`,
      );
    }
  }

  const json = `${JSON.stringify({ identities, hlcOrder: HLC_ORDER_CASES }, null, 2)}\n`;
  for (const path of CORPUS_PATHS) {
    writeFileSync(path, json, "utf8");
    console.log(`wrote ${path}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
