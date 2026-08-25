import { describe, expect, test } from "bun:test";

import {
  createSync,
  id,
  NonEmptyString,
} from "../src/index";
import { fakeRelay, memoryDriver, memoryStorage } from "./support";

const schema = { note: { id: id("Note"), body: NonEmptyString } };

function makeEngine(name: string, fetchImpl: typeof fetch) {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
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
    const relay = fakeRelay({ holdFirstPush: true });
    const engine = makeEngine("sync-await-test", relay.fetch);
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
    expect(relay.pushedEventIds().length).toBe(2);
    engine.setTransports([]);
  });

  test("concurrent callers coalesce into a single follow-up pass", async () => {
    const relay = fakeRelay({ holdFirstPush: true });
    const engine = makeEngine("sync-coalesce-test", relay.fetch);
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
    const relay = fakeRelay({ holdFirstPush: true });
    const engine = makeEngine("sync-shared-drain-test", relay.fetch);
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
