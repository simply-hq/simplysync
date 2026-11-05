// Long-poll: a relay that advertises `x-simplysync-max-wait` gets its
// periodic pull held open, so another device's change lands within a round
// trip; a local write cuts the wait short; a relay that advertises nothing
// is polled on the interval as before. Driven through a stub relay that
// honours `wait` the way the Go relay does.

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createHlc,
  createMnemonic,
  deriveIdentity,
  encryptPayload,
  type SyncEnvelope,
} from "@simplysync/protocol";
import { createSync, id, NonEmptyString } from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

const MNEMONIC = createMnemonic();
const schema = { note: { id: id("Note"), body: NonEmptyString } };

function stubRelay(maxWait: number | null) {
  const events: SyncEnvelope[] = [];
  const waits: number[] = [];
  let pulls = 0;
  let pushes = 0;
  let waiters: Array<() => void> = [];
  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { events: SyncEnvelope[] };
      events.push(...body.events);
      pushes += 1;
      wake();
      return Response.json({ accepted: body.events.length, duplicate: 0 });
    }
    pulls += 1;
    const after = Number(url.searchParams.get("after") ?? "0") || 0;
    const wait = Number(url.searchParams.get("wait") ?? "0") || 0;
    if (wait > 0) waits.push(wait);
    if (wait > 0 && events.length <= after) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, wait * 1000);
        waiters.push(done);
        init?.signal?.addEventListener("abort", done);
      });
      if (init?.signal?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
    }
    const slice = events.slice(after);
    return Response.json(
      { events: slice, nextCursor: String(after + slice.length), epoch: "e" },
      maxWait ? { headers: { "x-simplysync-max-wait": String(maxWait) } } : {},
    );
  }) as typeof fetch;
  return {
    url: "http://relay.test",
    fetch: fetchImpl,
    events,
    waits,
    pulls: () => pulls,
    pushes: () => pushes,
    waiting: () => waiters.length,
    addRemote(envelope: SyncEnvelope) {
      events.push(envelope);
      wake();
    },
  };
}

async function remoteEvent(body: string): Promise<SyncEnvelope> {
  const identity = await deriveIdentity(MNEMONIC);
  const rowId = `row-${body}`;
  const hlc = createHlc("device-remote", Date.now() - 10_000, 0);
  return encryptPayload(
    identity,
    { eventId: hlc, deviceId: "device-remote" },
    {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        id: rowId,
        body,
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    },
  );
}

function makeDevice(fetchImpl: typeof fetch, name: string, syncIntervalMs: number) {
  const db = new Database(":memory:");
  const engine = createSync({
    createSqliteDriver: () => memoryDriver(db).driver,
    secureStorage: memoryStorage(),
    fetch: fetchImpl,
  })(schema, {
    name,
    externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
    syncIntervalMs,
  });
  return { engine, db };
}

const until = async (check: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
};

describe("long-poll", () => {
  test("a supporting relay is held open, and a remote change lands within the wait", async () => {
    const relay = stubRelay(1);
    const { engine, db } = makeDevice(relay.fetch, "lp-remote", 50);
    await engine.ready;
    engine.setTransports([{ url: relay.url }]);
    try {
      // The first periodic tick discovers the ceiling; the next pull waits.
      expect(await until(() => relay.waiting() > 0, 3_000)).toBe(true);
      expect(relay.waits.every((w) => w === 1)).toBe(true);

      const t0 = Date.now();
      relay.addRemote(await remoteEvent("from afar"));
      const rows = () =>
        db.prepare(`select body from note`).all() as { body: string }[];
      expect(await until(() => rows().length === 1, 2_000)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(900); // well inside the 1 s wait
      expect(rows()[0]?.body).toBe("from afar");
    } finally {
      engine.close();
    }
  });

  test("a local write cuts the wait short and is pushed at once", async () => {
    const relay = stubRelay(1);
    const { engine } = makeDevice(relay.fetch, "lp-write", 50);
    await engine.ready;
    engine.setTransports([{ url: relay.url }]);
    try {
      expect(await until(() => relay.waiting() > 0, 3_000)).toBe(true);
      const before = relay.pushes();
      const t0 = Date.now();
      expect(engine.insert("note", { body: "mine" }).ok).toBe(true);
      expect(await until(() => relay.pushes() > before, 2_000)).toBe(true);
      expect(Date.now() - t0).toBeLessThan(700);
    } finally {
      engine.close();
    }
  });

  test("a relay that advertises no ceiling is never asked to wait", async () => {
    const relay = stubRelay(null);
    const { engine } = makeDevice(relay.fetch, "lp-none", 30);
    await engine.ready;
    engine.setTransports([{ url: relay.url }]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(relay.pulls()).toBeGreaterThan(1); // it does poll…
      expect(relay.waits).toEqual([]); // …but never with `wait`
    } finally {
      engine.close();
    }
  });

  test("longPoll: false keeps the plain poll even on a supporting relay", async () => {
    const relay = stubRelay(5);
    const db = new Database(":memory:");
    const engine = createSync({
      createSqliteDriver: () => memoryDriver(db).driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
    })(schema, {
      name: "lp-off",
      externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
      syncIntervalMs: 30,
      longPoll: false,
    });
    await engine.ready;
    engine.setTransports([{ url: relay.url }]);
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(relay.pulls()).toBeGreaterThan(1);
      expect(relay.waits).toEqual([]);
    } finally {
      engine.close();
    }
  });
});
