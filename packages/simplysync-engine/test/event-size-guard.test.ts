// A write whose encrypted event would exceed the relay's per-event cap must be
// rejected AT WRITE TIME, not let into the outbox where a relay 413s it on every
// push and stalls every later write behind it (head-of-line poison pill).

import { describe, expect, test } from "bun:test";

import { createSync, id, NonEmptyString } from "../src/index";
import { memoryDriver, memoryStorage } from "./support";

const schema = {
  note: { id: id("Note"), body: NonEmptyString },
};

function makeApp(maxEventBytes?: number) {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "size-guard-app", maxEventBytes });
}

describe("event size guard", () => {
  test("rejects an oversized write and keeps the outbox empty", async () => {
    const engine = makeApp();
    await engine.ready;

    // A ~300 KiB body blows past the 256 KiB default cap once encrypted.
    const huge = engine.insert("note", { body: "x".repeat(300 * 1024) });
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.error.message).toMatch(/too large/i);

    // The poison pill never formed: nothing is pending to push.
    expect(engine.getPendingOutboxCount()).toBe(0);

    // A normal write still succeeds and enqueues.
    const ok = engine.insert("note", { body: "hello" });
    expect(ok.ok).toBe(true);
    expect(engine.getPendingOutboxCount()).toBe(1);
  });

  test("a local-only write is exempt (it never pushes)", async () => {
    const engine = makeApp();
    await engine.ready;
    const local = engine.insert(
      "note",
      { body: "x".repeat(300 * 1024) },
      { local: true },
    );
    expect(local.ok).toBe(true);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });

  test("the cap is configurable", async () => {
    const engine = makeApp(1024);
    await engine.ready;
    const res = engine.insert("note", { body: "x".repeat(2048) });
    expect(res.ok).toBe(false);
  });
});
