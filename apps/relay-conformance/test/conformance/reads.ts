// Read helpers shared by the conformance and cross-relay suites, phrased the
// way a client would phrase them.

import { expect } from "bun:test";
import type { SyncEnvelope } from "@simplysync/protocol";
import type { TestIdentity } from "./envelopes";
import { createTestIdentity, makeEnvelopes } from "./envelopes";
import { getUsage, pullEvents, pushEvents } from "./http";

export interface PullBody {
  readonly events: SyncEnvelope[];
  readonly nextCursor: string;
}

export async function pull(
  base: string,
  who: TestIdentity,
  after = "",
  limit?: number,
): Promise<PullBody> {
  const res = await pullEvents(base, who, after, { limit });
  expect(res.status).toBe(200);
  return (await res.json()) as PullBody;
}

export async function eventIds(base: string, who: TestIdentity): Promise<string[]> {
  return (await pull(base, who)).events.map((event) => event.eventId);
}

export async function storedBytes(base: string, who: TestIdentity): Promise<number> {
  const res = await getUsage(base, who);
  expect(res.status).toBe(200);
  return ((await res.json()) as { storedBytes: number }).storedBytes;
}

/** A fresh owner with `count` events already pushed. */
export async function seed(
  base: string,
  count = 3,
): Promise<{ who: TestIdentity; events: SyncEnvelope[] }> {
  const who = await createTestIdentity();
  const events = await makeEnvelopes(who, count);
  const res = await pushEvents(base, who, events);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ accepted: count, duplicate: 0 });
  return { who, events };
}
