// Generates real, validly-encrypted SyncEnvelopes for the conformance suite
// using @simplysync/protocol — the same identity derivation and AES-GCM
// envelope encryption a real client uses — rather than hand-building
// envelope-shaped JSON. A fresh identity (fresh mnemonic => fresh ownerId) is
// cheap, so tests get one per test for isolation instead of sharing state.

import {
  createDeviceId,
  createHlc,
  createMnemonic,
  deriveIdentity,
  encryptPayload,
  type LocalFirstIdentity,
  type SyncEnvelope,
} from "@simplysync/protocol";

export interface TestIdentity {
  readonly identity: LocalFirstIdentity;
  readonly deviceId: string;
}

/** A fresh owner identity + device id, isolated from every other test. */
export async function createTestIdentity(): Promise<TestIdentity> {
  const identity = await deriveIdentity(createMnemonic());
  const deviceId = await createDeviceId();
  return { identity, deviceId };
}

interface MakeEnvelopeOptions {
  readonly rowId?: string;
  readonly counter?: number;
  readonly table?: string;
  readonly op?: "upsert" | "delete";
  readonly value?: unknown;
  readonly now?: number;
}

/** One validly-encrypted envelope for `test`'s identity. */
export async function makeEnvelope(
  test: TestIdentity,
  options: MakeEnvelopeOptions = {},
): Promise<SyncEnvelope> {
  const now = options.now ?? Date.now();
  const counter = options.counter ?? 0;
  const eventId = createHlc(test.deviceId, now, counter);
  return encryptPayload(
    test.identity,
    { eventId, deviceId: test.deviceId },
    {
      schemaVersion: 1,
      table: options.table ?? "note",
      op: options.op ?? "upsert",
      rowId: options.rowId ?? eventId,
      hlc: eventId,
      value: options.value ?? { body: "conformance suite payload" },
    },
  );
}

/**
 * `count` validly-encrypted envelopes for `test`'s identity, each a distinct
 * row (so none collapse into the same streamId) with strictly increasing HLC
 * counters (so push order is deterministic).
 */
export async function makeEnvelopes(
  test: TestIdentity,
  count: number,
  options: Omit<MakeEnvelopeOptions, "counter" | "rowId"> = {},
): Promise<SyncEnvelope[]> {
  const out: SyncEnvelope[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(
      await makeEnvelope(test, { ...options, counter: i, rowId: `row-${i}` }),
    );
  }
  return out;
}
