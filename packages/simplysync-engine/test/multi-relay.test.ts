import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

function makeDriver(): SqliteDriver {
  const db = new Database(":memory:");
  return {
    exec(sql, params) {
      db.prepare(sql).run(...((params ?? []) as never[]));
    },
    select(sql, params) {
      return db.prepare(sql).all(...((params ?? []) as never[])) as never;
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
  };
}

function memoryStorage(): SecureStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

const schema = { note: { id: id("Note"), body: NonEmptyString } };
const settle = () => new Promise((r) => setTimeout(r, 25));

describe("multi-relay push redundancy", () => {
  test("every configured relay receives a full copy of this device's events", async () => {
    // Two stub relays that record which event ids they were pushed.
    const received: Record<string, Set<string>> = {
      a: new Set(),
      b: new Set(),
    };
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const relay = url.includes("relay-a") ? "a" : "b";
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          events: { eventId: string }[];
        };
        for (const e of body.events) received[relay]!.add(e.eventId);
        return new Response(
          JSON.stringify({ accepted: body.events.length, duplicate: 0 }),
          { status: 200 },
        );
      }
      // GET pull — nothing to hand back.
      return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
        status: 200,
      });
    }) as typeof fetch;

    // Start with NO transports so inserts don't kick off opportunistic syncs
    // that race the (async) enqueue — makes the test deterministic.
    const engine = createSync({
      createSqliteDriver: () => makeDriver(),
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, { name: "multi-relay-test" });
    await engine.ready;

    const ids: string[] = [];
    for (const body of ["one", "two", "three"]) {
      const r = engine.insert("note", { body });
      if (r.ok) ids.push(r.value.id);
    }
    expect(ids.length).toBe(3);

    // Let the three async enqueues land in the outbox, then attach both relays
    // and drive sync until the data propagates.
    for (let i = 0; i < 40 && engine.getPendingOutboxCount() < 3; i++) {
      await settle();
    }
    expect(engine.getPendingOutboxCount()).toBe(3);

    engine.setTransports([
      { type: "Http", url: "http://relay-a.test" },
      { type: "Http", url: "http://relay-b.test" },
    ]);
    for (let i = 0; i < 40 && (received.a.size < 3 || received.b.size < 3); i++) {
      await engine.sync();
      await settle();
    }

    // Both relays got all three events — not just the first relay contacted.
    expect(received.a.size).toBe(3);
    expect(received.b.size).toBe(3);
    expect([...received.a].sort()).toEqual([...received.b].sort());
  });
});
