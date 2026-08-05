# SimplySync protocol diagnostic

This is a low-level wire-protocol tool for port authors. It intentionally uses
`@simplysync/protocol` directly to expose envelopes, HLCs, relay cursors, and
ciphertext. Product developers should start with the canonical
[TodoList app](../../apps/todolist) instead.

From the repository root:

```sh
bun run protocol:demo
```

For manual commands:

```sh
bun run relay:go
bun run --cwd tools/protocol-demo start init --client alice
bun run --cwd tools/protocol-demo start add --client alice "Coffee" -450
bun run --cwd tools/protocol-demo start sync --client alice
bun run --cwd tools/protocol-demo start list --client alice
```

The tool stores recovery material in its ignored local SQLite files for
visibility and convenience. Production clients must use an OS- or
host-encrypted secret store.
