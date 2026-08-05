import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createRecoveryKey,
  encryptStringWithPassphrase,
  InvalidBackupEnvelopeError,
  PassphraseDecryptError,
} from "@simplysync/protocol";

import {
  createSync,
  FiniteNumber,
  id,
  NonEmptyString,
  sqliteTrue,
  type AppOwner,
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

function memoryStorage(initial: Record<string, string> = {}): SecureStorage {
  const map = new Map<string, string>(Object.entries(initial));
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

function makeEngine(name = "test-db", storage = memoryStorage()) {
  const db = new Database(":memory:");
  const engine = createSync({
    createSqliteDriver: () => wrapDriver(db),
    secureStorage: storage,
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
  // Seed a device with some data, a soft-deleted row, and a relay cursor.
  async function seedDevice(name: string) {
    const dev = makeEngine(name);
    await dev.engine.ready;
    const checking = dev.engine.insert("account", { name: "Checking" });
    if (!checking.ok) throw new Error("seed insert failed");
    dev.engine.insert("ledger", {
      accountId: checking.value.id,
      amount: -450,
    } as never);
    // A soft-deleted row must survive the round-trip (it's part of the log).
    const old = dev.engine.insert("account", { name: "Old" });
    if (!old.ok) throw new Error("seed insert failed");
    dev.engine.update("account", { id: old.value.id, isDeleted: sqliteTrue });
    // A relay pull cursor must survive too (stand in for a real sync).
    dev.db
      .prepare(`insert into _sync_meta (key, value) values (?, ?)`)
      .run("cursor:http://relay.test", "99");
    return dev;
  }

  // Assert a fresh device B fully adopted device A's backup.
  async function expectRestored(
    b: { engine: ReturnType<typeof makeEngine>["engine"]; db: Database },
    ownerA: AppOwner,
    hlcTimeA: string | undefined,
  ) {
    const ownerAfter = await b.engine.appOwner;
    expect(ownerAfter?.recoveryKey).toBe(ownerA.recoveryKey);
    expect(ownerAfter?.mnemonic).toBe(ownerA.mnemonic);
    expect(ownerAfter?.id).toBe(ownerA.id);

    // All rows present, including the soft-deleted one.
    expect(b.db.prepare(`select id from account`).all()).toHaveLength(2);
    expect(b.db.prepare(`select id from ledger`).all()).toHaveLength(1);

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
  }

  test("default (phrase-keyed): round-trips to a fresh device", async () => {
    const a = await seedDevice("device-a");
    const ownerA = await a.engine.appOwner;
    expect(ownerA).not.toBeNull();
    const hlcTimeA = metaValue(a.db, "hlc:time");

    // No passphrase — keyed off the owner's recovery phrase.
    const envelope = await a.engine.exportDatabase();
    expect(envelope.keying).toBe("recovery-phrase");

    const b = makeEngine("device-b");
    await b.engine.ready;
    const ownerBefore = await b.engine.appOwner;
    expect(ownerBefore?.recoveryKey).not.toBe(ownerA!.recoveryKey);

    // Restoring requires the backup's recovery key or phrase.
    await b.engine.importDatabase(envelope, {
      recoveryKey: ownerA!.recoveryKey,
    });

    await expectRestored(b, ownerA!, hlcTimeA);
  });

  test("phrase-keyed: a wrong phrase throws and leaves the device untouched", async () => {
    const a = await seedDevice("device-a2");
    const envelope = await a.engine.exportDatabase();

    const b = makeEngine("device-b2");
    await b.engine.ready;
    const ownerBefore = await b.engine.appOwner;

    // Device B's own (different) credential derives a different owner.
    await expect(
      b.engine.importDatabase(envelope, {
        recoveryKey: ownerBefore!.recoveryKey,
      }),
    ).rejects.toThrow(/different recovery key or phrase/i);

    expect((await b.engine.appOwner)?.recoveryKey).toBe(
      ownerBefore?.recoveryKey,
    );
    expect(b.db.prepare(`select id from account`).all()).toHaveLength(0);
  });

  test("optional passphrase mode: round-trips without needing the phrase", async () => {
    const a = await seedDevice("device-a3");
    const ownerA = await a.engine.appOwner;
    const hlcTimeA = metaValue(a.db, "hlc:time");

    const envelope = await a.engine.exportDatabase({ passphrase: "hunter2" });
    expect(envelope.keying).toBe("passphrase");

    const b = makeEngine("device-b3");
    await b.engine.ready;

    // The passphrase backup carries the phrase, so only the passphrase is needed.
    await b.engine.importDatabase(envelope, { passphrase: "hunter2" });
    await expectRestored(b, ownerA!, hlcTimeA);
  });

  test("passphrase mode: a wrong passphrase throws PassphraseDecryptError", async () => {
    const a = await seedDevice("device-a4");
    const envelope = await a.engine.exportDatabase({ passphrase: "right" });

    const b = makeEngine("device-b4");
    await b.engine.ready;
    const ownerBefore = await b.engine.appOwner;

    await expect(
      b.engine.importDatabase(envelope, { passphrase: "wrong" }),
    ).rejects.toBeInstanceOf(PassphraseDecryptError);

    expect((await b.engine.appOwner)?.mnemonic).toBe(ownerBefore?.mnemonic);
    expect(b.db.prepare(`select id from account`).all()).toHaveLength(0);
  });

  test("a garbage file throws InvalidBackupEnvelopeError", async () => {
    const b = makeEngine("device-b5");
    await b.engine.ready;
    await expect(
      b.engine.importDatabase("not json at all", { passphrase: "pw" }),
    ).rejects.toBeInstanceOf(InvalidBackupEnvelopeError);
  });

  test("a malformed snapshot is rejected before owner or rows change", async () => {
    const source = makeEngine("invalid-snapshot-source");
    await source.engine.ready;
    const sourceOwner = await source.engine.appOwner;
    expect(sourceOwner).not.toBeNull();
    const malformed = {
      format: "simplysync-db-snapshot",
      version: 1,
      exportedAt: new Date().toISOString(),
      recoveryKey: sourceOwner!.recoveryKey,
      tables: {
        account: [{
          id: "broken",
          name: "Broken",
          createdAt: new Date().toISOString(),
          updatedAt: "not-an-hlc",
          isDeleted: 2,
        }],
      },
      meta: {},
    };
    const envelope = await encryptStringWithPassphrase(
      "pw",
      JSON.stringify(malformed),
    );

    const target = makeEngine("invalid-snapshot-target");
    await target.engine.ready;
    const ownerBefore = await target.engine.appOwner;
    const keep = target.engine.insert("account", { name: "Keep me" });
    expect(keep.ok).toBe(true);

    await expect(
      target.engine.importDatabase(envelope, { passphrase: "pw" }),
    ).rejects.toThrow(/updatedAt|isDeleted/);

    expect((await target.engine.appOwner)?.recoveryKey).toBe(
      ownerBefore?.recoveryKey,
    );
    expect(target.db.prepare(`select name from account`).all()).toEqual([
      { name: "Keep me" },
    ]);
  });

  test("a late snapshot write failure rolls back all rows and the owner credential", async () => {
    const source = makeEngine("atomic-snapshot-source");
    await source.engine.ready;
    const sourceAccount = source.engine.insert("account", { name: "Source" });
    if (!sourceAccount.ok) throw new Error("source account insert failed");
    const sourceLedger = source.engine.insert("ledger", {
      accountId: sourceAccount.value.id,
      amount: 777,
    } as never);
    if (!sourceLedger.ok) throw new Error("source ledger insert failed");
    const envelope = await source.engine.exportDatabase({ passphrase: "pw" });

    const storage = memoryStorage();
    const target = makeEngine("atomic-snapshot-target", storage);
    await target.engine.ready;
    const ownerBefore = await target.engine.appOwner;
    const keep = target.engine.insert("account", { name: "Keep me" });
    if (!keep.ok) throw new Error("target account insert failed");
    target.db.exec(`
      create trigger reject_snapshot_row
      before insert on ledger when new.amount = 777
      begin select raise(abort, 'injected snapshot failure'); end
    `);

    await expect(
      target.engine.importDatabase(envelope, { passphrase: "pw" }),
    ).rejects.toThrow(/injected snapshot failure/);

    expect(target.db.prepare(`select name from account`).all()).toEqual([
      { name: "Keep me" },
    ]);
    expect(target.db.prepare(`select id from ledger`).all()).toHaveLength(0);
    expect((await target.engine.appOwner)?.recoveryKey).toBe(
      ownerBefore?.recoveryKey,
    );

    // The in-memory owner changes only after import succeeds, so reopen with
    // the same storage to prove the durable credential was compensated too.
    const reopened = makeEngine("atomic-snapshot-target", storage);
    await reopened.engine.ready;
    expect((await reopened.engine.appOwner)?.recoveryKey).toBe(
      ownerBefore?.recoveryKey,
    );
  });

  test("native sf1_ identity round-trips through a recovery-keyed snapshot", async () => {
    const recoveryKey = await createRecoveryKey();
    const aName = "native-snapshot-a";
    const a = makeEngine(
      aName,
      memoryStorage({ [`${aName}:mnemonic`]: recoveryKey }),
    );
    await a.engine.ready;
    a.engine.insert("account", { name: "Native key account" });
    const envelope = await a.engine.exportDatabase();
    expect(envelope.keying).toBe("recovery-phrase");

    const b = makeEngine("native-snapshot-b");
    await b.engine.ready;
    await b.engine.importDatabase(envelope, { recoveryKey });

    const restoredOwner = await b.engine.appOwner;
    expect(restoredOwner?.recoveryKey).toBe(recoveryKey);
    expect(restoredOwner?.mnemonic).toBeUndefined();
    expect(b.db.prepare(`select id from account`).all()).toHaveLength(1);
  });
});
