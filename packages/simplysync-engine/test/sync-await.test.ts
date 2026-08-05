import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

function makeDriver(db = new Database(":memory:")): SqliteDriver {
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const schema = { note: { id: id("Note"), body: NonEmptyString } };

/**
 * A relay stub that blocks its FIRST push until released, so a second sync()
 * provably lands while a pass is in flight. Counts pushes to check coalescing.
 */
function holdingRelay() {
  const firstPushStarted = deferred();
  const releaseFirstPush = deferred();
  let pushes = 0;
  let eventsPushed = 0;

  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") {
      pushes += 1;
      const body = JSON.parse(String(init.body)) as {
        events: { eventId: string }[];
      };
      eventsPushed += body.events.length;
      if (pushes === 1) {
        firstPushStarted.resolve();
        await releaseFirstPush.promise;
      }
      return new Response(
        JSON.stringify({ accepted: body.events.length, duplicate: 0 }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
      status: 200,
    });
  }) as typeof fetch;

  return {
    fetchImpl,
    firstPushStarted: firstPushStarted.promise,
    release: releaseFirstPush.resolve,
    pushCount: () => pushes,
    eventCount: () => eventsPushed,
  };
}

function makeEngine(name: string, fetchImpl: typeof fetch) {
  return createSync({
    createSqliteDriver: () => makeDriver(),
    secureStorage: memoryStorage(),
    fetch: fetchImpl,
  })(schema, {
    name,
    transports: [{ type: "Http", url: "http://relay.test" }],
  });
}

/**
 * `await engine.sync()` must mean "a pass covering my writes finished" — a CLI,
 * a script, or a test has no other way to know it is safe to exit. It used to
 * return immediately whenever a pass was already in flight (very common: the
 * background poller ticks every syncIntervalMs), so the awaited call silently
 * pushed nothing.
 */
describe("await sync() covers the caller's writes", () => {
  test("a sync racing an in-flight pass still pushes the caller's event", async () => {
    const relay = holdingRelay();
    const engine = makeEngine("sync-await-test", relay.fetchImpl);
    await engine.ready;

    engine.insert("note", { body: "one" });
    const inFlight = engine.sync();
    await relay.firstPushStarted;

    // Written while a pass is mid-flight — exactly the case that used to no-op.
    const second = engine.insert("note", { body: "two" });
    if (!second.ok) throw new Error("insert failed");
    expect(engine.getPendingOutboxCount()).toBe(2); // neither event is out yet
    const racing = engine.sync();

    relay.release();
    await Promise.all([inFlight, racing]);

    // A drained outbox is the guarantee: by the time the caller's await
    // resolves, its write has reached the relay. (Outbox event ids are HLC
    // event ids, not row ids, so the count is what's assertable here.)
    expect(engine.getPendingOutboxCount()).toBe(0);
    expect(relay.eventCount()).toBe(2);
    engine.setTransports([]);
  });

  test("concurrent callers coalesce into a single follow-up pass", async () => {
    const relay = holdingRelay();
    const engine = makeEngine("sync-coalesce-test", relay.fetchImpl);
    await engine.ready;

    engine.insert("note", { body: "one" });
    const inFlight = engine.sync();
    await relay.firstPushStarted;

    engine.insert("note", { body: "two" });
    const waiters = [engine.sync(), engine.sync(), engine.sync()];

    relay.release();
    await Promise.all([inFlight, ...waiters]);

    // The held pass plus ONE follow-up shared by all three waiters — not one
    // relay round-trip per caller.
    expect(relay.pushCount()).toBe(2);
    expect(engine.getPendingOutboxCount()).toBe(0);
    engine.setTransports([]);
  });

  test("concurrent callers await the same drain", async () => {
    const relay = holdingRelay();
    const engine = makeEngine("sync-shared-drain-test", relay.fetchImpl);
    await engine.ready;

    engine.insert("note", { body: "one" });
    const inFlight = engine.sync();
    await relay.firstPushStarted;

    engine.insert("note", { body: "two" });
    const firstWaiter = engine.sync();
    const secondWaiter = engine.sync();

    expect(firstWaiter).toBe(secondWaiter);

    relay.release();
    await Promise.all([inFlight, firstWaiter, secondWaiter]);
    expect(engine.getPendingOutboxCount()).toBe(0);
    engine.setTransports([]);
  });
});
