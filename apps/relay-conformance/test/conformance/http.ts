// Thin black-box HTTP helpers for the conformance suite: build the exact
// requests a client would send against /v1/events, /v1/usage, /v1/status, and
// /v1/blobs/:hash. Deliberately does not import any relay internals — every
// call here is a plain fetch(), so a divergence between relays shows up the
// same way it would to a real client.

import type { SyncEnvelope } from "@simplysync/protocol";
import type { TestIdentity } from "./envelopes";

/**
 * Cloudflare keys its per-IP limiters on CF-Connecting-IP, which a local
 * `wrangler dev` never sets — so every request in a run shares one budget and
 * the owner-creation limit (5/min) trips partway through a suite. Passing `ip`
 * lets a test present itself as the distinct client it actually is. Omitted,
 * the request is byte-for-byte what it was before.
 */
function authHeaders(
  test: TestIdentity,
  bearer?: string,
  ip?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer ?? test.identity.relayAuth}`,
  };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return headers;
}

export async function pushEvents(
  baseUrl: string,
  test: TestIdentity,
  events: SyncEnvelope[],
  { bearer, ip }: { bearer?: string; ip?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(test, bearer, ip),
    },
    body: JSON.stringify({ ownerId: test.identity.ownerId, events }),
  });
}

export async function pullEvents(
  baseUrl: string,
  test: TestIdentity,
  after: string,
  { limit, bearer, ip }: { limit?: number; bearer?: string; ip?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({
    ownerId: test.identity.ownerId,
    after,
  });
  if (limit !== undefined) params.set("limit", String(limit));
  return fetch(`${baseUrl}/v1/events?${params.toString()}`, {
    headers: authHeaders(test, bearer, ip),
  });
}

export async function compactStreams(
  baseUrl: string,
  test: TestIdentity,
  streamIds: string[],
  { bearer }: { bearer?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/streams/compact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer ?? test.identity.relayAuth}`,
    },
    body: JSON.stringify({ ownerId: test.identity.ownerId, streamIds }),
  });
}

export async function getUsage(
  baseUrl: string,
  test: TestIdentity,
  { bearer, ip }: { bearer?: string; ip?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(`${baseUrl}/v1/usage?${params.toString()}`, {
    headers: authHeaders(test, bearer, ip),
  });
}

export async function getStatus(
  baseUrl: string,
  test: TestIdentity,
  { bearer, ip }: { bearer?: string; ip?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(`${baseUrl}/v1/status?${params.toString()}`, {
    headers: authHeaders(test, bearer, ip),
  });
}

export async function putBlob(
  baseUrl: string,
  test: TestIdentity,
  hash: string,
  bytes: Uint8Array,
  { bearer }: { bearer?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(
    `${baseUrl}/v1/blobs/${encodeURIComponent(hash)}?${params.toString()}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${bearer ?? test.identity.relayAuth}` },
      // Same conversion tools/protocol-demo/src/client.ts uses when
      // uploading blob chunks — TS's DOM BodyInit type doesn't line up with
      // bun-types' Uint8Array<ArrayBufferLike> directly.
      body: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer,
    },
  );
}

export async function getBlob(
  baseUrl: string,
  test: TestIdentity,
  hash: string,
  { bearer }: { bearer?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(
    `${baseUrl}/v1/blobs/${encodeURIComponent(hash)}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${bearer ?? test.identity.relayAuth}` } },
  );
}

export async function headBlob(
  baseUrl: string,
  test: TestIdentity,
  hash: string,
  { bearer }: { bearer?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(
    `${baseUrl}/v1/blobs/${encodeURIComponent(hash)}?${params.toString()}`,
    {
      method: "HEAD",
      headers: { Authorization: `Bearer ${bearer ?? test.identity.relayAuth}` },
    },
  );
}
