import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHlc } from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
  type SyncState,
  type TabSync,
  type TabSyncEvent,
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

// An in-process TabSync bus: N members, synchronous delivery to everyone
// else, manually driven leadership. Mirrors what the browser coordinator does
// with BroadcastChannel + Web Locks.
function createFakeTabBus() {
  interface Member extends TabSync {
    readonly _events: Set<(events: readonly TabSyncEvent[]) => void>;
    readonly _syncStates: Set<(state: SyncState) => void>;
    readonly _promoted: Set<() => void>;
    _leader: boolean;
  }
  const members: Member[] = [];
  let lockChain: Promise<unknown> = Promise.resolve();

  const join = (leader: boolean): TabSync => {
    const member: Member = {
      _events: new Set(),
      _syncStates: new Set(),
      _promoted: new Set(),
      _leader: leader,
      isLeader: () => member._leader,
      onPromoted(cb) {
        member._promoted.add(cb);
        return () => member._promoted.delete(cb);
      },
      publishEvents(events) {
        for (const other of members) {
          if (other === member) continue;
          other._events.forEach((cb) => cb(events));
        }
      },
      subscribeEvents(cb) {
        member._events.add(cb);
        return () => member._events.delete(cb);
      },
      publishSyncState(state) {
        for (const other of members) {
          if (other === member) continue;
          other._syncStates.forEach((cb) => cb(state));
        }
      },
      subscribeSyncState(cb) {
        member._syncStates.add(cb);
        return () => member._syncStates.delete(cb);
      },
      withLock(_key, fn) {
        const run = lockChain.then(fn);
        lockChain = run.catch(() => undefined);
        return run;
      },
      acquireExclusive: async () => undefined,
    };
    members.push(member);
    return member;
  };

  const promote = (member: TabSync): void => {
    for (const m of members) m._leader = m === member;
    (member as Member)._promoted.forEach((cb) => cb());
  };

  return { join, promote };
}

function makeEngine(tabSync: TabSync, storage: SecureStorage, fetchStub?: typeof fetch) {
  const driver = makeDriver();
  const engine = createSync({
    createSqliteDriver: () => driver,
    secureStorage: storage,
    tabSync,
    fetch: fetchStub,
  })(schema, { name: "tab-test" });
  return { engine, driver };
}

