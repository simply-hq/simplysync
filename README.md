# SimplySync

**An app-owned, end-to-end-encrypted local-first sync engine.** Apps write to a
local SQLite database first and sync opportunistically through a relay that only
ever sees ciphertext. No vendor lock-in, no data hostage situation, no account
system to phish.

> **MIT-licensed — clone it and use it as you see fit.** This repo is meant to be
> lifted into your own local-first apps. It's open source so you don't have to
> trust the "local-first, end-to-end encrypted" claim on faith: read the code,
> and [run your own relay](docs/local-first/self-hosting.md) so you depend on no
> one.

## Why you can trust the local-first claim

The relay is a dumb, opaque event store. It holds nonce-and-ciphertext plus a
little routing metadata — never your data, your encryption key, or your recovery
phrase. **[SECURITY.md](SECURITY.md)** walks the exact source files that enforce
this and shows you how to audit it yourself in ten minutes.

- Payloads are **AES-256-GCM**, encrypted on-device with a key derived from the
  user's secret that **never leaves the device**.
- The relay stores only `nonce + ciphertext + routing metadata`, and only the
  **SHA-256 hash** of the auth token.
- The protocol is identical whether you use a relay you run or someone else's —
  so self-hosting is a one-command escape hatch, not a downgrade.

## Quick start

```sh
bun install

# Run the canonical (Go) relay — stores only ciphertext
bun run relay:go            # needs Go 1.25+

# In another terminal: spin up a relay + sync two clients, printing the
# decrypted state on each plus a sample opaque envelope
bun run demo
```

Then try the native client:

```sh
bun run expo                # Expo demo: expo-sqlite + expo-secure-store
```

## What's in the box

The reusable engine is deliberately separate from runnable examples. Nothing
under `examples/` is imported by the engine packages.

### Core engine

| Package | Purpose |
| --- | --- |
| [`@simplysync/protocol`](packages/simplysync-protocol) | Identity, key derivation, AES-GCM envelopes, HLC, and wire encoding. Treat as **pinned** — update wholesale, don't fork. |
| [`@simplysync/engine`](packages/simplysync-engine) | Typed schema, local SQLite store, Kysely queries, mutations, and encrypted replication. |
| [`@simplysync/react`](packages/simplysync-react) | React bindings for the engine. |

### Native engine ports

| Port | Purpose |
| --- | --- |
| [`ports/swift`](ports/swift) | Native Swift protocol and engine implementation. |
| [`ports/kotlin`](ports/kotlin) | Pure-JVM Kotlin protocol and engine implementation. |

### Optional relays

| Implementation | Purpose |
| --- | --- |
| [`relays/go`](relays/go) | **Canonical** self-hosted Go + SQLite relay; stores only ciphertext. |
| [`relays/cloudflare`](relays/cloudflare) | Serverless Cloudflare Workers + D1 + R2 relay. |

### Examples

| Example | Purpose |
| --- | --- |
| [`examples/cli`](examples/cli) | Low-level protocol client and one-shot two-client sync demo. |
| [`examples/expo`](examples/expo) | Expo integration using SQLite and secure device storage. |
| [`examples/ai-chat`](examples/ai-chat) | Full local-first application built on `@simplysync/engine`. |

Compatibility suites live under [`tests/`](tests/), while the documentation
source and its browser playground live under [`docs/`](docs/).

## Using it in your own app

The protocol **core** (`@simplysync/protocol`, `@simplysync/engine`) is the part where
correctness depends on everyone running the same code — the HLC clock, the
envelope format, the wire protocol. Update it wholesale; don't fork it, or your
clients can't sync with anyone else's.

The **glue** — the React hooks, your schema, your sync context, your relay
config — is yours to hack on freely. Start from
[`examples/ai-chat`](examples/ai-chat) for an engine-level application or
[`examples/cli/src/client.ts`](examples/cli/src/client.ts) for the lower-level
protocol, then continue with the [User Guide](docs/local-first/guide.md).

## Docs

The docs are split into clear sections (and render as a small static site —
`bun run docs:dev`):

1. **[What & why](docs/local-first/README.md)** — what this is, why use it, and its limitations
2. **[Client API](docs/local-first/guide.md)** — schema, mutations, reactive queries, React hooks, identity & relays
3. **[How it works](docs/local-first/architecture.md)** — the on-device model: local SQLite, the clock, the write & read paths
4. **[Sync & the relay](docs/local-first/sync.md)** — the sync loop, the encrypted envelope, the relay wire protocol & threat model
5. **Demo** — a two-device browser sync demo (`bun run docs:dev`, then open the Demo page)

Also: **[Self-Hosting a Relay](docs/local-first/self-hosting.md)** (Docker /
Tailscale / Caddy / Cloudflare Tunnel / LAN) and the
**[Security & Threat Model](SECURITY.md)** (what a relay can and cannot see, with
source citations), plus **[Project history](HISTORY.md)** (where the public
timeline begins and what the reconstructed checkpoints represent).

## License

[MIT](LICENSE) © 2026 Jerico Pulvera. Use it as you see fit.
