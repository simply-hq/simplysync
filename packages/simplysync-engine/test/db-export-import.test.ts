import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  InvalidBackupEnvelopeError,
  PassphraseDecryptError,
} from "@simplysync/protocol";

import {
  createSync,
  FiniteNumber,
  id,
  NonEmptyString,
  sqliteTrue,
  type SecureStorage,
  type SqliteDriver,
} from "../src/index";

const AccountId = id("Account");
const LedgerId = id("Ledger");

const schema = {
  account: { id: AccountId, name: NonEmptyString },
  ledger: { id: LedgerId, accountId: AccountId, amount: FiniteNumber },
};

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

function makeEngine(name = "test-db") {
  const db = new Database(":memory:");
  const engine = createSync({
    createSqliteDriver: () => wrapDriver(db),
    secureStorage: memoryStorage(),
    reloadApp: () => {},
  })(schema, { name });
  return { engine, db };
}

function metaValue(db: Database, key: string): string | undefined {
  const row = db
    .prepare(`select value from _sync_meta where key = ?`)
    .get(key) as { value: string } | null;
  return row?.value;
}

describe("db export / import", () => {
  test("round-trips data, identity, and clock to a fresh device", async () => {
    const a = makeEngine("device-a");
    await a.engine.ready;

    const checking = a.engine.insert("account", { name: "Checking" });
    expect(checking.ok).toBe(true);
    if (!checking.ok) return;
    a.engine.insert("ledger", {
      accountId: checking.value.id,
      amount: -450,
    } as never);

    // A soft-deleted row must survive the round-trip (it's part of the log).
    const old = a.engine.insert("account", { name: "Old" });
    if (!old.ok) return;
    a.engine.update("account", { id: old.value.id, isDeleted: sqliteTrue });

    // A relay pull cursor must survive too (stand in for a real sync).
    a.db
      .prepare(`insert into _sync_meta (key, value) values (?, ?)`)
      .run("cursor:http://relay.test", "99");

    const ownerA = await a.engine.appOwner;
    expect(ownerA).not.toBeNull();
    const hlcTimeA = metaValue(a.db, "hlc:time");

    const envelope = await a.engine.exportDatabase("backup-pw");

    // A pristine second device with a different, freshly-minted owner.
    const b = makeEngine("device-b");
    await b.engine.ready;
    const ownerBefore = await b.engine.appOwner;
    expect(ownerBefore?.mnemonic).not.toBe(ownerA?.mnemonic);

    await b.engine.importDatabase(envelope, "backup-pw");

    // Identity adopted from the backup.
    const ownerAfter = await b.engine.appOwner;
    expect(ownerAfter?.mnemonic).toBe(ownerA!.mnemonic);
    expect(ownerAfter?.id).toBe(ownerA!.id);

    // All rows present, including the soft-deleted one.
    const allAccounts = b.db.prepare(`select id, isDeleted from account`).all();
    expect(allAccounts).toHaveLength(2);
    const ledgers = b.db.prepare(`select id from ledger`).all();
    expect(ledgers).toHaveLength(1);

    // Active queries still filter soft-deleted rows correctly.
    const activeAccounts = b.engine.createQuery((db) =>
      db
        .selectFrom("account")
        .select(["id", "name"])
        .where("isDeleted", "is not", 1),
    );
    const active = await b.engine.loadQuery(activeAccounts);
    expect(active.map((r) => r.name)).toEqual(["Checking"]);

    // Sync metadata restored: cursor + HLC high-water mark.
    expect(metaValue(b.db, "cursor:http://relay.test")).toBe("99");
    expect(metaValue(b.db, "hlc:time")).toBe(hlcTimeA);
  });

  test("a wrong passphrase throws and leaves the device untouched", async () => {
    const a = makeEngine("device-a2");
    await a.engine.ready;
    a.engine.insert("account", { name: "Checking" });
    const envelope = await a.engine.exportDatabase("right-pw");

    const b = makeEngine("device-b2");
    await b.engine.ready;
    const ownerBefore = await b.engine.appOwner;

    await expect(
      b.engine.importDatabase(envelope, "wrong-pw"),
    ).rejects.toBeInstanceOf(PassphraseDecryptError);

    // No identity switch, no data written.
    expect((await b.engine.appOwner)?.mnemonic).toBe(ownerBefore?.mnemonic);
    expect(b.db.prepare(`select id from account`).all()).toHaveLength(0);
  });

  test("a garbage file throws InvalidBackupEnvelopeError", async () => {
    const b = makeEngine("device-b3");
    await b.engine.ready;
    await expect(
      b.engine.importDatabase("not json at all", "pw"),
    ).rejects.toBeInstanceOf(InvalidBackupEnvelopeError);
  });
});
