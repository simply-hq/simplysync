import { describe, expect, test } from "bun:test";

import {
  createSync,
  id,
  NonEmptyString,
  String as Str,
} from "../src/index";
import { memoryDriver, memoryStorage, settle } from "./support";

const schema = {
  message: { id: id("Message"), role: NonEmptyString, body: Str },
};

function makeEngine() {
  // No transports: writes that *would* sync simply enqueue into the outbox, so
  // pending-outbox count is a clean proxy for "how many sync events were
  // generated".
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "streaming-test" });
}


describe("streaming / local-only writes", () => {
  test("local writes don't grow the outbox; the final commit does", async () => {
    const engine = makeEngine();
    await engine.ready;

    // Create the assistant message normally — one sync event.
    const created = engine.insert("message", { role: "assistant", body: "" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const messageId = created.value.id;
    await settle(engine);
    expect(engine.getPendingOutboxCount()).toBe(1);

    // Stream 200 tokens, each a local-only write. None should enqueue.
    let body = "";
    for (let i = 0; i < 200; i++) {
      body += "tok ";
      const r = engine.update(
        "message",
        { id: messageId, body } as never,
        { local: true },
      );
      expect(r.ok).toBe(true);
    }
    await settle(engine);
    expect(engine.getPendingOutboxCount()).toBe(1); // unchanged by streaming

    // The local DB already reflects the latest streamed text (UI is live).
    const liveQuery = engine.createQuery(
      (db) =>
        db.selectFrom("message").select(["body"]).where("id", "=", messageId),
      { includeDeleted: true },
    );
    const live = await engine.loadQuery(liveQuery);
    expect(live[0]?.body).toBe(body);

    // Commit once when generation completes — exactly one new sync event.
    const done = engine.update("message", { id: messageId, body } as never);
    expect(done.ok).toBe(true);
    await settle(engine);
    expect(engine.getPendingOutboxCount()).toBe(2);
  });

  test("a local-only write still wins LWW for later synced edits (fresh HLC)", async () => {
    const engine = makeEngine();
    await engine.ready;
    const created = engine.insert("message", { role: "user", body: "a" });
    if (!created.ok) return;
    const messageId = created.value.id;

    // A local-only edit bumps updatedAt; a subsequent synced edit must sort
    // strictly after it (so the committed value isn't discarded by stale HLC).
    engine.update("message", { id: messageId, body: "ab" } as never, {
      local: true,
    });
    const q = engine.createQuery(
      (db) =>
        db
          .selectFrom("message")
          .select(["body", "updatedAt"])
          .where("id", "=", messageId),
      { includeDeleted: true },
    );
    const afterLocal = await engine.loadQuery(q);
    const localHlc = (afterLocal[0] as { updatedAt: string }).updatedAt;

    engine.update("message", { id: messageId, body: "abc" } as never);
    const afterCommit = await engine.loadQuery(q);
    const commitHlc = (afterCommit[0] as { updatedAt: string }).updatedAt;

    expect(afterCommit[0]?.body).toBe("abc");
    expect(commitHlc > localHlc).toBe(true);
  });
});
