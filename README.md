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
bun run relay:go            # needs Go 1.24+; or `bun run relay:bun` for the Bun relay

# In another terminal: spin up a relay + sync two clients, printing the
# decrypted state on each plus a sample opaque envelope
bun run demo
```

Then try the native client:

```sh
bun run expo                # Expo demo: expo-sqlite + expo-secure-store
```

## What's in the box

| Path | What it is |
| --- | --- |
| [`packages/simplysync-protocol`](packages/simplysync-protocol) | The protocol core: identity, key derivation, AES-GCM envelopes, HLC, encoding. Treat as **pinned** — update wholesale, don't fork. |
| [`packages/simplysync-engine`](packages/simplysync-engine) | Schema + Kysely query layer + sync engine (where payloads get encrypted/decrypted). |
| [`packages/simplysync-react`](packages/simplysync-react) | React hooks for binding the engine into a UI. |
| [`apps/relay-go`](apps/relay-go) | **Canonical** self-hostable relay: Go + SQLite, stores only ciphertext. |
| [`apps/simplysync-relay`](apps/simplysync-relay) | Bun + SQLite relay — reference implementation, wire-identical to the Go relay. |
| [`apps/relay-cloudflare`](apps/relay-cloudflare) | Serverless relay on Cloudflare Workers + D1 + R2. |
| [`apps/simplysync-example`](apps/simplysync-example) | CLI reference client + one-shot two-client sync demo. |
| [`apps/simplysync-expo`](apps/simplysync-expo) | Native Expo demo. |
| [`apps/simplysync-ios-swift`](apps/simplysync-ios-swift) | Native Swift port of the protocol core. |
| [`apps/simplysync-android-kotlin`](apps/simplysync-android-kotlin) | Native Kotlin/Android port of the protocol core — wire-compatible, pure-JVM, unit-tested. |

## Using it in your own app

The protocol **core** (`@simplysync/protocol`, `@simplysync/engine`) is the part where
correctness depends on everyone running the same code — the HLC clock, the
envelope format, the wire protocol. Update it wholesale; don't fork it, or your
clients can't sync with anyone else's.

The **glue** — the React hooks, your schema, your sync context, your relay
config — is yours to hack on freely. Start from
[`apps/simplysync-example/src/client.ts`](apps/simplysync-example), the canonical
reference client, and the [User Guide](docs/local-first/guide.md).

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
source citations).

## License

[MIT](LICENSE) © 2026 Jerico Pulvera. Use it as you see fit.
