import { describe, expect, test } from "bun:test";

import {
  base64UrlDecode,
  base64UrlEncode,
  decryptEnvelope,
  deriveIdentity,
  deriveIdentityFromMnemonic,
  sealPayload,
  type SyncPayload,
} from "../src/index.ts";
import vectors from "./vectors.json";

// The generated cross-language conformance corpus (see
// scripts/gen-vectors.ts). This is the byte-compatibility contract shared
// with the Swift (ports/swift/verify) and Kotlin
// (ports/kotlin) ports: same recovery credential in, same
// ownerId/relayAuth/streamId/ciphertext out. If any of these assertions ever
// fail, the protocol's wire format drifted — regenerate the corpus
// deliberately and review the diff, don't just update this file.

const EVENT_ID = "00000abcde-0000-dev1";
const DEVICE_ID = "dev1";
const CREATED_AT = "2026-01-01T00:00:00.000Z";

const PAYLOAD: SyncPayload<{ done: number; title: string }> = {
  schemaVersion: 1,
  table: "todo",
  op: "upsert",
  rowId: "row-123",
  hlc: EVENT_ID,
  value: { done: 0, title: "Hello from JS" },
};

const DERIVERS = {
  sf1: deriveIdentity,
  mnemonic: deriveIdentityFromMnemonic,
} as const;

describe("cross-language crypto conformance corpus", () => {
  for (const [name, entry] of Object.entries(vectors)) {
    describe(name, () => {
      test("derives the locked identity", async () => {
        const derive = DERIVERS[name as keyof typeof DERIVERS];
        const identity = await derive(entry.input);
        expect(identity.ownerId).toBe(entry.ownerId);
        expect(identity.relayAuth).toBe(entry.relayAuth);
        expect(identity.streamKey).toBeDefined();
        expect(base64UrlEncode(identity.streamKey!)).toBe(entry.streamKeyB64);
      });

      test("seals to the exact recorded ciphertext with the fixed nonce", async () => {
        const derive = DERIVERS[name as keyof typeof DERIVERS];
        const identity = await derive(entry.input);
        const nonce = base64UrlDecode(entry.nonceB64);

        const envelope = await sealPayload(
          identity,
          { eventId: EVENT_ID, deviceId: DEVICE_ID, createdAt: CREATED_AT },
          PAYLOAD,
          nonce,
        );

        expect(envelope.streamId).toBe(entry.streamId);
        expect(envelope.nonce).toBe(entry.nonceB64);
        expect(envelope.ciphertext).toBe(entry.ciphertextB64);
      });

      test("round-trips through decryptEnvelope", async () => {
        const derive = DERIVERS[name as keyof typeof DERIVERS];
        const identity = await derive(entry.input);
        const nonce = base64UrlDecode(entry.nonceB64);

        const envelope = await sealPayload(
          identity,
          { eventId: EVENT_ID, deviceId: DEVICE_ID, createdAt: CREATED_AT },
          PAYLOAD,
          nonce,
        );

        const decrypted = await decryptEnvelope<{
          done: number;
          title: string;
        }>(identity, envelope);
        expect(decrypted.table).toBe("todo");
        expect(decrypted.value.title).toBe("Hello from JS");
      });
    });
  }
});
