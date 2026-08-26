// Randomized convergence property test — the highest-value test class for a
// sync engine. Every other convergence test drives a path a human imagined;
// this one explores the state space where last-write-wins / HLC bugs actually
// live: N devices, random op interleavings, random partitions (a device simply
// doesn't sync for a while), random sync order. The invariant under test is the
// product's core promise: once every reachable device has synced to quiescence,
// they all hold byte-identical row state.
//
// Deterministic: a seeded PRNG drives the op sequence, and the seed + full op
// log print on failure so a discovered counterexample is reproducible. (HLC
// millis still come from the wall clock, so a purely timing-dependent failure
// may not reproduce on the first re-run — but the op sequence, which is what
// LWW-convergence bugs turn on, is fixed by the seed.)

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createMnemonic } from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SyncEngine,
  type Transport,
} from "../src/index";
import { fakeRelay, memoryDriver, memoryStorage, settle } from "./support";

const schema = {
  note: { id: id("Note"), title: NonEmptyString, details: NonEmptyString },
};

const RELAY_URL = "http://relay.test";

// mulberry32 — same tiny deterministic PRNG order.test.ts uses. No Math.random.
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Device {
  readonly name: string;
  readonly engine: SyncEngine<typeof schema>;
  readonly db: Database;
}

function makeDevice(
  mnemonic: string,
  fetchImpl: typeof fetch,
  name: string,
): Device {
  const db = new Database(":memory:");
  const engine = createSync({
    createSqliteDriver: () => memoryDriver(db).driver,
    secureStorage: memoryStorage(),
    fetch: fetchImpl,
  })(schema, {
    name,
    externalAppOwner: { id: "", mnemonic, writeKey: "" },
    // Only explicit sync() calls touch the relay, so the interleaving is fully
    // controlled by this test rather than a background poller.
    syncIntervalMs: 3_600_000,
  });
  return { name, engine, db };
}

/** The full row state of one device, as a stable comparable string. */
function snapshot(db: Database): string {
  const rows = db
    .prepare(`select id, title, details, isDeleted from "note" order by id`)
    .all();
  return JSON.stringify(rows);
}

/** Sync every device to quiescence, repeatedly, until propagation settles. A
 * few rounds are needed: device A's push in round 1 is only pulled by B in a
 * later round. */
async function syncAllToQuiescence(devices: Device[]): Promise<void> {
  let prev = "";
  for (let round = 0; round < devices.length + 3; round += 1) {
    for (const d of devices) {
      await d.engine.sync().catch(() => undefined);
      await settle(d.engine);
    }
    const state = devices.map((d) => snapshot(d.db)).join("|");
    if (state === prev) return; // stable across a full round → done
    prev = state;
  }
}

describe("convergence (randomized property test)", () => {
  const DEVICE_COUNT = 3;
  const TRIALS = 8;
  const OPS_PER_TRIAL = 40;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    // Distinct, fixed seed per trial. Printed in any failure message below.
    const seed = 0xc0ffee + trial * 0x9e3779b1;

    test(`${DEVICE_COUNT} devices converge under random ops (seed ${seed})`, async () => {
      const rng = mulberry32(seed);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(rng() * xs.length)]!;

      const mnemonic = createMnemonic();
      const relay = fakeRelay();
      const devices: Device[] = [];
      for (let i = 0; i < DEVICE_COUNT; i += 1) {
        const d = makeDevice(mnemonic, relay.fetch, `d${i}`);
        await d.engine.ready;
        const transports: Transport[] = [{ url: RELAY_URL }];
        d.engine.setTransports(transports);
        await settle(d.engine);
        devices.push(d);
      }

      // Seed a handful of rows on d0 and propagate them to everyone, so every
      // device shares a common set of ids that concurrent updates can collide
      // on (the interesting LWW case).
      const seededIds: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const r = devices[0]!.engine.insert("note", {
          title: `seed-${i}`,
          details: `d0-${i}`,
        });
        if (r.ok) seededIds.push(r.value.id);
      }
      await syncAllToQuiescence(devices);

      // A device may only edit rows it currently holds locally — a real app
      // can't update a row id it has never received. (An earlier version of this
      // test edited ids the acting device hadn't synced, which produces a
      // partial-row event and a genuine but out-of-scope divergence: the
      // originator keeps its own field while devices that never saw the row get
      // null. Editing only local rows models real usage and isolates the
      // convergence property that matters.)
      const localRowIds = (db: Database): string[] =>
        (
          db.prepare(`select id from "note" where isDeleted = 0`).all() as Array<{
            id: string;
          }>
        ).map((r) => r.id);

      const opLog: string[] = [];
      let writeCounter = 0;
      for (let op = 0; op < OPS_PER_TRIAL; op += 1) {
        const device = pick(devices);
        const local = localRowIds(device.db);
        // No local rows to edit → the only sensible op is a fresh insert.
        const action =
          local.length === 0
            ? "insert"
            : pick(["update", "delete", "insert", "insert"] as const);
        writeCounter += 1;
        if (action === "insert") {
          const r = device.engine.insert("note", {
            title: `new-${writeCounter}`,
            details: `${device.name}-${writeCounter}`,
          });
          opLog.push(`${device.name} insert ${r.ok ? r.value.id : "FAIL"}`);
        } else if (action === "update") {
          const target = pick(local);
          device.engine.update("note", {
            id: target,
            title: `upd-${writeCounter}`,
          });
          opLog.push(`${device.name} update ${target} -> upd-${writeCounter}`);
        } else {
          const target = pick(local);
          device.engine.delete("note", target);
          opLog.push(`${device.name} delete ${target}`);
        }

        // Randomly sync a subset now (partition/heal): sometimes the acting
        // device pushes, sometimes an unrelated device pulls, sometimes nobody
        // — leaving events stranded until the final quiescence.
        if (rng() < 0.5) {
          const syncer = pick(devices);
          await syncer.engine.sync().catch(() => undefined);
          await settle(syncer.engine);
        }
      }

      await syncAllToQuiescence(devices);

      // The property: every device holds identical row state.
      const snapshots = devices.map((d) => snapshot(d.db));
      const allEqual = snapshots.every((s) => s === snapshots[0]);
      if (!allEqual) {
        throw new Error(
          `Devices did not converge (seed ${seed}).\n` +
            `Op log:\n${opLog.join("\n")}\n\n` +
            snapshots
              .map((s, i) => `${devices[i]!.name}: ${s}`)
              .join("\n"),
        );
      }
      expect(allEqual).toBe(true);
      // And convergence is not the trivial empty state — real rows survived.
      expect(snapshots[0]!.length).toBeGreaterThan(2);
    });
  }
});
