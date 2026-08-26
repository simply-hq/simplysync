// Regression tests for Plan 004: a remote row that carries a column unknown
// to the pulling device's schema must be applied (with the unknown column
// dropped), not thrown away wholesale. These drive the real pull/apply path
// (src/engine/relay.ts) end to end against a minimal in-memory stand-in for a
// relay's `/v1/events` HTTP API — no real network or relay process needed.
// Synthetic envelopes are crafted directly with the protocol's own
// `encryptPayload`/`deriveIdentity` so each test controls the exact HLC and
// row payload a "remote device" would have sent, including payloads an older
// local schema could never have produced itself (the whole point of the bug).

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createMnemonic,
  createHlc,
  deriveIdentity,
  encryptPayload,
  type LocalFirstIdentity,
  type SyncEnvelope,
  type SyncPayload,
} from "@simplysync/protocol";

import {
  createSync,
  id,
  NonEmptyString,
  type SyncEngine,
  type Transport,
} from "../src/index";
import { fakeRelay, memoryDriver, memoryStorage, settle, type FakeRelay } from "./support";

// Generate one ephemeral identity per test process so every simulated device
// shares the same owner without checking a usable recovery phrase into source.
const MNEMONIC = createMnemonic();

const RELAY_URL = "http://relay.test";

// The schema the *receiving* device (the one under test) runs. Deliberately
// narrower than what a newer app version might write. `details` deliberately
// has no SQLite default so omitted local values exercise NULL projection too.
// That gap is what the "unknown column" tests exploit.
const schema = {
  note: { id: id("Note"), title: NonEmptyString, details: NonEmptyString },
};

function makeDevice(fetchImpl: typeof fetch, name: string) {
  const db = new Database(":memory:");
  const engine = createSync({
    createSqliteDriver: () => memoryDriver(db).driver,
    secureStorage: memoryStorage(),
    fetch: fetchImpl,
  })(schema, {
    name,
    externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
    // Effectively disable the periodic poller so only explicit sync() calls
    // (and the one setTransports auto-triggers) touch the fake relay.
    syncIntervalMs: 3_600_000,
  });
  return { engine, db };
}

/** Attach the fake relay and wait for the connect-time sync it triggers. */
async function connect(engine: SyncEngine<typeof schema>): Promise<void> {
  const transports: Transport[] = [{ url: RELAY_URL }];
  engine.setTransports(transports);
  await settle(engine);
}

let cachedIdentity: LocalFirstIdentity | undefined;
async function getIdentity(): Promise<LocalFirstIdentity> {
  cachedIdentity ??= await deriveIdentity(MNEMONIC);
  return cachedIdentity;
}

/** Encrypt a synthetic payload (as if some other device had written and
 * pushed it) directly into the fake relay's event log. */
async function pushSynthetic(
  relay: FakeRelay,
  payload: SyncPayload<Record<string, unknown>, number>,
  deviceId = "device-remote",
  eventId = payload.hlc,
): Promise<void> {
  const identity = await getIdentity();
  const envelope = await encryptPayload(
    identity,
    { eventId, deviceId },
    payload,
  );
  relay.events.push(envelope);
}

function isSeen(db: Database, eventId: string): boolean {
  return (
    db.prepare(`select 1 from _sync_seen where event_id = ?`).get(eventId) !=
    null
  );
}

