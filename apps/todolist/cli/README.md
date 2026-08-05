# TodoList CLI

The Bun/SQLite face of the repository's canonical
[TodoList application](../README.md). Each device name owns a separate local
database and outbox while every device joins the same encrypted owner.

Commands are local-only unless you pass `--relay <url>`:

```sh
bun run todo setup
bun run todo setup --confirm
bun run todo add "Buy milk"
bun run todo list
```

The first run shows the recovery key and repeats the warning until you confirm
that it is saved. `bun run todo add-device` prints the exact restore command for
a new device; `restore --device <name> --key <key>` adopts it. If the key is
lost, no one can recover the synced data.

To run the one-command two-device sync proof from the repository root:

```sh
bun run todo:dev
```

Then use another terminal:

```sh
bun run todo list --device phone
bun run todo add "From a third device" --device tablet
bun run todo toggle <id> --device laptop
```

Use `bun run todo:interop` to drive the TypeScript, Swift, and Kotlin engines
against one owner and relay.

Create an independently named command-line app from this exact source with:

```sh
bun run scaffold cli my-app
bun run --cwd apps/my-app start -- add "My first item"
```
