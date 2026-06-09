import { describe, expect, test } from "bun:test";

import {
  createMnemonic,
  decryptStringWithKey,
  deriveBackupKeyBytes,
  deriveIdentity,
  encryptStringWithKey,
  InvalidBackupEnvelopeError,
  isEncryptedEnvelope,
  PassphraseDecryptError,
} from "../src/index";

describe("recovery-phrase keyed snapshot crypto", () => {
  test("round-trips under a phrase-derived key", async () => {
    const mnemonic = createMnemonic();
    const identity = await deriveIdentity(mnemonic);
    const key = await deriveBackupKeyBytes(mnemonic);
    const plaintext = JSON.stringify({ rows: [1, 2, 3] });

    const envelope = await encryptStringWithKey(key, plaintext, {
      ownerId: identity.ownerId,
    });
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(envelope.keying).toBe("recovery-phrase");
    expect(envelope.ownerId).toBe(identity.ownerId);

    expect(await decryptStringWithKey(key, envelope)).toBe(plaintext);
  });

  test("deriveBackupKeyBytes is deterministic, 32 bytes, and phrase-specific", async () => {
    const mnemonic = createMnemonic();
    const a = await deriveBackupKeyBytes(mnemonic);
    const b = await deriveBackupKeyBytes(mnemonic);
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);

    const other = await deriveBackupKeyBytes(createMnemonic());
    expect(Buffer.from(a).equals(Buffer.from(other))).toBe(false);
  });

  test("a different phrase's key fails to decrypt", async () => {
    const mnemonic = createMnemonic();
    const identity = await deriveIdentity(mnemonic);
    const envelope = await encryptStringWithKey(
      await deriveBackupKeyBytes(mnemonic),
      "secret",
      { ownerId: identity.ownerId },
    );

    const wrongKey = await deriveBackupKeyBytes(createMnemonic());
    await expect(
      decryptStringWithKey(wrongKey, envelope),
    ).rejects.toBeInstanceOf(PassphraseDecryptError);
  });

  test("decryptStringWithKey rejects a passphrase-mode envelope", async () => {
    await expect(
      decryptStringWithKey(new Uint8Array(32), { not: "an envelope" }),
    ).rejects.toBeInstanceOf(InvalidBackupEnvelopeError);
  });
});
