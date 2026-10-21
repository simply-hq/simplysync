import { describe, expect, test } from "bun:test";

import {
  createMnemonic,
  createRecoveryKey,
  decryptEnvelope,
  deriveIdentity,
  deriveIdentityFromMnemonic,
  encryptPayload,
  isRecoveryMnemonic,
  type SyncPayload,
} from "../src/index.ts";

// The public BIP39 zero-entropy test vector and the owner identity it derives
// via SLIP-21. Never use this mnemonic for real data. These vectors lock the
// derivation in place: if it ever drifts, an existing user's phrase would no
// longer map to the same owner and they would silently lose access to data.
const TEST_MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const EXPECTED_OWNER_ID = "ZFy7R58uNrdvMywuTD5eWA";
const EXPECTED_RELAY_AUTH = "W8eqt1vLxaIFkOmMYmvHXg";

const samplePayload: SyncPayload<{ amount: number }> = {
  schemaVersion: 1,
  table: "ledger",
  op: "upsert",
  rowId: "row-1",
  hlc: "00mpqre1qy-0000-device",
  value: { amount: -450 },
};

describe("recovery mnemonic detection", () => {
  test("recognizes a valid mnemonic", () => {
    expect(isRecoveryMnemonic(TEST_MNEMONIC)).toBe(true);
  });

  test("is tolerant of surrounding whitespace and case", () => {
    expect(isRecoveryMnemonic(`  ${TEST_MNEMONIC.toUpperCase()}  `)).toBe(true);
  });

  test("rejects non-mnemonic strings", () => {
    expect(isRecoveryMnemonic("not a real recovery phrase at all")).toBe(false);
    expect(isRecoveryMnemonic("")).toBe(false);
    // A truncated phrase fails the BIP39 checksum.
    expect(
      isRecoveryMnemonic("abandon abandon abandon abandon abandon abandon"),
    ).toBe(
      false,
    );
  });
});

describe("identity derivation from a mnemonic", () => {
  test("derives a stable owner id and write key", async () => {
    const identity = await deriveIdentityFromMnemonic(TEST_MNEMONIC);
    expect(identity.ownerId).toBe(EXPECTED_OWNER_ID);
    expect(identity.relayAuth).toBe(EXPECTED_RELAY_AUTH);
    expect(identity.source).toBe("mnemonic");
    expect(identity.mnemonic).toBe(TEST_MNEMONIC);
    expect(identity.recoveryKey).toBe(TEST_MNEMONIC);
  });

  test("deriveIdentity auto-detects a mnemonic recovery key", async () => {
    const identity = await deriveIdentity(`  ${TEST_MNEMONIC.toUpperCase()} `);
    expect(identity.ownerId).toBe(EXPECTED_OWNER_ID);
    expect(identity.source).toBe("mnemonic");
  });

  test("derivation is deterministic across calls", async () => {
    const a = await deriveIdentity(TEST_MNEMONIC);
    const b = await deriveIdentity(TEST_MNEMONIC);
    expect(a.ownerId).toBe(b.ownerId);
    expect(a.relayAuth).toBe(b.relayAuth);
  });

  test("round-trips an encrypted payload with the mnemonic-derived key", async () => {
    const identity = await deriveIdentity(TEST_MNEMONIC);
    const envelope = await encryptPayload(
      identity,
      { eventId: "event-1", deviceId: "device-1" },
      samplePayload,
    );
    expect(envelope.ownerId).toBe(EXPECTED_OWNER_ID);
    const decrypted = await decryptEnvelope<{ amount: number }>(
      identity,
      envelope,
    );
    expect(decrypted.value).toEqual({ amount: -450 });
  });

  test("rejects an invalid mnemonic", () => {
    expect(deriveIdentityFromMnemonic("clearly not valid")).rejects.toThrow(
      /Invalid BIP39 mnemonic/u,
    );
  });

  // A second, independent vector. Two fixed phrases make an accidental
  // derivation change far more likely to trip a test.
  test("derives a second phrase to its locked owner id", async () => {
    const secondMnemonic =
      "differ crew income average style spring cloth prison salt tell lock forget they universe gold orbit nerve doll door endorse dwarf resist rude layer";
    const identity = await deriveIdentityFromMnemonic(secondMnemonic);
    expect(identity.ownerId).toBe("JaiLPDhC5NYBd9jD09FQuQ");
  });
});

