// The relay both devices sync through. Defaults to a local relay the visitor
// runs (`bun run relay:go`); editable and persisted in localStorage.

import type { Transport } from "@simplysync/engine";

const RELAY_KEY = "simplysync-playground:relayUrl";
export const DEFAULT_RELAY_URL = "http://localhost:4100";

export function loadRelayUrl(): string {
  return localStorage.getItem(RELAY_KEY)?.trim() || DEFAULT_RELAY_URL;
}

export function saveRelayUrl(url: string): void {
  localStorage.setItem(RELAY_KEY, url.trim());
}

export function httpTransport(url: string): readonly Transport[] {
  const trimmed = url.trim();
  return trimmed ? [{ type: "Http", url: trimmed }] : [];
}
