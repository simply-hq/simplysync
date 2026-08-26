import { describe, expect, test } from "bun:test";

import {
  decryptStringWithPassphrase,
  encryptStringWithPassphrase,
  InvalidBackupEnvelopeError,
  isEncryptedEnvelope,
  PassphraseDecryptError,
  type PassphraseKdf,
} from "../src/index";

// Keep the KDF cheap so the suite stays fast; the scheme is identical at any
// iteration count.
const FAST = { iterations: 1000 } as const;

describe("passphrase crypto", () => {
  test("round-trips a string through encrypt/decrypt", async () => {
    const plaintext = JSON.stringify({ hello: "world", n: 42, list: [1, 2] });
    const envelope = await encryptStringWithPassphrase(
      "correct horse battery staple",
      plaintext,
      FAST,
    );
    expect(isEncryptedEnvelope(envelope)).toBe(true);
    expect(envelope.ciphertext).not.toContain("world");

    const decrypted = await decryptStringWithPassphrase(
      "correct horse battery staple",
      envelope,
    );
    expect(decrypted).toBe(plaintext);
  });

  test("a wrong passphrase throws PassphraseDecryptError", async () => {
    const envelope = await encryptStringWithPassphrase("right", "secret", FAST);
    await expect(
      decryptStringWithPassphrase("wrong", envelope),
    ).rejects.toBeInstanceOf(PassphraseDecryptError);
  });

  test("rejects an absurd iteration count (denial-of-restore)", async () => {
    const envelope = await encryptStringWithPassphrase("pw", "secret", FAST);
    // A tampered file pins the restore to a huge KDF cost; decrypt must refuse
    // rather than burn CPU for minutes / hang the app.
    const tampered = {
      ...envelope,
      kdf: { ...envelope.kdf, iterations: 5_000_000_000 },
    };
    await expect(
      decryptStringWithPassphrase("pw", tampered),
    ).rejects.toBeInstanceOf(InvalidBackupEnvelopeError);
  });

  test("an unrecognized envelope throws InvalidBackupEnvelopeError", async () => {
    await expect(
      decryptStringWithPassphrase("pw", { not: "an envelope" }),
    ).rejects.toBeInstanceOf(InvalidBackupEnvelopeError);
    expect(isEncryptedEnvelope({ not: "an envelope" })).toBe(false);
  });

  test("an empty passphrase is rejected", async () => {
    await expect(
      encryptStringWithPassphrase("", "data", FAST),
    ).rejects.toThrow();
  });

  test("an injected KDF is honoured on both sides", async () => {
    // A deterministic stand-in for a native KDF: derives a fixed key per salt.
    const kdf: PassphraseKdf = (_passphrase, salt, _iterations, keyBytes) => {
      const out = new Uint8Array(keyBytes);
      for (let i = 0; i < keyBytes; i += 1) out[i] = salt[i % salt.length] ^ i;
      return out;
    };
    const envelope = await encryptStringWithPassphrase("pw", "payload", {
      kdf,
    });
    const decrypted = await decryptStringWithPassphrase("pw", envelope, { kdf });
    expect(decrypted).toBe("payload");
    // The default subtle KDF derives a different key, so decryption fails.
    await expect(
      decryptStringWithPassphrase("pw", envelope),
    ).rejects.toBeInstanceOf(PassphraseDecryptError);
  });
});
