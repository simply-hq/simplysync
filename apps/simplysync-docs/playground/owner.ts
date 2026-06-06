// One owner, shared by both simulated devices. The playground owns the recovery
// mnemonic (in localStorage) and passes the derived AppOwner to both engines via
// `config.externalAppOwner`, so they sync the same encrypted log. Reset/restore
// are page-level (the owner is shared), not per-engine.

import {
  createMnemonic,
  deriveIdentity,
  isRecoveryMnemonic,
  normalizeMnemonic,
} from "@simplysync/protocol";
import type { AppOwner } from "@simplysync/engine";

const MNEMONIC_KEY = "simplysync-playground:mnemonic";

export function loadOrCreateMnemonic(): string {
  const stored = localStorage.getItem(MNEMONIC_KEY);
  if (stored && isRecoveryMnemonic(stored)) return normalizeMnemonic(stored);
  const fresh = createMnemonic();
  localStorage.setItem(MNEMONIC_KEY, fresh);
  return fresh;
}

/** Persists a (validated) mnemonic. Throws on an invalid phrase. */
export function setMnemonic(mnemonic: string): void {
  const normalized = normalizeMnemonic(mnemonic);
  if (!isRecoveryMnemonic(normalized)) {
    throw new Error("That is not a valid BIP39 recovery phrase.");
  }
  localStorage.setItem(MNEMONIC_KEY, normalized);
}

/** Replaces the owner with a brand-new random mnemonic. */
export function rotateMnemonic(): void {
  localStorage.setItem(MNEMONIC_KEY, createMnemonic());
}

export async function deriveAppOwner(mnemonic: string): Promise<AppOwner> {
  const identity = await deriveIdentity(mnemonic);
  return {
    id: identity.ownerId,
    mnemonic: normalizeMnemonic(mnemonic),
    writeKey: identity.relayAuth,
  };
}
