import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createHlc,
  decryptEnvelope,
  deriveIdentity,
  type SyncEnvelope,
} from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";
import { SYNC_OUTBOX_TABLE } from "../src/engine/constants";

// --- Scope note -------------------------------------------------------------
//
// Plan 005 (Option 2): the local row write and its `_sync_outbox` marker are
// made atomic by inserting the outbox row SYNCHRONOUSLY, in the SAME
// `driver.transaction(...)` as the row write, holding the PLAINTEXT payload
// (`payload_json`) with an empty `envelope_json` placeholder (`''` = "not yet
// sealed"). Encryption is deferred to an async "seal" step
// (`sealPendingOutbox` in relay.ts) that runs at the start of every `sync()` —
// covering boot, since a crash between a write and its seal is repaired by
// the very first sync call after restart. A relay only ever receives sealed
// rows (`envelope_json != ''`). This keeps `insert`/`update`/`upsert`/`batch`
// fully synchronous (no API shape change) while closing the crash window the
// old async `enqueue` left open (see the sibling branch's write-atomicity
// test for that gap's description).

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

// A driver whose underlying row-write engine works normally EXCEPT that any
// attempt to insert into `_sync_outbox` throws — simulating a failure in the
// (synchronous) pending-outbox insert itself. Used to prove the row write and
// its outbox marker share a real SQLite transaction: if the insert-outbox
// statement fails, the row write earlier in the same transaction must roll
// back too.
function makeThrowingOutboxDriver(): { driver: SqliteDriver; db: Database } {
  const db = new Database(":memory:");
  return {
    db,
    driver: {
      exec(sql, params) {
        if (/insert or ignore into "_sync_outbox"/i.test(sql)) {
          throw new Error("simulated outbox insert failure");
        }
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
const settle = () => new Promise((r) => setTimeout(r, 20));

function count(db: Database, table: string): number {
  return (
    db.prepare(`select count(*) as c from "${table}"`).get() as { c: number }
  ).c;
}

const okPushResponse = (n: number) =>
  new Response(JSON.stringify({ accepted: n, duplicate: 0 }), { status: 200 });
const emptyPullResponse = () =>
  new Response(JSON.stringify({ events: [], nextCursor: "" }), { status: 200 });

describe("write atomicity (Plan 005, Option 2)", () => {
  test("a failing outbox insert rolls back the row write too — atomic in one transaction", async () => {
    let handle!: { driver: SqliteDriver; db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        handle = makeThrowingOutboxDriver();
        return handle.driver;
      },
      secureStorage: memoryStorage(),
    })(schema, { name: "atomic-rollback-test" });
    await engine.ready;

    const result = engine.insert("note", { body: "should not persist" });
    expect(result.ok).toBe(false);

    // Neither the row nor the (failed) outbox marker survived — the whole
    // transaction rolled back together.
    expect(count(handle.db, "note")).toBe(0);
    expect(count(handle.db, SYNC_OUTBOX_TABLE)).toBe(0);
  });

  test("a normal write's row and its pending outbox marker both exist immediately (same transaction)", async () => {
    let handle!: { driver: SqliteDriver; db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        handle = makeDriver();
        return handle.driver;
      },
      secureStorage: memoryStorage(),
    })(schema, { name: "atomic-write-test" });
    await engine.ready;

    const result = engine.insert("note", { body: "buy milk" });
    expect(result.ok).toBe(true);

    // No `await`/settle needed: the outbox insert is synchronous, part of the
    // very same transaction as the row write.
    expect(count(handle.db, "note")).toBe(1);
    const outboxRow = handle.db
      .prepare(
        `select event_id, payload_json, envelope_json, pushed_at from "${SYNC_OUTBOX_TABLE}"`,
      )
      .get() as {
      event_id: string;
      payload_json: string;
      envelope_json: string;
      pushed_at: string | null;
    };
    expect(outboxRow.payload_json.length).toBeGreaterThan(0);
    // Unsealed: plaintext-pending marker, not yet encrypted.
    expect(outboxRow.envelope_json).toBe("");
    expect(outboxRow.pushed_at).toBeNull();
    const payload = JSON.parse(outboxRow.payload_json) as {
      table: string;
      rowId: string;
      value: { body: string };
    };
    expect(payload.table).toBe("note");
    expect(payload.value.body).toBe("buy milk");
  });

  test("seal + push round-trip: the pending row is sealed and pushed; the relay's envelope decrypts back to the original value", async () => {
    const pushedEvents: Record<string, unknown>[] = [];
    const fetchStub = (async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          events: Record<string, unknown>[];
        };
        pushedEvents.push(...body.events);
        return okPushResponse(body.events.length);
      }
      return emptyPullResponse();
    }) as typeof fetch;

    let handle!: { driver: SqliteDriver; db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        handle = makeDriver();
        return handle.driver;
      },
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, { name: "seal-push-test" });
    await engine.ready;

    const result = engine.insert("note", { body: "hello relay" });
    expect(result.ok).toBe(true);

    // Right after the write (no sync yet): still plaintext-pending locally.
    const beforeSync = handle.db
      .prepare(`select envelope_json from "${SYNC_OUTBOX_TABLE}"`)
      .get() as { envelope_json: string };
    expect(beforeSync.envelope_json).toBe("");

    const owner = await engine.appOwner;
    expect(owner).not.toBeNull();

    engine.setTransports([{ type: "Http", url: "http://relay.test" }]);
    for (let i = 0; i < 40 && pushedEvents.length < 1; i++) {
      await engine.sync();
      await settle();
    }
    expect(pushedEvents.length).toBe(1);

    // The relay only ever sees a sealed envelope: opaque, with a real nonce
    // and ciphertext — never the plaintext payload_json shape.
    const pushedEnvelope = pushedEvents[0] as unknown as SyncEnvelope;
    expect(typeof pushedEnvelope.nonce).toBe("string");
    expect(typeof pushedEnvelope.ciphertext).toBe("string");
    expect(JSON.stringify(pushedEnvelope)).not.toContain("hello relay");

    // ...and it decrypts back to exactly what was written.
    const identity = await deriveIdentity(owner!.mnemonic);
    const decrypted = await decryptEnvelope<{ id: string; body: string }>(
      identity,
      pushedEnvelope,
    );
    expect(decrypted.table).toBe("note");
    expect(decrypted.value.body).toBe("hello relay");
  });

  test("boot reconciliation: a pending row orphaned by a crash before any seal gets sealed and pushed on the next sync", async () => {
    const pushedEvents: Record<string, unknown>[] = [];
    const fetchStub = (async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          events: Record<string, unknown>[];
        };
        pushedEvents.push(...body.events);
        return okPushResponse(body.events.length);
      }
      return emptyPullResponse();
    }) as typeof fetch;

    let handle!: { driver: SqliteDriver; db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        handle = makeDriver();
        return handle.driver;
      },
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, { name: "boot-reconcile-test" });
    await engine.ready;

    // Simulate the exact state a crash would leave: a pending outbox marker
    // (payload_json set, envelope_json unsealed) with no prior seal having
    // ever run — inserted directly, bypassing the write path entirely, so
    // this exercises sealPendingOutbox's own boot-time recovery independent
    // of `mutate`/`batch`.
    const orphanHlc = createHlc("crashed-device", Date.now() - 60_000, 0);
    handle.db
      .prepare(
        `insert into "${SYNC_OUTBOX_TABLE}" (event_id, payload_json, envelope_json, pushed_at) values (?, ?, '', null)`,
      )
      .run(
        orphanHlc,
        JSON.stringify({
          schemaVersion: 1,
          table: "note",
          op: "upsert",
          rowId: "orphan-1",
          hlc: orphanHlc,
          value: {
            id: "orphan-1",
            body: "orphaned write",
            createdAt: "2020-01-01T00:00:00.000Z",
            updatedAt: orphanHlc,
            isDeleted: 0,
          },
        }),
      );

    engine.setTransports([{ type: "Http", url: "http://relay.test" }]);
    for (let i = 0; i < 40 && pushedEvents.length < 1; i++) {
      await engine.sync();
      await settle();
    }
    expect(pushedEvents.length).toBe(1);
    expect((pushedEvents[0] as unknown as SyncEnvelope).eventId).toBe(
      orphanHlc,
    );

    const owner = await engine.appOwner;
    const identity = await deriveIdentity(owner!.mnemonic);
    const decrypted = await decryptEnvelope<{ body: string }>(
      identity,
      pushedEvents[0] as unknown as SyncEnvelope,
    );
    expect(decrypted.value.body).toBe("orphaned write");
  });

  test("a local-only write creates no outbox row at all", async () => {
    let handle!: { driver: SqliteDriver; db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        handle = makeDriver();
        return handle.driver;
      },
      secureStorage: memoryStorage(),
    })(schema, { name: "local-only-test" });
    await engine.ready;

    const result = engine.insert(
      "note",
      { body: "draft, never synced" },
      { local: true },
    );
    expect(result.ok).toBe(true);

    expect(count(handle.db, SYNC_OUTBOX_TABLE)).toBe(0);
    expect(engine.getPendingOutboxCount()).toBe(0);
  });

  test("idempotency: sealing twice doesn't re-encrypt, and pushing an already-pushed row is a no-op", async () => {
    const goodEvents: Record<string, unknown>[] = [];
    const fetchStub = (async (input, init) => {
      const url = String(input);
      // relay-bad always fails, so its push cursor never advances and the
      // outbox row is never pruned — keeping it around long enough to compare
      // across two full sync() calls.
      if (url.includes("relay-bad")) {
        return new Response("boom", { status: 500 });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as {
          events: Record<string, unknown>[];
        };
        goodEvents.push(...body.events);
        return okPushResponse(body.events.length);
      }
      return emptyPullResponse();
    }) as typeof fetch;

    let handle!: { driver: SqliteDriver; db: Database };
    const engine = createSync({
      createSqliteDriver: () => {
        handle = makeDriver();
        return handle.driver;
      },
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, { name: "idempotent-seal-test" });
    await engine.ready;

    const result = engine.insert("note", { body: "seal me once" });
    expect(result.ok).toBe(true);

    engine.setTransports([
      { type: "Http", url: "http://relay-good.test" },
      { type: "Http", url: "http://relay-bad.test" },
    ]);
    for (let i = 0; i < 40 && goodEvents.length < 1; i++) {
      await engine.sync();
      await settle();
    }
    expect(goodEvents.length).toBe(1);

    const readEnvelope = () =>
      (
        handle.db
          .prepare(`select envelope_json from "${SYNC_OUTBOX_TABLE}"`)
          .get() as { envelope_json: string } | undefined
      )?.envelope_json;
    const sealedOnce = readEnvelope();
    expect(sealedOnce).toBeTruthy();

    // A second full sync: relay-good already acknowledged this event and the
    // row must not be re-encrypted —
    // AES-GCM uses a fresh random nonce per encryption, so a re-seal would be
    // detectable as a changed envelope_json.
    await engine.sync();
    await settle();
    expect(goodEvents.length).toBe(1); // no duplicate push
    expect(readEnvelope()).toBe(sealedOnce); // byte-identical: not re-encrypted
  });
});
