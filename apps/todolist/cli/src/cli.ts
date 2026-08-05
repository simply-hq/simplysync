// One todo device, driven from the shell. Each `--device` name is a separate
// device with its own local SQLite file; point two of them at one relay and they
// converge.
//
//   bun run todo add "Buy milk"
//   bun run todo list --device phone
//   bun run todo toggle <id>
//
// `bun run todo:dev` starts the relay and writes the shared owner file that
// makes every device here the same user.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { sqliteFalse, sqliteTrue } from "@simplysync/engine";
import {
  closeDevice,
  listTodos,
  openDevice,
  syncUntil,
  type TodoEngine,
} from "./device";
import { OWNER_FILE, todoDataDir } from "./paths";
import { relayUrl } from "./support";

const defaultRelay = process.env.RELAY_URL ?? "off";

function flag(name: string): string | undefined {
  const index = Bun.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : Bun.argv[index + 1];
}

/** The owner every device joins: `--key`, else the one `todo:dev` wrote. */
function sharedRecoveryKey(): string | undefined {
  const explicit = flag("key");
  if (explicit) return explicit;
  if (!existsSync(OWNER_FILE)) return undefined;
  return (JSON.parse(readFileSync(OWNER_FILE, "utf8")) as { recoveryKey: string })
    .recoveryKey;
}

async function printTodos(engine: TodoEngine, label: string): Promise<void> {
  const rows = await listTodos(engine);
  console.log(`\n${label} — ${rows.length} todo(s)`);
  for (const row of rows) {
    console.log(`  [${row.done ? "x" : " "}] ${row.id}  ${row.title}`);
  }
  if (rows.length === 0) console.log("  (empty)");
}

const USAGE = `Usage: bun run todo <command> [options]

Commands:
  setup             show the first-run recovery key; add --confirm after saving it
  add <title>        add a todo
  list               show this device's todos
  toggle <id>        flip done
  delete <id>        soft-delete (replicates as a tombstone)
  sync               push + pull now
  key                print this device's recovery key
  add-device         show the key and exact restore command for another device
  restore            restore on a new --device using --key, then sync

Options:
  --device <name>    device name (default: cli) — each name is its own device
  --relay <url>      relay URL (default: off; local demo relay: ${relayUrl})
  --key <key>        join a specific owner instead of the shared dev owner`;

async function main(): Promise<void> {
  const [command, argument] = Bun.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!command || command === "help") {
    console.log(USAGE);
    return;
  }

  const relay = flag("relay") ?? defaultRelay;
  const device = flag("device") ?? "cli";
  if (command === "restore" && !flag("key")) {
    throw new Error("restore needs --key <recovery-key>");
  }
  const recoveryKey = sharedRecoveryKey();
  const engine = await openDevice({
    name: device,
    dataDir: todoDataDir,
    ...(relay === "off" ? {} : { relayUrl: relay }),
    ...(recoveryKey ? { recoveryKey } : {}),
  });

  // `closeDevice` stops the sync poller — without it the process never exits.
  try {
    await run(command, argument, engine, device);
    if (flag("key")) confirmRecoverySaved(device);
    if (
      !recoveryWasConfirmed(device) &&
      !["setup", "key", "add-device", "restore"].includes(command)
    ) {
      await printRecoverySetup(engine, device);
    }
  } finally {
    closeDevice(engine);
  }
}

async function run(
  command: string,
  argument: string | undefined,
  engine: TodoEngine,
  device: string,
): Promise<void> {
  switch (command) {
    case "setup": {
      if (Bun.argv.includes("--confirm")) {
        confirmRecoverySaved(device);
        console.log(`Recovery key confirmed for device ${device}.`);
      } else {
        await printRecoverySetup(engine, device);
      }
      return;
    }
    case "add": {
      if (!argument) throw new Error('add needs a title: bun run todo add "Buy milk"');
      const result = engine.insert("todo", { title: argument, done: sqliteFalse });
      if (!result.ok) throw new Error(result.error.message);
      console.log(`added ${result.value.id}`);
      await engine.sync();
      break;
    }
    case "list":
      await engine.sync().catch(() => undefined); // offline is fine; read locally
      break;
    case "toggle": {
      if (!argument) throw new Error("toggle needs an id");
      const row = (await listTodos(engine)).find((r) => r.id === argument);
      if (!row) throw new Error(`no todo ${argument} on device ${device}`);
      const result = engine.update("todo", {
        id: argument,
        done: row.done ? sqliteFalse : sqliteTrue,
      });
      if (!result.ok) throw new Error(result.error.message);
      await engine.sync();
      break;
    }
    case "delete": {
      if (!argument) throw new Error("delete needs an id");
      const result = engine.delete("todo", argument);
      if (!result.ok) throw new Error(result.error.message);
      await engine.sync();
      break;
    }
    case "sync":
      await syncUntil(engine, () => true, 1);
      console.log(`synced (${engine.getPendingOutboxCount()} still queued)`);
      break;
    case "key": {
      const owner = await engine.appOwner;
      console.log(owner?.recoveryKey ?? "(no owner)");
      return;
    }
    case "add-device": {
      const owner = await engine.appOwner;
      if (!owner) throw new Error("no owner");
      console.log(`Add another device

On the new device, restore this owner with:
  bun run start -- restore --device <new-device> --key '${owner.recoveryKey}' --relay <url>

If you lose this key, no one can recover your synced data.`);
      return;
    }
    case "restore":
      await engine.sync().catch(() => undefined);
      console.log(`Restored owner on device ${device}.`);
      break;
    default:
      console.log(USAGE);
      return;
  }

  await printTodos(engine, `device ${device}`);
}

function recoveryConfirmationPath(device: string): string {
  return resolve(todoDataDir, `${device}.recovery-confirmed`);
}

function recoveryWasConfirmed(device: string): boolean {
  return existsSync(recoveryConfirmationPath(device));
}

function confirmRecoverySaved(device: string): void {
  writeFileSync(recoveryConfirmationPath(device), "saved\n", { mode: 0o600 });
}

async function printRecoverySetup(
  engine: TodoEngine,
  device: string,
): Promise<void> {
  const owner = await engine.appOwner;
  if (!owner) throw new Error("no owner");
  console.log(`
FIRST-RUN RECOVERY SETUP

Save this recovery key before relying on synced data:
  ${owner.recoveryKey}

If you lose this key, no one can recover your synced data.

After saving it, confirm with:
  bun run start -- setup --device ${device} --confirm

To restore on another device, run add-device for the exact command.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