describe("relay pull/apply — Plan 004 (schema projection on remote apply)", () => {
  test("configured payload versions must be positive safe integers", () => {
    const deps = {
      createSqliteDriver: () => {
        throw new Error("must not open");
      },
      secureStorage: memoryStorage(),
    };
    expect(() =>
      createSync(deps)(schema, {
        name: "invalid-schema-version",
        schemaVersion: 0,
      })
    ).toThrow("positive safe integer");
    expect(() =>
      createSync(deps)(schema, {
        name: "invalid-schema-version",
        schemaVersion: Number.MAX_SAFE_INTEGER + 1,
      })
    ).toThrow("positive safe integer");
  });

  test("a remote row carrying a column unknown to the local schema is applied, not dropped", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "unknown-column");
    await engine.ready;

    const rowId = "row-1";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        title: "Written on a newer app version",
        // A column this (older) schema has never heard of. Pre-fix this made
        // the whole insert throw ("no column named futureColumn") — dropping
        // the row entirely and, since the event was still marked seen, for
        // good.
        futureColumn: "some value from the future",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db
      .prepare(`select id, title from note where id = ?`)
      .get(rowId) as { id: string; title: string } | null;
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Written on a newer app version");

    // Applied successfully, so it's correctly recorded seen (not lost).
    expect(isSeen(db, hlc)).toBe(true);

    const log = engine.getSyncLog(5);
    expect(log[0]?.applied).toBe(1);
    expect(log[0]?.kind).toBeUndefined(); // no failure surfaced
  });

  test("a merged remote row may carry SQLite NULLs for never-supplied typed columns", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "merged-null-column");
    await engine.ready;

    const rowId = "row-null";
    const firstHlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc: firstHlc,
      value: {
        title: "First title",
        createdAt: new Date().toISOString(),
        updatedAt: firstHlc,
        isDeleted: 0,
      },
    });
    await connect(engine);

    const secondHlc = createHlc("device-remote", Date.now() + 1, 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc: secondHlc,
      value: {
        title: "Updated title",
        details: null,
        createdAt: new Date().toISOString(),
        // Native ports treat the top-level HLC as canonical and may omit or
        // carry a stale system value inside the row payload.
        updatedAt: firstHlc,
        isDeleted: 0,
      },
    });
    await engine.sync();

    const row = db.prepare(`select title, details, updatedAt from note where id = ?`).get(rowId) as {
      title: string;
      details: string | null;
      updatedAt: string;
    };
    expect(row).toEqual({ title: "Updated title", details: null, updatedAt: secondHlc });
    expect(engine.getSyncLog(1)[0]?.applied).toBe(1);
  });

  test("re-pulling the same page (cursor rewound) is idempotent", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "idempotency");
    await engine.ready;

    const rowId = "row-2";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        title: "Once",
        futureColumn: "ignored",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);
    const before = db.prepare(`select * from note where id = ?`).get(rowId);
    expect(before).not.toBeNull();

    // Rewind the pull cursor and re-sync: the relay re-serves the same
    // envelope, but `_sync_seen` must dedupe it before it ever reaches
    // applyRemoteRow again.
    db.prepare(`update _sync_meta set value = '0' where key = ?`).run(
      `cursor:${RELAY_URL}`,
    );
    await engine.sync();

    const after = db.prepare(`select * from note where id = ?`).get(rowId);
    expect(after).toEqual(before);

    // The re-pulled page contributed 0 new applies (already seen).
    const log = engine.getSyncLog(5);
    expect(log[0]?.applied).toBe(0);
    expect(log[0]?.pulled).toBe(1);
  });

  test("a stale (older-HLC) remote edit that arrives after a newer one is skipped, not applied — and still marked seen", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "lww-lost");
    await engine.ready;

    const rowId = "row-3";
    const t0 = Date.now();
    const hlcOld = createHlc("device-remote", t0, 0);
    const hlcNew = createHlc("device-remote", t0 + 10_000, 0);

    // Arrival order: the newer edit first, then a straggler older edit for
    // the same row (out-of-order delivery, e.g. a slow/offline device).
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc: hlcNew,
      value: {
        title: "new",
        createdAt: new Date(t0 + 10_000).toISOString(),
        updatedAt: hlcNew,
        isDeleted: 0,
      },
    });
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc: hlcOld,
      value: {
        title: "old",
        createdAt: new Date(t0).toISOString(),
        updatedAt: hlcOld,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db.prepare(`select title from note where id = ?`).get(rowId) as {
      title: string;
    };
    expect(row.title).toBe("new"); // the stale edit did not win

    // Both events were pulled; only the newer one was actually applied. The
    // stale one is still marked seen (an intentional, terminal skip) so it
    // isn't retried forever.
    const log = engine.getSyncLog(5);
    expect(log[0]?.pulled).toBe(2);
    expect(log[0]?.applied).toBe(1);
    expect(isSeen(db, hlcNew)).toBe(true);
    expect(isSeen(db, hlcOld)).toBe(true);
  });

  test("a remote event whose HLC exactly equals the local row's is not applied", async () => {
    // The LWW tiebreak is `compareHlc(local, remote) >= 0` — equal keeps local.
    // An HLC embeds its writing device id, so a true tie can only be the SAME
    // event arriving again (a relay resend after the seen-set was pruned, or a
    // re-seed after a wipe). Re-applying it would be a pointless write; taking
    // the remote value would let a re-serialized payload silently overwrite the
    // row it came from.
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "lww-tie");
    await engine.ready;

    const rowId = "row-tie";
    const t0 = Date.now();
    const hlc = createHlc("device-remote", t0, 0);
    const value = (title: string) => ({
      title,
      details: "d",
      createdAt: new Date(t0).toISOString(),
      updatedAt: hlc,
      isDeleted: 0,
    });

    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: value("first"),
    });
    await connect(engine);
    expect(
      (db.prepare(`select title from note where id = ?`).get(rowId) as {
        title: string;
      }).title,
    ).toBe("first");

    // Same eventId, different body. Rewind the cursor so the pull re-serves it
    // and clear the seen row, so the tie reaches applyLwwRow rather than being
    // short-circuited by dedup.
    relay.events[0] = await (async () => {
      const identity = await getIdentity();
      return encryptPayload(
        identity,
        { eventId: hlc, deviceId: "device-remote" },
        {
          schemaVersion: 1,
          table: "note",
          op: "upsert" as const,
          rowId,
          hlc,
          value: value("second"),
        },
      );
    })();
    db.prepare(`delete from _sync_seen where event_id = ?`).run(hlc);
    db.prepare(`delete from _sync_meta where key like 'cursor:%'`).run();

    await engine.sync();
    await settle(engine);

    expect(
      (db.prepare(`select title from note where id = ?`).get(rowId) as {
        title: string;
      }).title,
    ).toBe("first"); // the tie did not overwrite
    expect(isSeen(db, hlc)).toBe(true);
  });

  test("a genuinely invalid value for a known column is reported as an apply failure, retained, and not retried on every sync", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "terminal-failure");
    await engine.ready;

    const rowId = "row-4";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        // `title` is a known column (NonEmptyString) but this value fails its
        // own validation — a genuine data problem, not a schema-version gap.
        // Projection can't rescue this; it must surface as an apply failure.
        title: "",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db.prepare(`select 1 from note where id = ?`).get(rowId);
    expect(row).toBeNull(); // never written

    expect(isSeen(db, hlc)).toBe(true); // the cursor must move past it

    const logBeforeIdleSync = engine.getSyncLog(5);
    expect(logBeforeIdleSync[0]?.kind).toBe("applyFailed");

    // Retained, not discarded: this is the owner's own authenticated data, and
    // a later build that widens the column can still apply it. It is held
    // opaque (no retry time), so normal syncs never reconsider it — only a
    // schema change does.
    const deferred = db
      .prepare(`select retry_after_ms from _sync_deferred where event_id = ?`)
      .get(hlc) as { retry_after_ms: number | null } | null;
    expect(deferred).not.toBeNull();
    expect(deferred?.retry_after_ms).toBeNull();

    // Re-syncing must NOT retry it or write a zero-activity success entry.
    // Idle polling stays out of the durable diagnostics log.
    await engine.sync();
    expect(engine.getSyncLog(5)).toEqual(logBeforeIdleSync);
  });

  test("malformed row ids and system columns are terminal apply failures", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "invalid-system-columns");
    await engine.ready;

    const badIdHlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId: "",
      hlc: badIdHlc,
      value: {
        title: "empty id",
        createdAt: new Date().toISOString(),
        updatedAt: badIdHlc,
        isDeleted: 0,
      },
    });
    const badFlagHlc = createHlc("device-remote", Date.now() + 1, 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId: "bad-flag",
      hlc: badFlagHlc,
      value: {
        title: "bad flag",
        createdAt: new Date().toISOString(),
        updatedAt: badFlagHlc,
        isDeleted: "false",
      },
    });

    await connect(engine);

    expect(db.prepare(`select 1 from note`).all()).toHaveLength(0);
    expect(isSeen(db, badIdHlc)).toBe(true);
    expect(isSeen(db, badFlagHlc)).toBe(true);
    expect(engine.getSyncLog(1)[0]?.kind).toBe("applyFailed");
  });

  test("normal apply (no schema gap) still works end to end", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "normal-apply");
    await engine.ready;

    const rowId = "row-5";
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId,
      hlc,
      value: {
        title: "Plain row",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);

    const row = db
      .prepare(`select id, title, isDeleted from note where id = ?`)
      .get(rowId) as { id: string; title: string; isDeleted: number };
    expect(row).toEqual({ id: rowId, title: "Plain row", isDeleted: 0 });
  });

  test("an unknown-table event is staged and replayed after schema upgrade", async () => {
    const relay = fakeRelay();
    const db = new Database(":memory:");
    const storage = memoryStorage();
    const makeWithSchema = <S extends Parameters<ReturnType<typeof createSync>>[0]>(
      nextSchema: S,
      name: string,
    ) =>
      createSync({
        createSqliteDriver: () => memoryDriver(db).driver,
        secureStorage: storage,
        fetch: relay.fetch,
      })(nextSchema, {
        name,
        externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
        syncIntervalMs: 3_600_000,
      });

    const oldEngine = makeWithSchema(schema, "unknown-table-upgrade");
    await oldEngine.ready;
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "task",
      op: "upsert",
      rowId: "task-1",
      hlc,
      value: {
        title: "Arrived before this table existed",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });
    oldEngine.setTransports([{ url: RELAY_URL }]);
    await settle(oldEngine as SyncEngine<typeof schema>);
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 1 });
    oldEngine.setTransports([]);

    const upgradedSchema = {
      ...schema,
      task: { id: id("Task"), title: NonEmptyString },
    };
    const upgraded = makeWithSchema(upgradedSchema, "unknown-table-upgrade");
    await upgraded.ready;
    expect(
      db.prepare(`select title from task where id = ?`).get("task-1"),
    ).toEqual({ title: "Arrived before this table existed" });
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 0 });
  });

  test("a future payload for a known table is retained until the app declares support", async () => {
    const relay = fakeRelay();
    const db = new Database(":memory:");
    const storage = memoryStorage();
    const makeAtVersion = (version: number) =>
      createSync({
        createSqliteDriver: () => memoryDriver(db).driver,
        secureStorage: storage,
        fetch: relay.fetch,
      })(schema, {
        name: "payload-version-upgrade",
        schemaVersion: version,
        externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
        syncIntervalMs: 3_600_000,
      });

    const oldEngine = makeAtVersion(1);
    await oldEngine.ready;
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 2,
      table: "note",
      op: "upsert",
      rowId: "future-schema-row",
      hlc,
      value: {
        title: "Only version 2 understands this meaning",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(oldEngine);
    expect(
      db.prepare(`select 1 from note where id = ?`).get("future-schema-row"),
    ).toBeNull();
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 1 });
    expect(isSeen(db, hlc)).toBe(true);
    oldEngine.setTransports([]);

    const upgraded = makeAtVersion(2);
    await upgraded.ready;
    expect(
      db.prepare(`select title from note where id = ?`).get("future-schema-row"),
    ).toEqual({ title: "Only version 2 understands this meaning" });
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 0 });
  });

  test("local events carry the configured payload schema version", async () => {
    const db = new Database(":memory:");
    const engine = createSync({
      createSqliteDriver: () => memoryDriver(db).driver,
      secureStorage: memoryStorage(),
    })(schema, {
      name: "payload-version-writer",
      schemaVersion: 2,
      externalAppOwner: { id: "", mnemonic: MNEMONIC, writeKey: "" },
    });
    await engine.ready;
    const result = await engine.insert("note", { title: "Versioned write" });
    expect(result.ok).toBe(true);
    const row = db
      .prepare(`select payload_json from _sync_outbox limit 1`)
      .get() as { payload_json: string };
    expect(JSON.parse(row.payload_json).schemaVersion).toBe(2);
  });

  test("an invalid payload schema version is terminal, not deferred forever", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "invalid-payload-version");
    await engine.ready;
    const hlc = createHlc("device-remote", Date.now(), 0);
    await pushSynthetic(relay, {
      schemaVersion: 0,
      table: "note",
      op: "upsert",
      rowId: "invalid-version-row",
      hlc,
      value: {
        title: "Invalid version",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);
    expect(
      db.prepare(`select 1 from note where id = ?`).get("invalid-version-row"),
    ).toBeNull();
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 0 });
    expect(isSeen(db, hlc)).toBe(true);
    expect(engine.getSyncLog(5)[0]?.kind).toBe("applyFailed");
  });

  test("an absurd future HLC is quarantined before last-write-wins apply", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "future-hlc-apply");
    await engine.ready;
    const hlc = createHlc("device-remote", Date.now() + 10 * 60_000, 0);
    await pushSynthetic(relay, {
      schemaVersion: 1,
      table: "note",
      op: "upsert",
      rowId: "future-row",
      hlc,
      value: {
        title: "must not win",
        createdAt: new Date().toISOString(),
        updatedAt: hlc,
        isDeleted: 0,
      },
    });

    await connect(engine);
    expect(db.prepare(`select 1 from note where id = ?`).get("future-row")).toBeNull();
    expect(isSeen(db, hlc)).toBe(true);
    expect(
      db.prepare(`select event_id, retry_after_ms from _sync_deferred`).get(),
    ).toEqual({
      event_id: hlc,
      retry_after_ms: expect.any(Number),
    });
    const retryAfter = db
      .prepare(`select retry_after_ms from _sync_deferred where event_id = ?`)
      .get(hlc) as { retry_after_ms: number };
    expect(retryAfter.retry_after_ms).toBeGreaterThan(Date.now());
    await engine.sync();
    expect(
      db.prepare(`select event_id from _sync_deferred where event_id = ?`).get(hlc),
    ).toEqual({ event_id: hlc });
    expect(engine.getSyncLog(5).some((entry) => entry.kind === "applyFailed")).toBe(false);
  });

  test("opaque rows are swept once at boot and left alone by normal syncs", async () => {
    // Stage a backlog bigger than one replay page, then boot a fresh engine
    // over the same database: the boot sweep must consider every opaque row
    // (not just the first page), retain the still-unknown ones, and normal
    // syncs afterwards must not rewrite them.
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "bounded-deferred-replay");
    await engine.ready;

    const insert = db.prepare(
      `insert into _sync_deferred (event_id, payload_json, retry_after_ms) values (?, ?, null)`,
    );
    const baseMillis = Date.now() - 60_000;
    for (let index = 0; index < 300; index++) {
      const eventId = createHlc("opaque-device", baseMillis + index, 0);
      insert.run(
        eventId,
        JSON.stringify({
          schemaVersion: 1,
          table: "notInstalledYet",
          op: "upsert",
          rowId: `opaque-${index}`,
          hlc: eventId,
          value: {},
        }),
      );
    }

    const rebooted = createSync({
      createSqliteDriver: () => memoryDriver(db).driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
    })(schema, { name: "bounded-deferred-replay", syncIntervalMs: 3_600_000 });
    await rebooted.ready;
    expect(db.prepare(`select count(*) as c from _sync_deferred`).get()).toEqual({ c: 300 });

    db.exec(`create table deferred_rewrites (count integer not null)`);
    db.exec(`insert into deferred_rewrites values (0)`);
    db.exec(`
      create trigger count_deferred_rewrites after insert on _sync_deferred
      begin update deferred_rewrites set count = count + 1; end
    `);
    await rebooted.sync();
    expect(db.prepare(`select count from deferred_rewrites`).get()).toEqual({ count: 0 });
  });

  test("a payload HLC that does not match its authenticated event id is rejected", async () => {
    const relay = fakeRelay();
    const { engine, db } = makeDevice(relay.fetch, "mismatched-hlc");
    await engine.ready;
    const eventId = createHlc("device-remote", Date.now(), 0);
    const payloadHlc = createHlc("device-remote", Date.now(), 1);
    await pushSynthetic(
      relay,
      {
        schemaVersion: 1,
        table: "note",
        op: "upsert",
        rowId: "mismatched-row",
        hlc: payloadHlc,
        value: {
          title: "must not apply",
          createdAt: new Date().toISOString(),
          updatedAt: payloadHlc,
          isDeleted: 0,
        },
      },
      "device-remote",
      eventId,
    );

    await connect(engine);
    expect(
      db.prepare(`select 1 from note where id = ?`).get("mismatched-row"),
    ).toBeNull();
    expect(isSeen(db, eventId)).toBe(true);
    expect(
      db.prepare(`select count(*) as c from _sync_deferred`).get(),
    ).toEqual({ c: 0 });
    expect(engine.getSyncLog(5)[0]?.kind).toBe("applyFailed");
  });
});
