// Thin black-box HTTP helpers for the conformance suite: build the exact
// requests a client would send against /v1/events, /v1/usage, /v1/status, and
// /v1/blobs/:hash. Deliberately does not import any relay internals — every
// call here is a plain fetch(), so a divergence between relays shows up the
// same way it would to a real client.

import type { SyncEnvelope } from "@simplysync/protocol";
import type { TestIdentity } from "./envelopes";

/**
 * Cloudflare keys its per-IP limiters on CF-Connecting-IP, which a local
 * `wrangler dev` never sets — so without this every request in a run shares one
 * budget and the owner-creation limit (5/min) trips partway through a suite.
 * Each test owner is a different client, so each gets its own address, derived
 * from the owner id and stable across the requests of one test. Go reads the
 * same header for its per-IP limiter, so both relays see the same clients.
 *
 * Pass `ip` explicitly only to say something about addresses — that several
 * owners share one, or that one owner moved.
 */
export function ipFor(test: TestIdentity): string {
  const id = test.identity.ownerId;
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `10.${(h >>> 16) & 255}.${(h >>> 8) & 255}.${h & 255}`;
}

function authHeaders(
  test: TestIdentity,
  bearer?: string,
  ip?: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer ?? test.identity.relayAuth}`,
    "CF-Connecting-IP": ip ?? ipFor(test),
  };
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
  { bearer, ip }: { bearer?: string; ip?: string } = {},
): Promise<Response> {
  return fetch(`${baseUrl}/v1/streams/compact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(test, bearer, ip),
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
  { bearer, ip }: { bearer?: string; ip?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(
    `${baseUrl}/v1/blobs/${encodeURIComponent(hash)}?${params.toString()}`,
    {
      method: "PUT",
      headers: authHeaders(test, bearer, ip),
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
  { bearer, ip }: { bearer?: string; ip?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(
    `${baseUrl}/v1/blobs/${encodeURIComponent(hash)}?${params.toString()}`,
    { headers: authHeaders(test, bearer, ip) },
  );
}

export async function headBlob(
  baseUrl: string,
  test: TestIdentity,
  hash: string,
  { bearer, ip }: { bearer?: string; ip?: string } = {},
): Promise<Response> {
  const params = new URLSearchParams({ ownerId: test.identity.ownerId });
  return fetch(
    `${baseUrl}/v1/blobs/${encodeURIComponent(hash)}?${params.toString()}`,
    { method: "HEAD", headers: authHeaders(test, bearer, ip) },
  );
}
