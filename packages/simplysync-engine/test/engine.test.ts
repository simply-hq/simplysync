import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createHlc, compareHlc, createMnemonic } from "@simplysync/protocol";

import {
  createSync,
  FiniteNumber,
  id,
  kysely,
  NonEmptyString,
  SqliteBoolean,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createClock, createStore, type Store } from "../src/engine/store";
import { SYNC_LOG_CAP } from "../src/engine/constants";

function wrapDriver(db: Database): SqliteDriver {
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

const AccountId = id("Account");
const LedgerId = id("Ledger");

const schema = {
  account: { id: AccountId, name: NonEmptyString },
  ledger: { id: LedgerId, accountId: AccountId, amount: FiniteNumber },
};

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

function makeEngine() {
  return createSync({
    createSqliteDriver: () => makeDriver(),
    secureStorage: memoryStorage(),
  })(schema, { name: "test-db" });
}

describe("hlc clock", () => {
  function makeClock() {
    const state = createEngineState({ name: "clock-test" });
    state.deviceId = "devA";
    const meta = new Map<string, string>();
    const store = {
      setMeta: (k: string, v: string) => {
        meta.set(k, v);
      },
      getMeta: (k: string) => meta.get(k) ?? null,
    } as unknown as Store;
    return { clock: createClock(state, store), state, meta };
  }

  test("absorbs an observed future HLC so the next local HLC sorts above it", () => {
    const { clock, meta } = makeClock();
    // A remote edit stamped a minute in the future (a device with a fast clock).
    const future = createHlc("devB", Date.now() + 60_000, 3);
    clock.observeHlc(future);

    const local = clock.nextHlc();
    expect(compareHlc(future, local)).toBeLessThan(0); // local sorts strictly after
    expect(Number(meta.get("hlc:time"))).toBeGreaterThan(Date.now()); // persisted
  });

  test("breaks a same-millis tie by lifting the counter", () => {
    const { clock } = makeClock();
    const t = Date.now() + 60_000;
    clock.observeHlc(createHlc("devB", t, 9));
    const local = clock.nextHlc();
    expect(compareHlc(createHlc("devB", t, 9), local)).toBeLessThan(0);
  });

  test("ignores a malformed HLC rather than poisoning the clock", () => {
    const { clock, state } = makeClock();
    clock.observeHlc("not-an-hlc");
    clock.observeHlc("");
    expect(state.hlcTime).toBe(0); // untouched
    const local = clock.nextHlc();
    expect(local.split("-")[0]).toHaveLength(10); // still a well-formed HLC
    expect(state.hlcTime).toBeGreaterThan(0); // clock recovered normally
  });
});

describe("engine", () => {
  test("compiles a Kysely query to SQL", () => {
    const engine = makeEngine();
    const query = engine.createQuery((db) =>
      db
        .selectFrom("account")
        .select(["id", "name"])
        .where("isDeleted", "is not", 1),
    );
    expect(query.sql).toContain('"account"');
    expect(query.sql.toLowerCase()).toContain("select");
  });

  test("insert + reactive query round-trip with a join", async () => {
    const engine = makeEngine();
    await engine.ready;

    const account = engine.insert("account", { name: "Checking" });
    expect(account.ok).toBe(true);
    if (!account.ok) return;
    const accountId = account.value.id;

    engine.insert("ledger", { accountId, amount: -450 } as never);
    engine.insert("ledger", { accountId, amount: 1000 } as never);

    const accountsWithTotal = engine.createQuery((db) =>
      db
        .selectFrom("account")
        .leftJoin(
          db
            .selectFrom("ledger")
            .select(["accountId", db.fn.sum("amount").as("total")])
            .where("isDeleted", "is not", 1)
            .groupBy("accountId")
            .as("t"),
          "t.accountId",
          "account.id",
        )
        .select(({ ref }) => [
          "account.id",
          "account.name",
          kysely.sql<number>`coalesce(${ref("t.total")}, 0)`.as("balance"),
        ])
        .where("account.isDeleted", "is not", 1),
    );

    const rows = await engine.loadQuery(accountsWithTotal);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Checking");
    expect(Number(rows[0].balance)).toBe(550);
  });

  test("subscriptions fire on mutation", async () => {
    const engine = makeEngine();
    await engine.ready;

    const query = engine.createQuery((db) =>
      db.selectFrom("account").select(["id", "name"]).where("isDeleted", "is not", 1),
    );
    // prime the cache
    void engine.getQueryRows(query);

    let notified = 0;
    const unsubscribe = engine.subscribeQuery(query)(() => {
      notified += 1;
    });

    engine.insert("account", { name: "Savings" });
    expect(notified).toBeGreaterThan(0);
    expect(engine.getQueryRows(query)).toHaveLength(1);

    unsubscribe();
  });

  test("soft delete hides rows from isDeleted queries", async () => {
    const engine = makeEngine();
    await engine.ready;

    const created = engine.insert("account", { name: "Temp" });
    if (!created.ok) throw new Error("insert failed");

    engine.update("account", { id: created.value.id, isDeleted: 1 as never });

    const live = engine.createQuery((db) =>
      db.selectFrom("account").select(["id"]).where("isDeleted", "is not", 1),
    );
    expect(await engine.loadQuery(live)).toHaveLength(0);
  });

  test("owner mnemonic is generated and stable", async () => {
    const engine = makeEngine();
    const owner = await engine.appOwner;
    expect(owner).not.toBeNull();
    expect(owner?.mnemonic.split(" ").length).toBe(24);
    expect(owner?.id).toBeTruthy();
  });

  // Regression: a legacy schema allowed NULL where ours requires a
  // SqliteBoolean. importLegacy must coerce NULL -> false so those rows aren't
  // silently dropped (real bug: accounts with NULL excludeFromReports vanished).
  test("importLegacy keeps rows whose required boolean is NULL", async () => {
    const legacy = new Database(":memory:");
    legacy.run(
      `create table account (id text, name text, "excludeFromReports" integer)`,
    );
    legacy.run(`insert into account values ('a1', 'Has bool', 0)`);
    legacy.run(`insert into account values ('a2', 'Null bool', NULL)`);

    const main = new Database(":memory:");
    const wrap = (db: Database): SqliteDriver => ({
      exec(sql, params) {
        db.prepare(sql).run(...((params ?? []) as never[]));
      },
      select(sql, params) {
        return db.prepare(sql).all(...((params ?? []) as never[])) as never;
      },
      transaction(fn) {
        return db.transaction(fn)();
      },
    });

    const engine = createSync({
      createSqliteDriver: (name: string) =>
        name === "legacy" ? wrap(legacy) : wrap(main),
      secureStorage: memoryStorage(),
    })(
      {
        account: {
          id: AccountId,
          name: NonEmptyString,
          excludeFromReports: SqliteBoolean,
        },
      },
      { name: "main" },
    );
    await engine.ready;

    const result = await engine.importLegacy("legacy");
    expect(result.imported).toBe(2); // both rows, not just the non-NULL one

    const rows = await engine.loadQuery(
      engine.createQuery((db) =>
        db
          .selectFrom("account")
          .select(["id", "name", "excludeFromReports"])
          .where("isDeleted", "is not", 1),
      ),
    );
    expect(rows).toHaveLength(2);
    const nullBool = rows.find((r) => r.id === "a2");
    expect(nullBool?.excludeFromReports).toBe(0); // coerced to false, not dropped
  });

  // The HLC must stay monotonic even if the wall clock moves backwards across a
  // restart (else a new edit sorts below an old one and LWW drops it). Persisted
  // hlc:time is seeded on boot, so the second event still sorts after the first.
  test("HLC stays monotonic across a backward-clock restart", async () => {
    const realNow = Date.now;
    const db = new Database(":memory:");
    const store = memoryStorage();
    const make = () =>
      createSync({
        createSqliteDriver: () => wrapDriver(db),
        secureStorage: store,
      })({ account: { id: AccountId, name: NonEmptyString } }, { name: "t" });

    try {
      Date.now = () => 2_000_000_000; // "first session" clock
      const e1 = make();
      await e1.ready;
      e1.insert("account", { name: "First" });

      Date.now = () => 1_000_000_000; // restart with clock moved BACK 1s-worth
      const e2 = make();
      await e2.ready;
      e2.insert("account", { name: "Second" });

      // updatedAt is the HLC, written synchronously. Monotonic => Second's HLC
      // sorts after First's despite the clock going backwards.
      const rows = (await e2.loadQuery(
        e2.createQuery((db) =>
          db.selectFrom("account").select(["name", "updatedAt"]),
        ),
      )) as { name: string; updatedAt: string }[];
      const first = rows.find((r) => r.name === "First");
      const second = rows.find((r) => r.name === "Second");
      expect(first && second).toBeTruthy();
      expect(second!.updatedAt > first!.updatedAt).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });

  // restoreAppOwner must NOT wipe local data when it can't confirm the owner has
  // a backup (wrong phrase / relay unreachable / no relay) — else a typo wipes
  // everything with no recovery.
  test("restoreAppOwner refuses to wipe without a verified backup", async () => {
    const engine = makeEngine(); // no transports => can't verify
    await engine.ready;
    engine.insert("account", { name: "Keep me" });

    const validMnemonic = createMnemonic();
    await expect(
      engine.restoreAppOwner(validMnemonic),
    ).rejects.toThrow(/No backup found/);

    const rows = await engine.loadQuery(
      engine.createQuery((db) =>
        db.selectFrom("account").select(["id"]).where("isDeleted", "is not", 1),
      ),
    );
    expect(rows).toHaveLength(1); // data preserved
  });

  // "Erase all data" (resetAppOwner) wipes _sync_meta — which also clears the
  // legacyImported flag — so the next boot's one-time legacy import would
  // resurrect the erased data. resetAppOwner must mark the import done.
  test("resetAppOwner keeps data erased (no legacy re-import)", async () => {
    const legacy = new Database(":memory:");
    legacy.run(`create table account (id text, name text)`);
    legacy.run(`insert into account values ('a1', 'Old')`);

    const main = new Database(":memory:");
    const engine = createSync({
      createSqliteDriver: (name: string) =>
        name === "legacy" ? wrapDriver(legacy) : wrapDriver(main),
      secureStorage: memoryStorage(),
    })({ account: { id: AccountId, name: NonEmptyString } }, { name: "main" });
    await engine.ready;

    expect((await engine.importLegacy("legacy")).imported).toBe(1);
    await engine.resetAppOwner(); // erase (reloadApp is a no-op in tests)

    // The import must NOT run again and bring the old data back.
    expect((await engine.importLegacy("legacy")).imported).toBe(0);
    const rows = await engine.loadQuery(
      engine.createQuery((db) =>
        db.selectFrom("account").select(["id"]).where("isDeleted", "is not", 1),
      ),
    );
    expect(rows).toHaveLength(0); // stays erased
  });
});

describe("sync diagnostics log", () => {
  function makeStore() {
    const state = createEngineState({ name: "log-test" });
    state.driver = makeDriver();
    const store = createStore(state, schema, { name: "log-test" });
    store.ensureSchema();
    return { state, store };
  }

  test("records ok/fail entries most-recent-first with structured kind", () => {
    const { store } = makeStore();
    store.appendSyncLog({
      relay: "https://a",
      phase: "sync",
      result: "ok",
      pushed: 2,
      pulled: 3,
      applied: 1,
    });
    store.appendSyncLog({
      relay: "https://b",
      phase: "sync",
      result: "fail",
      kind: "authRejected",
      message: "push failed: 401",
    });

    const log = store.recentSyncLog(10);
    expect(log).toHaveLength(2);
    expect(log[0]?.relay).toBe("https://b"); // newest first
    expect(log[0]?.result).toBe("fail");
    expect(log[0]?.kind).toBe("authRejected");
    expect(log[1]?.pushed).toBe(2);
    expect(log[1]?.kind).toBeUndefined(); // ok entries carry no kind
  });

  test("is a bounded ring buffer (drops oldest past the cap)", () => {
    const { store } = makeStore();
    const total = SYNC_LOG_CAP + 5;
    for (let i = 0; i < total; i++) {
      store.appendSyncLog({ relay: `https://r${i}`, phase: "sync", result: "ok" });
    }
    const log = store.recentSyncLog(total);
    expect(log).toHaveLength(SYNC_LOG_CAP);
    expect(log[0]?.relay).toBe(`https://r${total - 1}`); // newest survives
  });

  test("pendingOutboxCount counts only unpushed rows", () => {
    const { state, store } = makeStore();
    state.driver?.exec(
      `insert into "_sync_outbox" (event_id, envelope_json, pushed_at) values (?, ?, ?)`,
      ["e1", "{}", null],
    );
    state.driver?.exec(
      `insert into "_sync_outbox" (event_id, envelope_json, pushed_at) values (?, ?, ?)`,
      ["e2", "{}", new Date().toISOString()],
    );
    expect(store.pendingOutboxCount()).toBe(1);
  });
});