describe("streamId (compaction grouping key)", () => {
  test("is stable per (table,row) and round-trips through the AAD", async () => {
    const identity = await deriveIdentity(TEST_MNEMONIC);
    const a = await encryptPayload(
      identity,
      { eventId: "e1", deviceId: "d1" },
      samplePayload,
    );
    const b = await encryptPayload(
      identity,
      { eventId: "e2", deviceId: "d1" },
      { ...samplePayload, value: { amount: -999 } },
    );
    // Same table+rowId => same streamId, even though everything else differs.
    expect(a.streamId).toBeTruthy();
    expect(a.streamId).toBe(b.streamId);
    // streamId is part of the AAD, so decryption still verifies + succeeds.
    const decrypted = await decryptEnvelope<{ amount: number }>(identity, b);
    expect(decrypted.value).toEqual({ amount: -999 });
  });

  test("differs across rows and is unguessable without the key", async () => {
    const identity = await deriveIdentity(TEST_MNEMONIC);
    const row1 = await encryptPayload(
      identity,
      { eventId: "e1", deviceId: "d1" },
      samplePayload,
    );
    const row2 = await encryptPayload(
      identity,
      { eventId: "e2", deviceId: "d1" },
      { ...samplePayload, rowId: "row-2" },
    );
    expect(row1.streamId).not.toBe(row2.streamId);

    // A different identity (different streamKey) yields a different streamId
    // for the same logical row — the relay can't compute or reverse it.
    const other = await deriveIdentity(await createRecoveryKey());
    const otherRow1 = await encryptPayload(
      other,
      { eventId: "e1", deviceId: "d1" },
      samplePayload,
    );
    expect(otherRow1.streamId).not.toBe(row1.streamId);
  });

  test("tampering with streamId breaks decryption (AAD-bound)", async () => {
    const identity = await deriveIdentity(TEST_MNEMONIC);
    const env = await encryptPayload(
      identity,
      { eventId: "e1", deviceId: "d1" },
      samplePayload,
    );
    const tampered = { ...env, streamId: "AAAAAAAAAAAAAAAAAAAAAA" };
    expect(decryptEnvelope(identity, tampered)).rejects.toThrow();
  });
});

describe("credential form is unambiguous", () => {
  test("an sf1_ prefix always wins over a mnemonic-shaped body", async () => {
    // The two credential forms share one entry point. If a value could be read
    // as either, it would derive two different owners depending on which
    // engine version or port looked at it — and each owner sees an empty
    // account. The prefix decides, always.
    const phrase = TEST_MNEMONIC;
    const asPhrase = await deriveIdentity(phrase);
    expect(asPhrase.source).toBe("mnemonic");

    // Same words, prefixed: it is now read as a native key, and rejected as
    // one, rather than quietly deriving the phrase's owner by a second route.
    expect(deriveIdentity(`sf1_${phrase}`)).rejects.toThrow(
      /base64url|32 bytes/u,
    );
  });

  test("a native key that does not carry 32 bytes of entropy is refused", async () => {
    // A truncated or padded key still base64url-decodes to *something*, and
    // that something derives a perfectly valid, permanently empty owner. The
    // length check is what turns silent data loss into an error message.
    const good = await createRecoveryKey();
    const identity = await deriveIdentity(good);
    expect(identity.ownerId).toBeTruthy();

    const body = good.slice("sf1_".length);
    // A truncated key is always refused — either the strict base64url decoder
    // rejects its now-illegal length / non-canonical trailing bits, or (if it
    // still decodes) the 32-byte entropy check does. Both are refusals; which
    // one fires depends on the random bytes, so assert refusal, not a message.
    expect(deriveIdentity(`sf1_${body.slice(0, -4)}`)).rejects.toThrow();
    expect(deriveIdentity("sf1_")).rejects.toThrow(/32 bytes/u);
    expect(deriveIdentity("not-a-credential-at-all")).rejects.toThrow(
      /must start with sf1_/u,
    );
  });
});

describe("envelope owner binding", () => {
  test("an envelope sealed for another owner is refused before any decryption", async () => {
    // Two owners share a relay only by accident (a wrong ownerId in a request,
    // a restored backup pointed at the wrong account). AES-GCM would reject it
    // anyway, but the explicit check turns an opaque auth-tag failure into a
    // statement about whose data this is — and it is what makes the pull path's
    // "decryptFailures" count mean "wrong key", not "wrong account".
    const mine = await deriveIdentity(TEST_MNEMONIC);
    const theirs = await deriveIdentity(await createRecoveryKey());
    const env = await encryptPayload(
      theirs,
      { eventId: "e1", deviceId: "d1" },
      samplePayload,
    );
    expect(env.ownerId).not.toBe(mine.ownerId);
    expect(decryptEnvelope(mine, env)).rejects.toThrow(
      /owner does not match/u,
    );

    // Relabelling the envelope does not help: ownerId is part of the AAD.
    expect(
      decryptEnvelope(mine, { ...env, ownerId: mine.ownerId }),
    ).rejects.toThrow();
  });
});

describe("native recovery keys remain unchanged", () => {
  test("sf1 keys still derive via HKDF and report their source", async () => {
    const recoveryKey = await createRecoveryKey();
    expect(recoveryKey.startsWith("sf1_")).toBe(true);
    const identity = await deriveIdentity(recoveryKey);
    expect(identity.source).toBe("recoveryKey");
    expect(identity.mnemonic).toBeUndefined();
    expect(identity.ownerId).toBeTruthy();
  });
});

describe("createMnemonic", () => {
  test("produces an accepted 12-word phrase", async () => {
    const mnemonic = createMnemonic();
    expect(mnemonic.split(" ")).toHaveLength(12);
    expect(isRecoveryMnemonic(mnemonic)).toBe(true);
    const identity = await deriveIdentity(mnemonic);
    expect(identity.source).toBe("mnemonic");
  });
});
