// Edge cases at the engine's seams that no other suite reached. Each one was
// first reproduced as a failure against the engine as it stood; the assertion
// here is the behaviour that fix established. Grouped by the seam involved so a
// regression names the area, not just the test.
import { describe, expect, test } from "bun:test";
import {
  createHlc,
  createMnemonic,
  decryptEnvelope,
  decryptStringWithKey,
  deriveBackupKeyBytes,
  deriveIdentity,
  encryptPayload,
  encryptStringWithKey,
  type SyncEnvelope,
} from "@simplysync/protocol";

import { createSync, id, NonEmptyString } from "../src/index";
import { fakeRelay, memoryDriver, memoryStorage, settle } from "./support";

const schema = { note: { id: id("Note"), body: NonEmptyString } };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const okPush = () => json({ accepted: 1, duplicate: 0 });

// Row ids a relay holds, read the only way a relay's content can be read.
async function rowIdsOn(relay: { events: SyncEnvelope[] }, recoveryKey: string) {
  const identity = await deriveIdentity(recoveryKey);
  const ids = new Set<string>();
  for (const envelope of relay.events) {
    const payload = (await decryptEnvelope(identity, envelope)) as { rowId: string };
    ids.add(payload.rowId);
  }
  return [...ids].sort();
}

describe("owner switch during an in-flight sync", () => {
  test("a pull page fetched for the previous owner is dropped, not applied", async () => {
    // restoreAppOwner wipes the database and swaps the identity while a poll's
    // pull request is still awaiting the relay. Before the guard, that page was
    // decrypted (it was sealed for the OLD owner) and applied into the NEW
    // owner's empty database, and its cursor was recorded under the new owner —
    // so the new owner's first real pull skipped every event below it.
    let releasePull!: () => void;
    const pullHeld = new Promise<void>((resolve) => (releasePull = resolve));
    let pullStarted!: () => void;
    const firstPull = new Promise<void>((resolve) => (pullStarted = resolve));
    let served: SyncEnvelope[] = [];
    let pulls = 0;
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return okPush();
      if (!String(input).includes("/v1/events")) return json({ version: "1" });
      pulls += 1;
      if (pulls > 1) return json({ error: "Unknown owner" }, 404);
      pullStarted();
      await pullHeld;
      return json({ events: served, nextCursor: "7" });
    }) as typeof fetch;

    const mem = memoryDriver();
    const engine = createSync({
      createSqliteDriver: () => mem.driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
      reloadApp: () => {},
    })(schema, {
      name: "owner-switch",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    const previous = await deriveIdentity((await engine.appOwner)!.recoveryKey);
    const hlc = createHlc("peer", Date.now() - 1_000);
    served = [
      await encryptPayload(previous, { eventId: hlc, deviceId: "peer" }, {
        schemaVersion: 1,
        table: "note",
        op: "upsert",
        rowId: "leak",
        hlc,
        value: { id: "leak", body: "previous owner", createdAt: "x", updatedAt: hlc, isDeleted: 0 },
      }),
    ];

    const inFlight = engine.sync();
    await firstPull;
    await engine.restoreAppOwner(createMnemonic(), { force: true });
    releasePull();
    await inFlight;
    await settle(engine);

    expect(mem.db.query('select id from "note"').all()).toEqual([]);
    expect(
      mem.db
        .query('select value from "_sync_meta" where key = ?')
        .get("cursor:http://relay.test"),
    ).toBeNull();
    engine.setTransports([]);
  });
});

