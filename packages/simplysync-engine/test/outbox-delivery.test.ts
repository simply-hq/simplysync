// The Outbox's five states now all live in the Store, so "can an event be
// lost?" is answerable without an engine, a fake fetch, or a fake clock. Before
// this, the seal and push halves were raw SQL in relay.ts and the only way to
// reach them was to drive a whole sync pass against a stubbed relay.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { id, NonEmptyString, type SqliteDriver } from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createStore } from "../src/engine/store";
import { SYNC_OUTBOX_TABLE } from "../src/engine/constants";

function makeDriver(): { driver: SqliteDriver; db: Database } {
  const db = new Database(":memory:");
  return {
    db,
    driver: {
      exec(sql, params) {
        db.prepare(sql).run(...((params ?? []) as never[]));
      },
      select(sql, params) {
        return db.prepare(sql).all(...((params ?? []) as never[])) as never;
      },
      transaction(fn) {
        return db.transaction(fn)();
      },
    },
  };
}

const schema = { note: { id: id("Note"), body: NonEmptyString } };

function makeStore(bases: string[] = []) {
  const { driver, db } = makeDriver();
  const state = createEngineState({ name: "outbox" });
  state.driver = driver;
  state.transports = bases.map((url) => ({ type: "Http" as const, url }));
  const store = createStore(state, schema, { name: "outbox" });
  store.ensureSchema();
  return { store, db };
}

const AT = "2020-01-01T00:00:00.000Z";

const pushedAt = (db: Database, eventId: string): string | null =>
  (
    db
      .prepare(
        `select pushed_at from "${SYNC_OUTBOX_TABLE}" where event_id = ?`,
      )
      .get(eventId) as { pushed_at: string | null } | undefined
  )?.pushed_at ?? null;

describe("outbox delivery (store)", () => {
  test("a pending event is unsealed, unpushable, and sealed exactly once", () => {
    const { store } = makeStore();
    store.insertPendingOutboxEvent("e1", '{"table":"note"}');

    // Pending: visible to the seal step, invisible to any push.
    expect(store.listUnsealedOutbox()).toEqual([
      { eventId: "e1", payloadJson: '{"table":"note"}' },
    ]);
    expect(store.claimPushBatch("http://a")).toEqual([]);

    store.sealOutboxEvent("e1", '{"ciphertext":"first"}');
    expect(store.listUnsealedOutbox()).toEqual([]);
    expect(store.claimPushBatch("http://a")).toEqual([
      { eventId: "e1", envelopeJson: '{"ciphertext":"first"}' },
    ]);

    // Idempotent: a concurrent pass must not re-encrypt under a second nonce.
    store.sealOutboxEvent("e1", '{"ciphertext":"second"}');
    expect(store.claimPushBatch("http://a")[0]?.envelopeJson).toBe(
      '{"ciphertext":"first"}',
    );
  });

  test("every configured relay gets its own copy", () => {
    const { store } = makeStore(["http://a", "http://b"]);
    for (const eid of ["e1", "e2"]) {
      store.insertPendingOutboxEvent(eid, "{}");
      store.sealOutboxEvent(eid, "{}");
    }

    store.markBatchDelivered(["e1", "e2"], "http://a", AT);

    expect(store.claimPushBatch("http://a")).toEqual([]);
    expect(store.claimPushBatch("http://b").map((e) => e.eventId)).toEqual([
      "e1",
      "e2",
    ]);
    // Delivered to a but not b: not prunable yet.
    expect(store.pruneOutbox(["http://a", "http://b"])).toBe(0);

    store.markBatchDelivered(["e1", "e2"], "http://b", AT);
    expect(store.pruneOutbox(["http://a", "http://b"])).toBe(2);
  });

  test("a lower-sorting straggler is still delivered after the cursor moved past it", () => {
    // The reason delivery is proved by acknowledgement rows and not by the push
    // cursor: another tab can commit a lower HLC after this relay's cursor has
    // already advanced beyond it.
    const { store } = makeStore(["http://a"]);
    for (const eid of ["e5", "e9"]) {
      store.insertPendingOutboxEvent(eid, "{}");
      store.sealOutboxEvent(eid, "{}");
    }
    store.markBatchDelivered(["e5", "e9"], "http://a", AT);
    expect(store.getMeta("push:http://a")).toBe("e9");

    store.insertPendingOutboxEvent("e7", "{}");
    store.sealOutboxEvent("e7", "{}");

    expect(store.claimPushBatch("http://a").map((e) => e.eventId)).toEqual([
      "e7",
    ]);
    // And the cursor does not regress when that straggler is acknowledged.
    store.markBatchDelivered(["e7"], "http://a", AT);
    expect(store.getMeta("push:http://a")).toBe("e9");
  });

  test("pushed_at keeps the earliest delivery across relays", () => {
    const { store, db } = makeStore(["http://a", "http://b"]);
    store.insertPendingOutboxEvent("e1", "{}");
    store.sealOutboxEvent("e1", "{}");

    expect(store.pendingOutboxCount()).toBe(1);
    store.markBatchDelivered(["e1"], "http://a", AT);
    expect(store.pendingOutboxCount()).toBe(0);

    store.markBatchDelivered(["e1"], "http://b", "2021-06-01T00:00:00.000Z");
    expect(pushedAt(db, "e1")).toBe(AT);
  });

  test("a claimed batch is capped, so a full batch never means drained", () => {
    const { store } = makeStore(["http://a"]);
    for (let i = 0; i < 1001; i += 1) {
      const eid = `e${String(i).padStart(4, "0")}`;
      store.insertPendingOutboxEvent(eid, "{}");
      store.sealOutboxEvent(eid, "{}");
    }
    const first = store.claimPushBatch("http://a");
    expect(first.length).toBe(1000);

    store.markBatchDelivered(
      first.map((e) => e.eventId),
      "http://a",
      AT,
    );
    expect(store.claimPushBatch("http://a").length).toBe(1);
  });
});
