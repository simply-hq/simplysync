// `bun run todo:dev` — the whole example, from a clean clone, in one command.
//
// Starts the relay, mints one owner, proves two devices converge through it,
// then stays up so you can keep poking at the same account from other terminals
// (or from the Swift / Kotlin / browser clients, which share this schema).

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  closeDevice,
  listTodos,
  openDevice,
  syncUntil,
  type TodoEngine,
} from "./device";
import { OWNER_FILE, todoDataDir } from "./paths";
import { startRelay } from "./relay";

const once = Bun.argv.includes("--once");

async function main(): Promise<void> {
  rmSync(todoDataDir, { recursive: true, force: true });
  mkdirSync(todoDataDir, { recursive: true });

  const relay = await startRelay();
  let laptop: TodoEngine | undefined;
  let phone: TodoEngine | undefined;

  try {
    // Device "laptop" mints the owner; every other device joins it by key.
    laptop = await openDevice({
      name: "laptop",
      dataDir: todoDataDir,
      relayUrl: relay.url,
    });
    const owner = await laptop.appOwner;
    if (!owner) throw new Error("no owner minted");
    writeFileSync(
      OWNER_FILE,
      JSON.stringify({ recoveryKey: owner.recoveryKey }, null, 2),
      { mode: 0o600 },
    );

    phone = await openDevice({
      name: "phone",
      dataDir: todoDataDir,
      relayUrl: relay.url,
      recoveryKey: owner.recoveryKey,
    });
    const phoneOwner = await phone.appOwner;
    if (phoneOwner?.id !== owner.id) {
      throw new Error("devices derived different owners");
    }
    console.log(
      `\nOwner ${owner.id}\n  both devices derived the same owner: true`,
    );

    // Laptop writes -> relay -> phone reads.
    console.log("\n1. laptop ensures two todos exist and pushes");
    await laptop.sync();
    await ensureTodo(laptop, "Buy milk");
    await ensureTodo(laptop, "Ship SimplySync");
    await laptop.sync();

    console.log("2. phone pulls");
    const expected = new Set(["Buy milk", "Ship SimplySync"]);
    const onPhone = await syncUntil(phone, (rows) =>
      [...expected].every((title) =>
        rows.some((row) => row.title === title),
      ),
    );
    for (const row of onPhone) console.log(`   [${row.done ? "x" : " "}] ${row.title}`);
    if (
      ![...expected].every((title) =>
        onPhone.some((row) => row.title === title),
      )
    ) {
      throw new Error("phone did not converge");
    }

    // The phone edits; the laptop converges. Row-level last-writer-wins by HLC.
    console.log("\n3. phone completes “Buy milk” and pushes");
    const milk = onPhone.find((row) => row.title === "Buy milk");
    if (!milk) throw new Error("missing row");
    const completed = phone.update("todo", { id: milk.id, done: 1 });
    if (!completed.ok) throw new Error(completed.error.message);
    await phone.sync();

    console.log("4. laptop pulls");
    const onLaptop = await syncUntil(
      laptop,
      (rows) => rows.some((row) => row.id === milk.id && row.done === 1),
    );
    for (const row of onLaptop) console.log(`   [${row.done ? "x" : " "}] ${row.title}`);

    const converged =
      JSON.stringify([...(await listTodos(laptop))].sort(byId)) ===
      JSON.stringify([...(await listTodos(phone))].sort(byId));
    console.log(`\nBoth devices agree: ${converged}`);
    if (!converged) throw new Error("devices did not converge");

    if (once) {
      console.log("Cold-start proof complete; stopping the relay.");
      return;
    }

    console.log(`
The relay is still running. In another terminal, drive the same account:

  bun run todo list --device phone
  bun run todo add "From a third device" --device tablet
  bun run todo list --device laptop

Same schema, other platforms — all join this owner:

  development recovery key (never log this in a real app):
    ${owner.recoveryKey}
  browser      bun run docs:dev        (open the Demo, paste the key)
  React Native bun run todo:expo       (open settings, paste the key)
  iOS/Swift    apps/todolist/swift  — README “See it interoperate”
  Kotlin       apps/todolist/kotlin — ./gradlew test -PrelayUrl=${relay.url}

Ctrl-C to stop the relay.`);

    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
  } finally {
    if (phone) closeDevice(phone);
    if (laptop) closeDevice(laptop);
    await relay.stop();
  }
}

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id.localeCompare(b.id);

async function ensureTodo(engine: TodoEngine, title: string): Promise<void> {
  if ((await listTodos(engine)).some((row) => row.title === title)) return;
  const result = engine.insert("todo", { title, done: 0 });
  if (!result.ok) throw new Error(result.error.message);
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