describe("snapshot portability", () => {
  test("an edit still pending in the exporter's outbox reaches the relay from the importing device", async () => {
    // The exporter pushed n1, went offline, wrote n2, and exported. Its outbox
    // is not part of the snapshot, but its `push:`/`backfill:` markers were —
    // so the importing device believed the relay already had everything and
    // never re-seeded. With the exporter retired (the point of carrying a
    // snapshot to a new main device), n2 existed on no relay.
    let offline = false;
    const relay = fakeRelay();
    const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (offline) throw new TypeError("fetch failed");
      return relay.fetch(input, init);
    }) as typeof fetch;
    const exporter = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: flaky,
      reloadApp: () => {},
    })(schema, {
      name: "exporter",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await exporter.ready;
    exporter.insert("note", { id: "n1", body: "pushed" });
    await exporter.sync();
    offline = true;
    exporter.insert("note", { id: "n2", body: "still in the outbox" });
    await exporter.sync().catch(() => undefined);
    expect(exporter.getPendingOutboxCount()).toBe(1);
    const file = await exporter.exportDatabase();
    const recoveryKey = (await exporter.appOwner)!.recoveryKey;
    exporter.setTransports([]);

    const importer = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
      reloadApp: () => {},
    })(schema, {
      name: "importer",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await importer.ready;
    await importer.importDatabase(file, { recoveryKey });
    await importer.sync();

    expect(await rowIdsOn(relay, recoveryKey)).toEqual(["n1", "n2"]);
    importer.setTransports([]);
  });

  test("a snapshot written with push bookkeeping still re-seeds on import", async () => {
    // Files exported before the filter existed carry `push:`/`backfill:` keys.
    // Import must ignore them rather than trust them.
    const relay = fakeRelay();
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
      reloadApp: () => {},
    })(schema, {
      name: "legacy-snapshot",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    engine.insert("note", { id: "n1", body: "a" });
    await engine.sync();
    const file = await engine.exportDatabase();
    engine.setTransports([]);

    const mem = memoryDriver();
    const target = createSync({
      createSqliteDriver: () => mem.driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
      reloadApp: () => {},
    })(schema, { name: "target", syncIntervalMs: 3_600_000 });
    await target.ready;
    // Hand-craft the legacy shape: decrypt, add the keys back, re-encrypt.
    const recoveryKey = (await engine.appOwner)!.recoveryKey;
    const keyBytes = await deriveBackupKeyBytes(recoveryKey);
    const snapshot = JSON.parse(await decryptStringWithKey(keyBytes, file)) as {
      meta: Record<string, string>;
    };
    snapshot.meta["push:http://relay.test"] = "zzz";
    snapshot.meta["backfill:http://relay.test"] = "1";
    const legacy = await encryptStringWithKey(keyBytes, JSON.stringify(snapshot), {
      ownerId: file.ownerId,
    });
    await target.importDatabase(legacy, { recoveryKey });

    const keys = mem.db
      .query('select key from "_sync_meta" where key glob ? or key glob ?')
      .all("push:*", "backfill:*");
    expect(keys).toEqual([]);
  });
});

