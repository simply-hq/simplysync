// The relay both devices sync through. A fresh app is intentionally local-only;
// entering a URL opts it into sync and persists that choice in localStorage.

import type { Transport } from "@simplysync/engine";

const RELAY_KEY = "simplysync-todolist:relayUrl";

export function loadRelayUrl(): string {
  return localStorage.getItem(RELAY_KEY)?.trim() || "";
}

export function saveRelayUrl(url: string): void {
  localStorage.setItem(RELAY_KEY, url.trim());
}

export function httpTransport(url: string): readonly Transport[] {
  const trimmed = url.trim();
  return trimmed ? [{ type: "Http", url: trimmed }] : [];
}