describe("cross-tab replication", () => {
  test("a write in one tab appears in the other, staged in its outbox too", async () => {
    const bus = createFakeTabBus();
    const storage = memoryStorage();
    const a = makeEngine(bus.join(true), storage);
    await a.engine.ready;
    const b = makeEngine(bus.join(false), storage);
    await b.engine.ready;

    const inserted = a.engine.insert("note", { body: "from A" });
    expect(inserted.ok).toBe(true);

    const rowsInB = b.driver.select<{ body: string }>(
      'select body from "note"',
    );
    expect(rowsInB.map((r) => r.body)).toEqual(["from A"]);
    // B staged the event, so B could push it if promoted.
    expect(b.engine.getPendingOutboxCount()).toBe(1);

    // And the reverse direction: follower write reaches the leader.
    const back = b.engine.insert("note", { body: "from B" });
    expect(back.ok).toBe(true);
    const rowsInA = a.driver.select<{ body: string }>(
      'select body from "note" order by body',
    );
    expect(rowsInA.map((r) => r.body)).toEqual(["from A", "from B"]);
    expect(a.engine.getPendingOutboxCount()).toBe(2);
  });

  test("two tabs never mint the same HLC device id", async () => {
    const bus = createFakeTabBus();
    const storage = memoryStorage();
    const a = makeEngine(bus.join(true), storage);
    await a.engine.ready;
    const b = makeEngine(bus.join(false), storage);
    await b.engine.ready;

    a.engine.insert("note", { body: "a" });
    b.engine.insert("note", { body: "b" });
    const device = (updatedAt: string) => updatedAt.split("-").slice(2).join("-");
    const rows = a.driver.select<{ body: string; updatedAt: string }>(
      'select body, updatedAt from "note" order by body',
    );
    expect(rows.length).toBe(2);
    expect(device(rows[0]!.updatedAt)).not.toBe(device(rows[1]!.updatedAt));
  });

  test("an older leader forwards a future-version follower event without applying it", async () => {
    const bus = createFakeTabBus();
    const storage = memoryStorage();
    const leaderTab = bus.join(true);
    const futureTab = bus.join(false);
    const old = makeEngine(leaderTab, storage);
    await old.engine.ready;
    const eventId = createHlc("future-tab", Date.now(), 0);

    futureTab.publishEvents([{
      eventId,
      outbox: true,
      payloadJson: JSON.stringify({
        schemaVersion: 2,
        table: "note",
        op: "upsert",
        rowId: "future-note",
        hlc: eventId,
        value: {
          body: "meaning only v2 understands",
          createdAt: new Date().toISOString(),
          updatedAt: eventId,
          isDeleted: 0,
        },
      }),
    }]);

    expect(
      old.driver.select('select 1 from "note" where id = ?', ["future-note"]),
    ).toEqual([]);
    expect(old.engine.getPendingOutboxCount()).toBe(1);
  });

  test("LWW converges when tabs edit the same row; local writes propagate without staging", async () => {
    const bus = createFakeTabBus();
    const storage = memoryStorage();
    const a = makeEngine(bus.join(true), storage);
    await a.engine.ready;
    const b = makeEngine(bus.join(false), storage);
    await b.engine.ready;

    const inserted = a.engine.insert("note", { body: "v1" });
    if (!inserted.ok) throw new Error("insert failed");
    const noteId = inserted.value.id;
    b.engine.update("note", { id: noteId, body: "v2 from B" });
    a.engine.update("note", { id: noteId, body: "v3 from A" });

    const bodyIn = (t: { driver: SqliteDriver }) =>
      t.driver.select<{ body: string }>('select body from "note"')[0]?.body;
    expect(bodyIn(a)).toBe("v3 from A");
    expect(bodyIn(a)).toBe(bodyIn(b));

    const before = b.engine.getPendingOutboxCount();
    a.engine.update("note", { id: noteId, body: "draft" }, { local: true });
    expect(bodyIn(b)).toBe("draft"); // row propagated…
    expect(b.engine.getPendingOutboxCount()).toBe(before); // …but not staged
  });

  test("only the leader syncs; a promoted follower pushes the fleet's backlog", async () => {
    const pushed = new Set<string>();
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          events: { eventId: string }[];
        };
        for (const e of body.events) pushed.add(e.eventId);
        return new Response(
          JSON.stringify({ accepted: body.events.length, duplicate: 0 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
        status: 200,
      });
    }) as typeof fetch;

    const bus = createFakeTabBus();
    const storage = memoryStorage();
    const leaderTab = bus.join(true);
    const followerTab = bus.join(false);
    const a = makeEngine(leaderTab, storage, fetchStub);
    await a.engine.ready;
    const b = makeEngine(followerTab, storage, fetchStub);
    await b.engine.ready;
    b.engine.setTransports([{ type: "Http", url: "https://relay.test" }]);

    b.engine.insert("note", { body: "written in follower" });
    await b.engine.sync();
    await settle();
    // Follower never pushes — even with transports configured.
    expect(pushed.size).toBe(0);

    // Leader dies; follower is promoted and pushes what the fleet wrote.
    bus.promote(followerTab);
    await settle();
    expect(pushed.size).toBe(1);
  });

  test("a straggler outbox row below the push cursor still gets pushed, and is not pruned first", async () => {
    const pushed = new Set<string>();
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          events: { eventId: string }[];
        };
        for (const e of body.events) pushed.add(e.eventId);
        return new Response(
          JSON.stringify({ accepted: body.events.length, duplicate: 0 }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
        status: 200,
      });
    }) as typeof fetch;

    const bus = createFakeTabBus();
    const storage = memoryStorage();
    const a = makeEngine(bus.join(true), storage, fetchStub);
    await a.engine.ready;
    a.engine.setTransports([{ type: "Http", url: "https://relay.test" }]);

    a.engine.insert("note", { body: "first" });
    for (let i = 0; i < 40 && pushed.size < 1; i++) await settle();
    expect(pushed.size).toBe(1);

    // Simulate a cross-tab straggler: a sealed event whose id sorts below the
    // already-advanced push cursor (e.g. minted in another tab in the same
    // millisecond a push was in flight).
    a.driver.exec(
      `insert into "_sync_outbox" (event_id, payload_json, envelope_json, pushed_at) values ('0000000000-0000-straggler', null, '{"eventId":"0000000000-0000-straggler"}', null)`,
    );
    await a.engine.sync();
    expect(pushed.has("0000000000-0000-straggler")).toBe(true);
  });
});
