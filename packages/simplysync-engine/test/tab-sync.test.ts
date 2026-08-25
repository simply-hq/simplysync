import { describe, expect, test } from "bun:test";
import { createHlc, createRecoveryKey } from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
  type TabSync,
} from "../src/index";
import { fakeTabBus, memoryDriver, memoryStorage, settle } from "./support";

const schema = { note: { id: id("Note"), body: NonEmptyString } };

// The only timed waits in this file, and both are proofs of a negative that
// `settle` cannot make: a pass parked at the relay never leaves
// "SyncStateIsSyncing", and a destructive op held at the barrier has no state
// at all to poll for.
const tick = () => new Promise((r) => setTimeout(r, 25));

function makeEngine(tabSync: TabSync, storage: SecureStorage, fetchStub?: typeof fetch) {
  const driver = memoryDriver().driver;
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
    const bus = fakeTabBus();
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
    const bus = fakeTabBus();
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
    const bus = fakeTabBus();
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
    const bus = fakeTabBus();
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

    const bus = fakeTabBus();
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
    await settle(b.engine);
    // Follower never pushes — even with transports configured.
    expect(pushed.size).toBe(0);

    // Leader dies; follower is promoted and pushes what the fleet wrote.
    bus.promote(followerTab);
    await settle(b.engine);
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

    const bus = fakeTabBus();
    const storage = memoryStorage();
    const a = makeEngine(bus.join(true), storage, fetchStub);
    await a.engine.ready;
    a.engine.setTransports([{ type: "Http", url: "https://relay.test" }]);

    a.engine.insert("note", { body: "first" });
    await settle(a.engine);
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

describe("identity under a cold start", () => {
  test("two tabs booting one empty profile settle on a single owner", async () => {
    // Both tabs find no stored credential and both want to mint one. Without
    // the cross-tab lock they each generate a different phrase and race the
    // write: two identities in one session, events sealed under two owners,
    // and half the user's data unreadable by the half that won.
    const bus = fakeTabBus();
    const storage = memoryStorage();

    const a = makeEngine(bus.join(true), storage);
    const b = makeEngine(bus.join(false), storage);
    const [ownerA, ownerB] = await Promise.all([
      a.engine.appOwner,
      b.engine.appOwner,
    ]);

    expect(ownerA?.id).toBeTruthy();
    expect(ownerB?.id).toBe(ownerA!.id);
    expect(ownerB?.recoveryKey).toBe(ownerA!.recoveryKey);
    // And exactly one credential was persisted, not one overwriting the other.
    expect(await storage.getItem("tab-test:mnemonic")).toBe(ownerA!.recoveryKey);
  });
});

describe("cross-tab robustness", () => {
  test("a follower buffers events broadcast while it is still booting", async () => {
    // A tab that joins mid-session subscribes before its database is open. If
    // those broadcasts were dropped instead of buffered, the new tab would be
    // silently missing every write made during its own boot, and would only
    // notice at the next relay pull — or never, on a local-only device.
    const bus = fakeTabBus();
    const storage = memoryStorage();
    const leader = makeEngine(bus.join(true), storage);
    await leader.engine.ready;

    // The follower is constructed (and subscribed) but deliberately not awaited.
    const follower = makeEngine(bus.join(false), storage);
    // Synchronous, so it lands before the follower's boot continues.
    const written = leader.engine.insert("note", { body: "during boot" });
    expect(written.ok).toBe(true);

    await follower.engine.ready;
    await settle(follower.engine);

    const rows = await follower.engine.loadQuery(
      follower.engine.createQuery((db) =>
        db.selectFrom("note").select(["body"]).where("isDeleted", "=", 0),
      ),
    );
    expect(rows.map((r) => r.body)).toEqual(["during boot"]);
  });

  test("an unusable broadcast is skipped without wedging the rest of the batch", async () => {
    // On the web the transport is a BroadcastChannel that anything on the
    // origin can post to, and during a rolling upgrade a peer may send a shape
    // this build does not accept. One bad entry must not cost the batch.
    const bus = fakeTabBus();
    const storage = memoryStorage();
    const a = makeEngine(bus.join(true), storage);
    const bTab = bus.join(false);
    const b = makeEngine(bTab, storage);
    await Promise.all([a.engine.ready, b.engine.ready]);

    const hlc = createHlc("peer-device", Date.now(), 0);
    const good = {
      eventId: hlc,
      payloadJson: JSON.stringify({
        schemaVersion: 1,
        table: "note",
        op: "upsert",
        rowId: "n-good",
        hlc,
        value: { body: "survives", updatedAt: hlc, createdAt: hlc, isDeleted: 0 },
      }),
      outbox: false,
    };
    const notJson = { eventId: "e-bad-1", payloadJson: "{not json", outbox: false };
    const notAPayload = {
      eventId: "e-bad-2",
      payloadJson: JSON.stringify({ nonsense: true }),
      outbox: false,
    };
    const unknownTable = {
      eventId: "e-bad-3",
      payloadJson: JSON.stringify({
        schemaVersion: 1,
        table: "nope",
        op: "upsert",
        rowId: "x",
        hlc,
        value: {},
      }),
      outbox: false,
    };

    // The bad entries bracket the good one, so an abort at the first failure
    // would lose it either way.
    bTab.publishEvents([notJson, notAPayload, good, unknownTable]);
    await settle(a.engine);

    const rows = await a.engine.loadQuery(
      a.engine.createQuery((db) =>
        db.selectFrom("note").select(["id", "body"]).where("isDeleted", "=", 0),
      ),
    );
    expect(rows).toEqual([{ id: "n-good", body: "survives" }]);
  });
});

describe("a queued pass respects a leadership change", () => {
  // A sync requested while another is in flight is queued, not run immediately.
  // By the time the drain gets to it, this tab may no longer be the leader —
  // and a follower that pushes is exactly the split-brain the leader model
  // exists to prevent. Two tabs contacting one relay with two device ids
  // produce duplicate outbox work and interleaved cursors.
  const hangingRelay = () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdNext = true;
    let pushes = 0;
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        pushes += 1;
        return new Response(JSON.stringify({ accepted: 1, duplicate: 0 }), {
          status: 200,
        });
      }
      if (holdNext) {
        holdNext = false;
        await held;
      }
      return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
        status: 200,
      });
    }) as typeof fetch;
    return { fetchImpl, release: () => release(), pushes: () => pushes };
  };

  const bootLeader = async (relay: ReturnType<typeof hangingRelay>) => {
    const bus = fakeTabBus();
    const leaderTab = bus.join(true);
    const followerTab = bus.join(false);
    const driver = memoryDriver().driver;
    const engine = createSync({
      createSqliteDriver: () => driver,
      secureStorage: memoryStorage(),
      tabSync: leaderTab,
      fetch: relay.fetchImpl,
    })(schema, {
      name: "tab-leadership",
      transports: [{ type: "Http", url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    return { engine, bus, followerTab };
  };

  test("a demoted tab drops the pass it had queued", async () => {
    const relay = hangingRelay();
    const { engine, bus, followerTab } = await bootLeader(relay);

    const inFlight = engine.sync(); // parks on the held pull
    await tick();

    engine.insert("note", { body: "queued behind the held pull" });
    await tick();
    expect(relay.pushes()).toBe(0); // still parked, nothing sent yet

    bus.promote(followerTab); // this tab is no longer the leader
    relay.release();
    await inFlight;
    await tick();

    // The queued pass was dropped rather than pushing as a follower.
    expect(relay.pushes()).toBe(0);
    // The write is not lost — it is staged, waiting for whoever leads next.
    expect(engine.getPendingOutboxCount()).toBe(1);
  });

  test("a tab that keeps leadership runs the pass it had queued", async () => {
    const relay = hangingRelay();
    const { engine } = await bootLeader(relay);

    const inFlight = engine.sync();
    await tick();

    engine.insert("note", { body: "queued behind the held pull" });
    await tick();
    expect(relay.pushes()).toBe(0);

    relay.release();
    await inFlight;
    await tick();

    expect(relay.pushes()).toBe(1);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });
});

describe("the destructive-op barrier", () => {
  test("a destructive op waits for the exclusive lock before replacing the database", async () => {
    // The destructive-op barrier is the strictest thing Leader-ship buys: no
    // sibling tab may write into a database another tab is replacing
    // wholesale. It is only load-bearing while something else holds the lock,
    // so hold it — with a no-op `acquireExclusive` the restore lands
    // immediately and the two assertions below it fail.
    const bus = fakeTabBus();
    const storage = memoryStorage();
    const a = makeEngine(bus.join(true), storage);
    await a.engine.ready;
    const before = await a.engine.appOwner;
    expect(a.engine.insert("note", { body: "written before the restore" }).ok)
      .toBe(true);

    const release = await bus.hold(); // another tab still owns the lock
    const restored = a.engine.restoreAppOwner(await createRecoveryKey(), {
      force: true,
    });
    await tick(); // no state to poll for an op that must not have started

    // Still this Owner's database: the op is queued behind the barrier.
    expect(
      a.driver.select<{ body: string }>('select body from "note"'),
    ).toEqual([{ body: "written before the restore" }]);
    expect((await a.engine.appOwner)?.id).toBe(before!.id);

    release();
    await restored;

    // Barrier passed: the local data is gone and the Owner has changed.
    expect(a.driver.select('select body from "note"')).toEqual([]);
    expect((await a.engine.appOwner)?.id).not.toBe(before!.id);
  });
});
