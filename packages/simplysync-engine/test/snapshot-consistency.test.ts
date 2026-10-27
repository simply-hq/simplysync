import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FiniteNumber, id, NonEmptyString, type SqliteDriver } from "../src/index";
import { createEngineState } from "../src/engine/state";
import { createStore } from "../src/engine/store";
import { memoryDriver, memoryStorage } from "./support";

test("snapshot rows and delivery metadata use one SQLite read version", () => {
  const folder = mkdtempSync(join(tmpdir(), "simplysync-snapshot-"));
  const path = join(folder, "wallet.sqlite");
  const db = new Database(path);
  const writer = new Database(path);
  const base = memoryDriver(db).driver;
  let armed = false;
  let committed = false;
  const driver: SqliteDriver = {
    ...base,
    select<R>(sql: string, params?: readonly unknown[]): R[] {
      const rows = base.select<R>(sql, params);
      if (armed && sql === 'select * from "account"') {
        armed = false;
        // This is a real commit on another connection while export is between
        // table reads. WAL permits it while the exporter holds a read snapshot.
        writer.transaction(() => {
          writer.exec("update account set name = '2'");
          writer.exec("update ledger set amount = 2");
          writer.exec("update _sync_meta set value = '2' where key = 'cursor:https://snapshot.invalid'");
        })();
        committed = true;
      }
      return rows;
    },
  };
  const config = { createSqliteDriver: () => driver, secureStorage: memoryStorage(), reloadApp() {} };
  const state = createEngineState(config);
  state.driver = driver;
  const AccountId = id("Account");
  const store = createStore(state, {
    account: { id: AccountId, name: NonEmptyString },
    ledger: { id: id("Ledger"), accountId: AccountId, amount: FiniteNumber },
  }, config);
  try {
    store.ensureSchema();
    db.exec("insert into account(id,name,createdAt,updatedAt,isDeleted) values ('a','1','2026-10-01','0000000001-0000-fixture',0)");
    db.exec("insert into ledger(id,accountId,amount,createdAt,updatedAt,isDeleted) values ('l','a',1,'2026-10-01','0000000001-0000-fixture',0)");
    db.exec("insert into _sync_meta(key,value) values ('cursor:https://snapshot.invalid','1')");
    armed = true;
    const snapshot = store.exportSnapshot("synthetic-fixture-key");
    expect(committed).toBe(true);
    expect(snapshot.tables.account?.[0]?.name).toBe("1");
    expect(snapshot.tables.ledger?.[0]?.amount).toBe(1);
    expect(snapshot.meta["cursor:https://snapshot.invalid"]).toBe("1");
    expect(writer.query("select name from account").get()).toEqual({ name: "2" });
  } finally {
    writer.close();
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
