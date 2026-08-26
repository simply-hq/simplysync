import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  closeSqlJsDatabases,
  createSqlJsDriverFactory,
  type SnapshotStore,
} from "@simplysync/browser";
import {
  createSync,
  type SecureStorage,
  type SqliteDriver,
  type SyncEngine,
  type Transport,
} from "@simplysync/engine";
import { schema } from "../../../web/schema.ts";
import { memorySecureStorage, memorySnapshotStore } from "../../../web/test-support.ts";
import { writeAtomic } from "../mailbox.ts";

const mailbox = process.env.SIMPLYSYNC_TODO_E2E_MAILBOX;
if (!mailbox) throw new Error("SIMPLYSYNC_TODO_E2E_MAILBOX is required");
const WASM_PATH = Bun.resolveSync("sql.js/dist/sql-wasm.wasm", import.meta.dir);

type TodoEngine = SyncEngine<typeof schema>;
type Device = {
  engine: TodoEngine;
  driver: SqliteDriver;
};

const devices = new Map<string, Device>();
let running = true;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function createDevice(id: string, recoveryKey: string, deviceId: string): Promise<Device> {
  const secureStorage: SecureStorage = memorySecureStorage([
    [`${id}:mnemonic`, recoveryKey],
    [`${id}:deviceId`, deviceId],
  ]);
  const store: SnapshotStore = memorySnapshotStore();
  let driver!: SqliteDriver;
  const factory = createSqlJsDriverFactory({
    store,
    locateFile: () => WASM_PATH,
    writerLock: "disabled",
    debounceMs: 0,
  });
  const engine = createSync({
    createSqliteDriver: async (name) => {
      driver = await factory(name);
      return driver;
    },
    secureStorage,
    reloadApp: () => undefined,
  })(schema, { name: id, transports: [] });
  await engine.ready;
  return { engine, driver };
}

const normalizeRelay = (url: string) => url.replace(/\/$/u, "");

async function settle(engine: TodoEngine, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (engine.getSyncState().type === "SyncStateIsSyncing") {
    if (Date.now() - started > timeoutMs) throw new Error("web sync did not settle");
    await sleep(10);
  }
}

async function waitForOutboxSeal(device: Device, timeoutMs = 30_000): Promise<void> {
  const started = Date.now();
  while (true) {
    const unsealed = device.driver.select<{ count: number }>(
      `select count(*) as count from "_sync_outbox" where envelope_json = ''`,
    )[0]?.count ?? 0;
    if (unsealed === 0) {
      await sleep(0);
      return;
    }
    if (Date.now() - started > timeoutMs) throw new Error("web outbox seal did not settle");
    await sleep(10);
  }
}

async function sync(device: Device, relayUrl: string) {
  const relay = normalizeRelay(relayUrl);
  await waitForOutboxSeal(device);
  const before = Math.max(0, ...device.engine.getSyncLog(100).map((entry) => entry.seq));
  device.engine.setTransports([{ url: relay } satisfies Transport]);
  await device.engine.sync();
  await settle(device.engine);
  const state = device.engine.getSyncState();
  const logs = device.engine
    .getSyncLog(100)
    .filter((entry) => entry.seq > before && entry.phase === "sync" && entry.result === "ok");
  device.engine.setTransports([]);
  if (state.type === "SyncStateIsNotSynced") {
    throw new Error(`${state.kind ?? "unknown"}: ${state.error ?? "sync failed"}`);
  }
  return logs.reduce(
    (total, entry) => ({
      pushed: total.pushed + entry.pushed,
      pulled: total.pulled + entry.pulled,
      applied: total.applied + entry.applied,
    }),
    { pushed: 0, pulled: 0, applied: 0 },
  );
}

async function syncExpectError(device: Device, relayUrl: string) {
  await waitForOutboxSeal(device);
  device.engine.setTransports([
    { url: normalizeRelay(relayUrl) } satisfies Transport,
  ]);
  await device.engine.sync();
  await settle(device.engine);
  const state = device.engine.getSyncState();
  device.engine.setTransports([]);
  return state.type === "SyncStateIsNotSynced"
    ? { threw: true, kind: state.kind ?? "unknown" }
    : { threw: false };
}

function mutationValues(command: Record<string, unknown>): Record<string, unknown> {
  return (command.values as Record<string, unknown> | undefined) ?? {};
}