describe("a relay removed and later re-added", () => {
  test("receives the events that were pruned while it was away", async () => {
    // Relays A and B. B is dropped; a write lands on A alone and the outbox
    // prunes it (every CONFIGURED relay acknowledged). Re-adding B used to
    // find its old push cursor, take that as "already seeded", and skip the
    // backfill — so B silently lacked the write, and a restore from B alone
    // would have lost it.
    const relayA = fakeRelay();
    const relayB = fakeRelay();
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("http://a.test")
        ? relayA.fetch(input, init)
        : relayB.fetch(input, init)) as typeof fetch;
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "readd",
      transports: [{ url: "http://a.test" }, { url: "http://b.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    const recoveryKey = (await engine.appOwner)!.recoveryKey;
    engine.insert("note", { id: "r1", body: "both" });
    await engine.sync();

    engine.setTransports([{ url: "http://a.test" }]);
    await settle(engine);
    engine.insert("note", { id: "r2", body: "written while B was away" });
    await engine.sync();
    expect(engine.getPendingOutboxCount()).toBe(0);
    expect(await rowIdsOn(relayB, recoveryKey)).toEqual(["r1"]);

    engine.setTransports([{ url: "http://a.test" }, { url: "http://b.test" }]);
    await settle(engine);
    await engine.sync();
    expect(await rowIdsOn(relayB, recoveryKey)).toEqual(["r1", "r2"]);
    engine.setTransports([]);
  });

  test("a single relay toggled off and on is not re-seeded", async () => {
    // With no other relay to acknowledge for it, nothing is pruned while the
    // relay is away, so its cursor stays trustworthy and re-adding it pushes
    // only what queued in the meantime.
    const relay = fakeRelay();
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
    })(schema, {
      name: "toggle",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    engine.insert("note", { id: "r1", body: "before" });
    await engine.sync();
    engine.setTransports([]);
    engine.insert("note", { id: "r2", body: "while paused" });
    engine.setTransports([{ url: "http://relay.test" }]);
    await settle(engine);
    await engine.sync();
    // r1 once, r2 once — no second copy of r1.
    expect(relay.pushedEventIds().length).toBe(2);
    engine.setTransports([]);
  });
});

describe("new-relay backfill", () => {
  test("skips a row whose updatedAt is not an HLC instead of poisoning the push", async () => {
    // The row's HLC becomes the event id, and the reference relays refuse a
    // whole batch over one malformed id — so one row written outside the
    // engine (raw SQL, a legacy import) would have stalled every later write
    // to a new relay behind a permanent 400.
    const relay = fakeRelay();
    const mem = memoryDriver();
    const engine = createSync({
      createSqliteDriver: () => mem.driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
    })(schema, { name: "backfill-guard", syncIntervalMs: 3_600_000 });
    await engine.ready;
    engine.insert("note", { id: "good", body: "fine" });
    await engine.sync();
    mem.db
      .query('insert into "note" (id, body, createdAt, updatedAt, isDeleted) values (?, ?, ?, ?, 0)')
      .run("bad", "legacy", "2020-01-01", "2020-01-01T00:00:00Z");

    engine.setTransports([{ url: "http://relay.test" }]);
    await settle(engine);
    await engine.sync();
    expect(relay.pushedEventIds()).not.toContain("2020-01-01T00:00:00Z");
    expect(await rowIdsOn(relay, (await engine.appOwner)!.recoveryKey)).toEqual(["good"]);
    engine.setTransports([]);
  });
});

describe("caller-supplied updatedAt", () => {
  test("must be newer than the row's current version", async () => {
    // An older stamp would regress the local row while every peer kept its
    // newer copy under last-writer-wins; the next ordinary edit would then
    // re-stamp the regressed values and replicate them. An equal stamp would
    // be dropped by the HLC-keyed outbox while its row still committed.
    const mem = memoryDriver();
    const engine = createSync({
      createSqliteDriver: () => mem.driver,
      secureStorage: memoryStorage(),
    })(schema, { name: "explicit-hlc" });
    await engine.ready;
    engine.insert("note", { id: "n", body: "current" });
    const current = (
      mem.db.query('select updatedAt from "note" where id = ?').get("n") as { updatedAt: string }
    ).updatedAt;

    const older = engine.upsert("note", {
      id: "n",
      body: "stale import",
      updatedAt: createHlc("import", Date.now() - 60_000),
    });
    expect(older.ok).toBe(false);
    const equal = engine.upsert("note", { id: "n", body: "same stamp", updatedAt: current });
    expect(equal.ok).toBe(false);
    // Insert overwrites an existing row too, so it gets the same guard.
    const insert = engine.insert("note", {
      id: "n",
      body: "stale insert",
      updatedAt: createHlc("import", Date.now() - 60_000),
    });
    expect(insert.ok).toBe(false);
    expect(
      (mem.db.query('select body from "note" where id = ?').get("n") as { body: string }).body,
    ).toBe("current");

    const newer = engine.upsert("note", {
      id: "n",
      body: "moved forward",
      updatedAt: createHlc("import", Date.now() + 1_000),
    });
    expect(newer.ok).toBe(true);
  });

  test("may not reuse an HLC already queued for another row", async () => {
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
    })(schema, { name: "explicit-dup" });
    await engine.ready;
    const stamp = createHlc("import", Date.now() - 1_000);
    expect(engine.insert("note", { id: "a", body: "first", updatedAt: stamp }).ok).toBe(true);
    const second = engine.insert("note", { id: "b", body: "second", updatedAt: stamp });
    expect(second.ok).toBe(false);
    expect(engine.getPendingOutboxCount()).toBe(1);

    const inBatch = engine.batch([
      { table: "note", values: { id: "c", body: "c", updatedAt: createHlc("i", Date.now() - 500) } },
      { table: "note", values: { id: "d", body: "d", updatedAt: createHlc("i", Date.now() - 500) } },
    ]);
    expect(inBatch.ok).toBe(false);
    expect(engine.getPendingOutboxCount()).toBe(1);
  });
});

