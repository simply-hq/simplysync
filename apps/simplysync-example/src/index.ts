import { join } from "node:path";
import { LocalFirstClient } from "./client";
import {
  cleanExampleData,
  exampleRoot,
  removeSqliteFiles,
} from "./demo-support";

const DEFAULT_RELAY_URL = process.env.RELAY_URL ?? "http://localhost:4100";

async function main(): Promise<void> {
  const [command = "help", ...args] = Bun.argv.slice(2);

  switch (command) {
    case "init":
      return initCommand(args);
    case "owner":
      return ownerCommand(args);
    case "add":
      return addCommand(args);
    case "update":
      return updateCommand(args);
    case "delete":
      return deleteCommand(args);
    case "list":
      return listCommand(args);
    case "sync":
      return syncCommand(args);
    case "demo":
      return demoCommand();
    case "inspect-outbox":
      return inspectOutboxCommand(args);
    case "reset-client":
      return resetClientCommand(args);
    default:
      return helpCommand();
  }
}

async function initCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const client = await openClient(options);
  console.log(`Client: ${client.name}`);
  console.log(`Owner:  ${client.ownerId}`);
  console.log(`Device: ${client.localDeviceId}`);
  console.log(`Recovery key: ${client.recoveryKey}`);
}

async function ownerCommand(args: string[]): Promise<void> {
  const client = await openClient(parseOptions(args));
  console.log(`Owner:  ${client.ownerId}`);
  console.log(`Device: ${client.localDeviceId}`);
  console.log(`Recovery key: ${client.recoveryKey}`);
}

async function addCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const body = options.positionals[0];
  const amountCents = Number(options.positionals[1] ?? 0);

  if (!body) {
    throw new Error(`Usage: bun start add --client alice "Coffee" -450`);
  }

  const client = await openClient(options);
  const note = await client.addNote(body, amountCents);
  console.log(`Added ${note.id}`);
}

async function updateCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const [id, body, rawAmount] = options.positionals;

  if (!id || !body) {
    throw new Error(`Usage: bun start update --client alice <id> "New text" [amountCents]`);
  }

  const client = await openClient(options);
  await client.updateNote(id, {
    body,
    amountCents: rawAmount == null ? undefined : Number(rawAmount),
  });
  console.log(`Updated ${id}`);
}

async function deleteCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const id = options.positionals[0];

  if (!id) {
    throw new Error(`Usage: bun start delete --client alice <id>`);
  }

  const client = await openClient(options);
  await client.deleteNote(id);
  console.log(`Deleted ${id}`);
}

async function listCommand(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const client = await openClient(options);
  const notes = client.listNotes({ includeDeleted: options.includeDeleted });

  if (notes.length === 0) {
    console.log("No local notes.");
    return;
  }

  for (const note of notes) {
    const status = note.deletedAtHlc ? "deleted" : "active";
    console.log(
      [
        note.id,
        status.padEnd(7),
        String(note.amountCents).padStart(8),
        note.body,
      ].join("  "),
    );
  }
}

async function syncCommand(args: string[]): Promise<void> {
  const client = await openClient(parseOptions(args));
  const result = await client.sync();
  console.log(
    `Sync complete: pushed=${result.pushed}, duplicate=${result.duplicates}, pulled=${result.pulled}, applied=${result.applied}`,
  );
}

async function inspectOutboxCommand(args: string[]): Promise<void> {
  const client = await openClient(parseOptions(args));
  const envelopes = client.getStoredEnvelopeJson();
  console.log(envelopes.join("\n"));
}

function resetClientCommand(args: string[]): void {
  const options = parseOptions(args);
  const clientName = options.client ?? "alice";
  removeSqliteFiles(join(exampleRoot, "data", clientName));
  console.log(`Reset ${clientName}`);
}

async function demoCommand(): Promise<void> {
  resetDemoClientFiles();

  const alice = await LocalFirstClient.open({
    name: "alice",
    relayUrl: DEFAULT_RELAY_URL,
  });
  const bob = await LocalFirstClient.open({
    name: "bob",
    relayUrl: DEFAULT_RELAY_URL,
    recoveryKey: alice.recoveryKey,
  });

  await alice.addNote("Coffee", -450);
  await alice.addNote("Paycheck", 250000);
  console.log("Alice wrote two local notes.");

  console.log("Alice sync:", await alice.sync());
  console.log("Bob sync:", await bob.sync());

  await bob.addNote("Groceries", -5231);
  console.log("Bob wrote one local note.");

  console.log("Bob sync:", await bob.sync());
  console.log("Alice sync:", await alice.sync());

  console.log("\nAlice local notes:");
  for (const note of alice.listNotes()) {
    console.log(`- ${note.body}: ${note.amountCents}`);
  }

  console.log("\nBob local notes:");
  for (const note of bob.listNotes()) {
    console.log(`- ${note.body}: ${note.amountCents}`);
  }

  console.log("\nRelay outbox sample is encrypted:");
  console.log(alice.getStoredEnvelopeJson()[0]);
}

function helpCommand(): void {
  console.log(`
Secure local-first example

Start relay in another terminal:
  bun run relay:go

Commands:
  bun run --cwd apps/simplysync-example start init --client alice
  bun run --cwd apps/simplysync-example start owner --client alice
  bun run --cwd apps/simplysync-example start add --client alice "Coffee" -450
  bun run --cwd apps/simplysync-example start list --client alice
  bun run --cwd apps/simplysync-example start sync --client alice
  bun run --cwd apps/simplysync-example start demo

Restore another client from the same recovery key:
  bun run --cwd apps/simplysync-example start init --client bob --recovery-key sf1_...
`);
}

async function openClient(options: ParsedOptions): Promise<LocalFirstClient> {
  return LocalFirstClient.open({
    name: options.client ?? "alice",
    relayUrl: options.relayUrl ?? DEFAULT_RELAY_URL,
    recoveryKey: options.recoveryKey,
  });
}

interface ParsedOptions {
  readonly client?: string;
  readonly relayUrl?: string;
  readonly recoveryKey?: string;
  readonly includeDeleted?: boolean;
  readonly positionals: string[];
}

function parseOptions(args: string[]): ParsedOptions {
  const positionals: string[] = [];
  let client: string | undefined;
  let relayUrl: string | undefined;
  let recoveryKey: string | undefined;
  let includeDeleted = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--client":
        client = args[++index];
        break;
      case "--relay-url":
        relayUrl = args[++index];
        break;
      case "--recovery-key":
        recoveryKey = args[++index];
        break;
      case "--include-deleted":
        includeDeleted = true;
        break;
      default:
        positionals.push(arg);
    }
  }

  return { client, relayUrl, recoveryKey, includeDeleted, positionals };
}

function resetDemoClientFiles(): void {
  cleanExampleData();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
