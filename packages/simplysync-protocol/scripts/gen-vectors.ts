// Generates the cross-language crypto conformance corpus: the single source
// of truth for packages/simplysync-protocol/test/conformance.test.ts. Copies
// of this file are checked in for the Swift harness
// (ports/swift/verify/vectors.json) and the Kotlin test
// (ports/kotlin/src/test/resources/vectors.json) — keep
// them content-identical to this output after regenerating.
//
// The corpus locks two fixed recovery credentials (an `sf1_` key and a BIP39
// mnemonic) to their derived identity + a byte-exact sealed envelope, using a
// FIXED nonce (via `sealPayload`) so every platform can assert exact
// ciphertext, not just "it round-trips". Regenerate only deliberately — a
// diff here means the protocol's wire format changed.
//
// Run: bun run scripts/gen-vectors.ts

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/crypto.ts";
import {
  base64UrlDecode,
  base64UrlEncode,
  deriveIdentity,
  deriveIdentityFromMnemonic,
  sealPayload,
  type SyncPayload,
} from "../src/index.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Fixed generator inputs. Must stay byte-identical across regenerations, and
// must match ports/swift/verify/main.swift.
const EVENT_ID = "00000abcde-0000-dev1";
const DEVICE_ID = "dev1";
const CREATED_AT = "2026-01-01T00:00:00.000Z";
const NONCE_B64 = "BRIfLDlGU2BteoeU";

const PAYLOAD: SyncPayload<{ done: number; title: string }> = {
  schemaVersion: 1,
  table: "todo",
  op: "upsert",
  rowId: "row-123",
  hlc: EVENT_ID,
  value: { done: 0, title: "Hello from JS" },
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

// The TS corpus is the single source of truth. Swift/Kotlin copies are
// checked in separately and must be kept content-identical after
// regenerating (see the file header comment).
const OUTPUT_PATH = join(PACKAGE_ROOT, "test", "vectors.json");

async function main(): Promise<void> {
  const nonce = base64UrlDecode(NONCE_B64);
  const corpus: Record<string, unknown> = {};

  for (const [name, { input, derive }] of Object.entries(FIXED_INPUTS)) {
    const identity = await derive(input);

    const envelope = await sealPayload(
      identity,
      { eventId: EVENT_ID, deviceId: DEVICE_ID, createdAt: CREATED_AT },
      PAYLOAD,
      nonce,
    );

    // Reconstruct the exact header object sealPayload built internally (same
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

    corpus[name] = {
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

  const json = `${JSON.stringify(corpus, null, 2)}\n`;
  writeFileSync(OUTPUT_PATH, json, "utf8");
  console.log(`wrote ${OUTPUT_PATH}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