describe("relay URL and response shape", () => {
  test("a trailing slash is normalized away like the native ports do", async () => {
    const urls: string[] = [];
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      urls.push(String(input));
      if (init?.method === "POST") return okPush();
      return json({ events: [], nextCursor: "" });
    }) as typeof fetch;
    const mem = memoryDriver();
    const engine = createSync({
      createSqliteDriver: () => mem.driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "slash",
      transports: [{ url: "http://relay.test/" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    engine.insert("note", { body: "x" });
    await engine.sync();
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => u.startsWith("http://relay.test/v1/"))).toBe(true);
    // The meta key is the normalized URL, so the same relay spelled two ways
    // is one relay.
    expect(
      mem.db.query('select key from "_sync_meta" where key glob ?').all("backfill:*"),
    ).toEqual([{ key: "backfill:http://relay.test" }]);
    engine.setTransports([]);
  });

  test("a 200 that is not a pull page is the relay's fault, not 'unreachable'", async () => {
    let body: unknown = { events: null, nextCursor: "1" };
    const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === "POST" ? okPush() : json(body)) as typeof fetch;
    const mem = memoryDriver();
    const engine = createSync({
      createSqliteDriver: () => mem.driver,
      secureStorage: memoryStorage(),
      fetch: fetchStub,
    })(schema, {
      name: "malformed",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    await engine.sync();
    let state = engine.getSyncState();
    expect(state.type).toBe("SyncStateIsNotSynced");
    expect(state.type === "SyncStateIsNotSynced" && state.kind).toBe("serverError");

    // A missing cursor used to reach the metadata table as NULL and fail its
    // NOT NULL constraint after the page had already been applied.
    body = { events: [] };
    await engine.sync();
    state = engine.getSyncState();
    expect(state.type === "SyncStateIsNotSynced" && state.kind).toBe("serverError");
    expect(
      mem.db.query('select key from "_sync_meta" where key glob ?').all("cursor:*"),
    ).toEqual([]);
    engine.setTransports([]);
  });
});

describe("sync loop resilience", () => {
  test("a fault outside the per-relay guard still ends the 'syncing' state", async () => {
    // Per-relay failures are caught and classified; a throw from the deferred
    // replay or the prunes is not. Observers had been told a sync began and,
    // until the next successful pass, never heard that it ended.
    const mem = memoryDriver();
    let explode = false;
    const driver = {
      ...mem.driver,
      select<R>(sql: string, params?: readonly unknown[]): R[] {
        if (explode && sql.includes("_sync_deferred")) throw new Error("disk on fire");
        return mem.driver.select<R>(sql, params);
      },
    };
    const engine = createSync({
      createSqliteDriver: () => driver,
      secureStorage: memoryStorage(),
      fetch: (async () => json({ events: [], nextCursor: "" })) as typeof fetch,
    })(schema, {
      name: "fault",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 3_600_000,
    });
    await engine.ready;
    explode = true;
    await expect(engine.sync()).rejects.toThrow("disk on fire");
    const state = engine.getSyncState();
    expect(state.type).toBe("SyncStateIsNotSynced");
    expect(state.type === "SyncStateIsNotSynced" && state.error).toBe("disk on fire");

    explode = false;
    await engine.sync();
    expect(engine.getSyncState().type).toBe("SyncStateIsSynced");
    engine.setTransports([]);
  });

  test("autoSync: false schedules nothing; engine.sync() still runs a full pass", async () => {
    const relay = fakeRelay();
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: relay.fetch,
    })(schema, {
      name: "manual",
      transports: [{ url: "http://relay.test" }],
      syncIntervalMs: 5,
      autoSync: false,
    });
    await engine.ready;
    engine.insert("note", { body: "x" });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(relay.pushCount()).toBe(0);
    expect(engine.getSyncState().type).toBe("SyncStateInitial");
    await engine.sync();
    expect(relay.pushCount()).toBe(1);
    expect(engine.getSyncState().type).toBe("SyncStateIsSynced");
    engine.setTransports([]);
  });
});
