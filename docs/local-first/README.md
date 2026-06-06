# SimplySync Docs

SimplySync is a small, app-owned local-first platform for building apps where
users own their data. Offline-first on SQLite, end-to-end encrypted by
default, sync via self-hostable or cloud relays, no vendor lock-in.

**Open source, MIT-licensed — clone it and use it as you see fit.** It's built
to be lifted into your own local-first apps. The point of open-sourcing it is
trust: you don't have to take the "local-first, end-to-end encrypted" claim on
faith. **[SECURITY.md](../../SECURITY.md)** walks the exact source files that
enforce it, and you can [run your own relay](./self-hosting.md) so you depend on
no one.

## Start here

- **[User Guide](./guide.md)** — for app developers building on
  `@simplysync/protocol`: identity & recovery keys (incl. BIP39 mnemonics),
  writing data, syncing, running a relay, and the core API reference.
- **[Architecture & Contributor Guide](./architecture.md)** — for people
  working on the library: cryptographic design, the envelope format, the sync
  HTTP protocol, the relay's storage and threat model, repo layout, and how to
  build, test, and extend it.
- **[Self-Hosting a Sync Server](./self-hosting.md)** — for end users (and the
  developers documenting it): run your own relay via Docker and point the app at
  it over Tailscale, Caddy, Cloudflare Tunnel, or LAN.
- **[Security & Threat Model](../../SECURITY.md)** — what a relay can and cannot
  see, with links to the exact source that enforces each guarantee. Start here
  if you're evaluating whether the local-first claim holds up.

## TL;DR

```sh
bun install
bun run simplysync:demo   # spins up a relay, syncs two clients, prints the
                           # decrypted state on each + a sample opaque envelope
```

## Where the code lives

| Path | What it is |
| --- | --- |
| `packages/simplysync-protocol` | The library: identity, key derivation, AES-GCM envelopes, HLC, encoding. |
| `packages/simplysync-engine` | Schema + Kysely query layer + the sync engine (where payloads get encrypted/decrypted). |
| `packages/simplysync-react` | React hooks for binding the engine into a UI. |
| `apps/relay-go` | Canonical self-hostable relay: Go + SQLite, stores only ciphertext. See its [README](../../apps/relay-go/README.md). |
| `apps/simplysync-relay` | Bun + SQLite relay (reference implementation, wire-identical to the Go relay). |
| `apps/relay-cloudflare` | Serverless relay on Cloudflare Workers + D1 + R2, hardened against wallet-DDoS. See its [README](../../apps/relay-cloudflare/README.md). |
| `apps/simplysync-example` | CLI reference client + one-shot two-client sync demo. |
| `apps/simplysync-expo` | Native Expo demo (`expo-sqlite` + `expo-secure-store`). |

Each app also has its own README with run instructions. The package-level
overview lives in
[`packages/simplysync-protocol/README.md`](../../packages/simplysync-protocol/README.md).
