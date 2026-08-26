import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createHlc,
  compareHlc,
  createMnemonic,
  createRecoveryKey,
  deriveIdentity,
} from "@simplysync/protocol";

import {
  createSync,
  FiniteNumber,
  id,
  kysely,
  NonEmptyString,
  SqliteBoolean,
  type SqliteDriver,
} from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createClock, createStore } from "../src/engine/store";
import { SYNC_LOG_CAP } from "../src/engine/constants";
import { memoryDriver, memoryStorage } from "./support";

const AccountId = id("Account");
const LedgerId = id("Ledger");

const schema = {
  account: { id: AccountId, name: NonEmptyString },
  ledger: { id: LedgerId, accountId: AccountId, amount: FiniteNumber },
};

function makeEngine() {
  return createSync({
    createSqliteDriver: () => memoryDriver().driver,
    secureStorage: memoryStorage(),
  })(schema, { name: "test-db" });
}

describe("hlc clock", () => {
  function makeClock() {
    const state = createEngineState({ name: "clock-test" });
    state.deviceId = "devA";
    // The clock only needs somewhere to keep its high-water mark, so this is
    // the whole dependency — no `as unknown as Store` cast over 30-odd members
    // it never touches.
    let mark = { time: 0, counter: 0 };
    const store = {
      clockHighWaterMark: () => mark,
      setClockHighWaterMark: (time: number, counter: number) => {
        mark = { time, counter };
      },
    };
    return { clock: createClock(state, store), state, mark: () => mark };
  }

  test("absorbs an observed future HLC so the next local HLC sorts above it", () => {
    const { clock, mark } = makeClock();
    // A remote edit stamped a minute in the future (a device with a fast clock).
    const future = createHlc("devB", Date.now() + 60_000, 3);
    clock.observeHlc(future);

    const local = clock.nextHlc();
    expect(compareHlc(future, local)).toBeLessThan(0); // local sorts strictly after
    expect(mark().time).toBeGreaterThan(Date.now()); // persisted
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

  test("an import can preserve a valid historical updatedAt HLC", async () => {
    const engine = makeEngine();
    await engine.ready;
    const importedHlc = createHlc("legacy-row", Date.parse("2024-02-01T00:00:00Z"), 0);

    const result = engine.upsert("account", {
      id: "account-imported",
      name: "Imported",
      updatedAt: importedHlc,
    });
    expect(result.ok).toBe(true);

    const rows = await engine.loadQuery(
      engine.createQuery(
        (db) => db.selectFrom("account").select(["id", "updatedAt"]),
        { includeDeleted: true },
      ),
    );
    expect(rows[0]?.updatedAt).toBe(importedHlc);
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
    expect(owner?.mnemonic?.split(" ").length).toBe(24);
    expect(owner?.recoveryKey).toBe(owner?.mnemonic);
    expect(owner?.id).toBeTruthy();
  });

  test("boots an existing native sf1_ recovery key without replacing it", async () => {
    const recoveryKey = await createRecoveryKey();
    const name = "native-key-boot";
    const storage = memoryStorage({
      [`${name}:mnemonic`]: `  ${recoveryKey}  `,
    });
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: storage,
    })(schema, { name });

    const owner = await engine.appOwner;
    const expected = await deriveIdentity(recoveryKey);
    expect(owner?.recoveryKey).toBe(recoveryKey);
    expect(owner?.mnemonic).toBeUndefined();
    expect(owner?.id).toBe(expected.ownerId);
    // Boot also heals whitespace in the persisted legacy-named storage slot.
    expect(await storage.getItem(`${name}:mnemonic`)).toBe(recoveryKey);
  });

  test("boots a phrase stored in non-canonical spelling and rewrites it once", async () => {
    // Phrases are typed and pasted by hand, so a stored value can carry case
    // and spacing that the protocol normalizes away. Leaving it means every
    // later boot re-normalizes a value that never settles, and any code that
    // compares the stored string to a derived one disagrees with itself.
    const phrase = createMnemonic();
    const name = "phrase-normalizing-boot";
    const messy = `  ${phrase.toUpperCase().replace(/ /gu, "   ")}  `;
    const storage = memoryStorage({ [`${name}:mnemonic`]: messy });
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: storage,
    })(schema, { name });

    const owner = await engine.appOwner;
    const expected = await deriveIdentity(phrase);
    expect(owner?.id).toBe(expected.ownerId); // same owner, despite the spelling
    expect(owner?.recoveryKey).toBe(phrase);
    expect(await storage.getItem(`${name}:mnemonic`)).toBe(phrase);
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
        createSqliteDriver: () => memoryDriver(db).driver,
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
        e2.createQuery(
          (db) => db.selectFrom("account").select(["name", "updatedAt"]),
          { includeDeleted: true },
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

    const validCredentials = [createMnemonic(), await createRecoveryKey()];
    for (const credential of validCredentials) {
      await expect(engine.restoreAppOwner(credential)).rejects.toThrow(
        /No sync relay is configured/,
      );
    }

    const rows = await engine.loadQuery(
      engine.createQuery((db) =>
        db.selectFrom("account").select(["id"]).where("isDeleted", "is not", 1),
      ),
    );
    expect(rows).toHaveLength(1); // data preserved
  });

  test("restoreAppOwner distinguishes an empty backup from an unavailable relay", async () => {
    const emptyRelayFetch = (async () =>
      new Response(JSON.stringify({ events: [], nextCursor: "" }), {
        status: 200,
      })) as typeof fetch;
    const emptyRelayEngine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: emptyRelayFetch,
    })(schema, {
      name: "restore-empty-relay",
      transports: [{ url: "https://empty-relay.test" }],
    });
    await emptyRelayEngine.ready;
    emptyRelayEngine.insert("account", { name: "Keep empty" });

    await expect(
      emptyRelayEngine.restoreAppOwner(createMnemonic()),
    ).rejects.toThrow(/No backup found for this recovery key or phrase/);

    const unavailableFetch = (async () => {
      throw new TypeError("Network unavailable");
    }) as typeof fetch;
    const unavailableEngine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: unavailableFetch,
    })(schema, {
      name: "restore-unavailable-relay",
      transports: [{ url: "https://offline-relay.test" }],
    });
    await unavailableEngine.ready;
    unavailableEngine.insert("account", { name: "Keep offline" });

    await expect(
      unavailableEngine.restoreAppOwner(createMnemonic()),
    ).rejects.toThrow(/sync service could not be reached/);

    const rows = await unavailableEngine.loadQuery(
      unavailableEngine.createQuery((db) =>
        db.selectFrom("account").select(["id"]).where("isDeleted", "is not", 1),
      ),
    );
    expect(rows).toHaveLength(1);
  });

  test("restoreAppOwner safely verifies and adopts a native sf1_ recovery key", async () => {
    const recoveryKey = await createRecoveryKey();
    const restoredIdentity = await deriveIdentity(recoveryKey);
    let verified = false;
    const relayFetch = (async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/v1/events") {
        const isRestorePreflight = url.searchParams.get("limit") === "1";
        if (
          isRestorePreflight &&
          url.searchParams.get("ownerId") === restoredIdentity.ownerId
        ) {
          verified = true;
          expect(new Headers(init?.headers).get("Authorization")).toBe(
            `Bearer ${restoredIdentity.relayAuth}`,
          );
          // Preflight only checks that at least one retained event exists.
          return new Response(JSON.stringify({ events: [{}], nextCursor: "1" }), {
            status: 200,
          });
        }
        return new Response(JSON.stringify({ events: [], nextCursor: "" }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const engine = createSync({
      createSqliteDriver: () => memoryDriver().driver,
      secureStorage: memoryStorage(),
      fetch: relayFetch,
      reloadApp: () => {},
    })(schema, {
      name: "restore-native-key",
      transports: [{ url: "https://relay.test" }],
      syncIntervalMs: 600_000,
    });
    await engine.ready;
    const ownerBefore = await engine.appOwner;
    engine.insert("account", { name: "Replace me" });

    await engine.restoreAppOwner(`  ${recoveryKey}  `);

    const ownerAfter = await engine.appOwner;
    expect(verified).toBe(true);
    expect(ownerAfter?.id).toBe(restoredIdentity.ownerId);
    expect(ownerAfter?.id).not.toBe(ownerBefore?.id);
    expect(ownerAfter?.recoveryKey).toBe(recoveryKey);
    expect(ownerAfter?.mnemonic).toBeUndefined();
    const rows = await engine.loadQuery(
      engine.createQuery((db) => db.selectFrom("account").select(["id"]), {
        includeDeleted: true,
      }),
    );
    expect(rows).toHaveLength(0);
    engine.setTransports([]);
  });

});

describe("sync diagnostics log", () => {
  function makeStore() {
    const state = createEngineState({ name: "log-test" });
    state.driver = memoryDriver().driver;
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

describe("mutation modes", () => {
  test("update refuses a row that is not present locally", async () => {
    // update has nothing to merge onto. Inventing the row would produce a
    // half-populated record that then replicates as if it were a real edit;
    // delete is the only mode allowed to write a row it has never seen.
    const engine = makeEngine();
    await engine.ready;

    const missing = engine.update("account", { id: "nope", name: "Ghost" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toMatch(/not found/i);

    const created = engine.insert("account", { name: "Real" });
    if (!created.ok) throw new Error("insert failed");
    expect(engine.update("account", { id: created.value.id, name: "Renamed" }).ok)
      .toBe(true);
  });

  test("a write naming a table the schema does not declare never reaches SQL", async () => {
    // Table names are interpolated into the statement, so an unknown one has
    // to be refused at the boundary rather than reaching the driver — and
    // every mode has to refuse it, not just the one a caller happened to test.
    const engine = makeEngine();
    await engine.ready;

    for (const attempt of [
      () => engine.insert("nope" as never, { name: "x" } as never),
      () => engine.upsert("nope" as never, { id: "a", name: "x" } as never),
      () => engine.update("nope" as never, { id: "a", name: "x" } as never),
    ]) {
      const result = attempt();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.message).toMatch(/unknown table/i);
    }

    const batched = engine.batch([
      { table: "account", values: { name: "fine" } },
      { table: "nope" as never, values: { name: "x" } as never },
    ]);
    expect(batched.ok).toBe(false);
  });

  test("insert against an existing id overwrites the row, including createdAt", async () => {
    // insert deliberately does not read the existing row, so there is nothing
    // to merge onto and the stored createdAt is replaced rather than kept.
    // Callers that may be re-writing a known id want upsert, which does merge.
    const engine = makeEngine();
    await engine.ready;

    const read = async () => {
      const q = engine.createQuery((db) =>
        db
          .selectFrom("account")
          .select(["createdAt", "name"])
          .where("id", "=", "acct-1")
          .where("isDeleted", "=", 0),
      );
      const rows = await engine.loadQuery(q);
      return rows[0] as { createdAt: string; name: string };
    };

    const FIRST = "2020-01-01T00:00:00.000Z";
    const SECOND = "2021-01-01T00:00:00.000Z";
    expect(
      engine.insert("account", { id: "acct-1", name: "First", createdAt: FIRST }).ok,
    ).toBe(true);
    expect((await read()).createdAt).toBe(FIRST);

    expect(
      engine.insert("account", { id: "acct-1", name: "Second", createdAt: SECOND }).ok,
    ).toBe(true);
    const after = await read();
    expect(after.name).toBe("Second");
    expect(after.createdAt).toBe(SECOND); // replaced, not preserved

    // upsert is the mode that merges onto the existing row, so the stored
    // createdAt survives a write that does not mention it.
    expect(engine.upsert("account", { id: "acct-1", name: "Third" }).ok).toBe(true);
    const merged = await read();
    expect(merged.name).toBe("Third");
    expect(merged.createdAt).toBe(SECOND);
  });
});
