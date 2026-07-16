# Secure Local-First Example

This is a tiny proof of concept for a small, app-owned local-first layer.

The client app writes to a local SQLite database first. Every mutation also
creates an encrypted sync event. The relay stores only opaque event envelopes:
it does not know the table, row values, note text, or amounts.

## Run the One-Shot Demo

```sh
bun run simplysync:demo
```

That command starts a local relay, resets the demo databases, runs two local
clients, syncs them, and then shuts the relay down.

If your terminal closes when the command finishes, use the keep-open variant:

```sh
bun run simplysync:demo:keep-open
```

It leaves the relay running after the demo until you press Ctrl-C.

## Run Manually

Terminal 1:

```sh
bun run relay:go
```

Terminal 2:

```sh
bun run simplysync:client-demo
```

Or drive clients manually:

```sh
bun run --cwd examples/cli start init --client alice
bun run --cwd examples/cli start add --client alice "Coffee" -450
bun run --cwd examples/cli start sync --client alice
bun run --cwd examples/cli start owner --client alice
```

Restore a second local client using Alice's recovery key:

```sh
bun run --cwd examples/cli start init --client bob --recovery-key sf1_...
bun run --cwd examples/cli start sync --client bob
bun run --cwd examples/cli start list --client bob
```

## Security Shape

- The recovery key derives an owner id, data encryption key, and relay auth key.
- Payloads are encrypted locally with AES-GCM before leaving the client.
- Envelope metadata is authenticated as AES-GCM additional data.
- The relay stores a hash of the relay auth key and opaque ciphertext.
- The relay can deny service, delete events, or serve stale events. It cannot
  read or alter accepted payloads without clients rejecting them.

This demo stores the recovery key in the local SQLite `meta` table so the CLI is
easy to run. A mobile implementation should keep it in `expo-secure-store`.
