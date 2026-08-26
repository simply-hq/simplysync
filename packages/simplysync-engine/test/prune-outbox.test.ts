import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  id,
  NonEmptyString,
} from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createStore } from "../src/engine/store";
import { SYNC_OUTBOX_TABLE } from "../src/engine/constants";
import { memoryDriver, memoryStorage } from "./support";

const schema = { note: { id: id("Note"), body: NonEmptyString } };
const outboxCount = (db: Database) =>
  (
    db.prepare(`select count(*) as c from "${SYNC_OUTBOX_TABLE}"`).get() as {
      c: number;
    }
  ).c;

function enqueueFakeEvent(db: Database, eventId: string) {
  db.prepare(
    `insert into "${SYNC_OUTBOX_TABLE}" (event_id, envelope_json, pushed_at) values (?, '{}', ?)`,
  ).run(eventId, "2020-01-01T00:00:00.000Z");
}

describe("pruneOutbox (store)", () => {
  function makeStore(bases: string[]) {
    const { driver, db } = memoryDriver();
    const state = createEngineState({ name: "prune" });
    state.driver = driver;
    state.transports = bases.map((url) => ({ url }));
    const store = createStore(state, schema, { name: "prune" });
    store.ensureSchema();
    return { store, db, bases };
  }

  test("drops events delivered to every relay, keeps the rest", () => {
    const { store, db } = makeStore(["http://a", "http://b"]);
    for (const eid of ["e1", "e2", "e3", "e4"]) enqueueFakeEvent(db, eid);
    for (const eid of ["e1", "e2", "e3"]) {
      store.markOutboxDelivered(eid, "http://a");
    }
    for (const eid of ["e1", "e2"]) {
      store.markOutboxDelivered(eid, "http://b");
    }

    expect(store.pruneOutbox(["http://a", "http://b"])).toBe(2); // e1, e2
    expect(outboxCount(db)).toBe(2); // e3, e4 remain (not yet on b)
  });

  test("prunes nothing when a newly added relay has no acknowledgement", () => {
    const { store, db } = makeStore(["http://a", "http://b"]);
    for (const eid of ["e1", "e2"]) enqueueFakeEvent(db, eid);
    for (const eid of ["e1", "e2"]) {
      store.markOutboxDelivered(eid, "http://a");
    }
    expect(store.pruneOutbox(["http://a", "http://b"])).toBe(0);
    expect(outboxCount(db)).toBe(2);
  });

  test("prunes nothing with no relays configured", () => {
    const { store, db } = makeStore([]);
    for (const eid of ["e1", "e2"]) enqueueFakeEvent(db, eid);
    expect(store.pruneOutbox([])).toBe(0);
    expect(outboxCount(db)).toBe(2);
  });
});

describe("sync prunes the outbox automatically", () => {
  test("a full sync to a relay leaves the outbox empty", async () => {
    let handle!: { db: Database };
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { events: unknown[] };
        return new Response(
          JSON.stringify({ accepted: body.events.length, duplicate: 0 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
        status: 200,
      });
    }) as typeof fetch;

    const engine = createSync({
      createSqliteDriver: () => {
        const made = memoryDriver();
        handle = made;
        return made.driver;
      },
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, { name: "prune-sync" });
    await engine.ready;

    engine.insert("note", { body: "one" });
    engine.insert("note", { body: "two" });
    for (let i = 0; i < 40 && engine.getPendingOutboxCount() < 2; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(outboxCount(handle.db)).toBe(2);

    engine.setTransports([{ url: "http://relay.test" }]);
    for (let i = 0; i < 40 && outboxCount(handle.db) > 0; i++) {
      await engine.sync();
      await new Promise((r) => setTimeout(r, 20));
    }
    // Delivered events were pruned from the send queue; the rows themselves
    // remain in their table.
    expect(outboxCount(handle.db)).toBe(0);
    const notes = await engine.loadQuery(
      engine.createQuery((qb) => qb.selectFrom("note").select(["body"]), {
        includeDeleted: true,
      }),
    );
    expect(notes.length).toBe(2);
  });
});