async function handle(command: Record<string, unknown>): Promise<unknown> {
  const cmd = String(command.cmd);
  if (cmd === "ping") return { ready: true };
  if (cmd === "shutdown") {
    for (const [name, device] of devices) {
      device.engine.setTransports([]);
      await closeSqlJsDatabases(name);
    }
    running = false;
    return { stopped: true };
  }

  const id = String(command.device);
  if (cmd === "init") {
    if (!devices.has(id)) {
      devices.set(
        id,
        await createDevice(id, String(command.mnemonic), String(command.deviceId)),
      );
    }
    return { initialized: true };
  }

  const device = devices.get(id);
  if (!device) throw new Error(`unknown web device '${id}'`);

  switch (cmd) {
    case "mutate": {
      const table = String(command.table) as keyof typeof schema;
      const rowId = String(command.rowId);
      const result = command.op === "delete"
        ? device.engine.delete(table, rowId)
        : device.engine.upsert(table, {
            id: rowId,
            ...mutationValues(command),
          } as never);
      if (!result.ok) throw new Error(result.error.message);
      return { id: rowId };
    }
    case "mutateMany": {
      const ops = (command.ops as Array<Record<string, unknown>>).map((op) => ({
        table: String(op.table) as keyof typeof schema,
        mode: op.op === "delete" ? "delete" as const : "upsert" as const,
        values: {
          id: String(op.rowId),
          ...((op.values as Record<string, unknown>) ?? {}),
        } as never,
      }));
      const result = device.engine.batch(ops);
      if (!result.ok) throw new Error(result.error.message);
      return { count: ops.length };
    }
    case "sync":
      return sync(device, String(command.relayUrl));
    case "syncExpectError":
      return syncExpectError(device, String(command.relayUrl));
    case "owner": {
      const owner = await device.engine.appOwner;
      if (!owner) throw new Error("web owner is not ready");
      return { id: owner.id, recoveryKey: owner.recoveryKey };
    }
    case "restoreOwner": {
      const relayUrl = normalizeRelay(String(command.relayUrl));
      device.engine.setTransports([
        { url: relayUrl } satisfies Transport,
      ]);
      try {
        // setTransports starts a pass immediately. Let that old-owner pass
        // finish before restore wipes and swaps identity, or it can re-apply
        // the old owner's rows after the wipe.
        await device.engine.sync();
        await settle(device.engine);
        await device.engine.restoreAppOwner(String(command.recoveryKey));
        await device.engine.sync();
        await settle(device.engine);
        const state = device.engine.getSyncState();
        if (state.type === "SyncStateIsNotSynced") {
          throw new Error(`${state.kind ?? "unknown"}: ${state.error ?? "restore sync failed"}`);
        }
        const owner = await device.engine.appOwner;
        if (!owner) throw new Error("web owner is not ready after restore");
        return { id: owner.id, recoveryKey: owner.recoveryKey };
      } finally {
        device.engine.setTransports([]);
      }
    }
    case "outboxCount":
      await waitForOutboxSeal(device);
      return { count: device.engine.getPendingOutboxCount() };
    case "purgeDeleted":
      return device.engine.purgeDeleted({ olderThanMs: Number(command.olderThanMs) });
    case "dispose":
      device.engine.setTransports([]);
      devices.delete(id);
      await closeSqlJsDatabases(id);
      return { disposed: true };
    case "exportState":
      return {
        todo: device.driver.select<Record<string, unknown>>(
          `select * from "todo" order by id`,
        ),
      };
    default:
      throw new Error(`unknown web TodoList runner command '${cmd}'`);
  }
}

const processed = new Set<string>();
while (running) {
  const commands = readdirSync(mailbox)
    .filter((name) => /^cmd-\d+\.json$/u.test(name))
    .sort();
  for (const name of commands) {
    if (processed.has(name)) continue;
    const path = join(mailbox, name);
    if (!existsSync(path)) continue;
    processed.add(name);
    const command = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const seq = Number(command.seq);
    const responsePath = join(mailbox, name.replace("cmd-", "res-"));
    try {
      writeAtomic(responsePath, JSON.stringify({
        seq,
        ok: true,
        result: await handle(command),
      }));
    } catch (error) {
      writeAtomic(responsePath, JSON.stringify({
        seq,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
  if (running) await sleep(10);
}
