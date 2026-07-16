# What is SimplySync?

A small, app-owned **local-first sync engine**. Your app writes to a local SQLite
database first — instant, fully offline-capable — and those writes sync between a
user's devices through a relay that only ever sees ciphertext.

> Think of it like **iCloud or Google Drive for your app's data — except the
> server can't read any of it.**

Open source and MIT-licensed: **clone it, [run your own relay](./self-hosting.md),
and depend on no one.** Don't take the "end-to-end encrypted" claim on faith —
**[SECURITY.md](../../SECURITY.md)** walks the exact source that enforces it.

```
  your app                         relay (dumb, opaque store — optional)
┌──────────────┐  encrypted      ┌───────────────────────────────────┐
│ local SQLite │ ── push ──────▶ │ events keyed by (ownerId, eventId) │
│ (source of   │ ◀── pull ────── │ stores ciphertext only            │
│  truth)      │   (cursor)      └───────────────────────────────────┘
└──────────────┘
```

## Use it when

- You're building an **offline-first app where the user owns their data** — notes, journaling, finance/health trackers, personal tools.
- It's **single-user across their own devices** (sync a phone, laptop, tablet).
- **Privacy matters** and you'd rather *not be able* to read user data at all.
- You want **no backend to run** beyond a tiny, self-hostable relay.

## Don't use it when

- You need **real-time collaboration or field-level merges** → use a CRDT (Yjs, Automerge).
- You need **multi-user sharing, permissions, or teams** → there's one owner per client.
- You need **server-side queries, search, or aggregation** → the relay can't read your data.
- The **server must validate or act on data** (payments, authoritative game state).
- You need **strong consistency or cross-device transactions** → sync is eventually consistent.

## Why use this

- **Local-first & fast** — writes hit local SQLite; the network is never on the critical path.
- **End-to-end encrypted** — AES-256-GCM on-device; the relay only ever holds ciphertext + routing metadata.
- **No lock-in** — the relay is a few hundred lines that run anywhere (Go / Bun / Cloudflare) over plain SQLite.
- **No accounts to phish** — identity derives from one secret (a recovery key or a BIP39 phrase).
- **A real database** — typed schema, [Kysely](https://kysely.dev) queries (joins, filters, ordering), and a reactive `useQuery` for React.
- **Scales past memory** — keyset-paginated, resumable sync; images sync as tiny manifests with lazily fetched encrypted chunks.

## Good to know

- **Conflicts resolve row-level last-writer-wins** (by an HLC), not field-level.
- **Capability auth, not identity** — anyone with the relay-auth token can sync that owner; no login, no key rotation.
- **Availability, not confidentiality** — a bad relay can stall or reorder sync, never read or forge data ([threat model](./sync.md#threat-model)).
- **Per-owner storage quota** (default 1 GiB) — at the cap the relay returns `413`; reclaim space with compaction or raise it on your own relay ([managing storage](./sync.md#relay-configuration)).
- **Lose the secret, lose the data** — the recovery phrase is the only key.

## Read next

1. **[Client API](./guide.md)** — schema, mutations, reactive queries, React hooks, identity & relays.
2. **[How it works](./architecture.md)** — the on-device model: local SQLite, the clock, the write & read paths.
3. **[Sync & the relay](./sync.md)** — the sync loop, the encrypted envelope, the relay wire protocol & threat model.
4. **[Native clients](./native.md)** — the Swift & Kotlin ports: what's shared, the API surface, and the identity interop boundary.
5. **[Demo](./demo.html)** — a two-device sync demo in your browser.

Also: **[self-hosting a relay](./self-hosting.md)** · **[security & threat model](../../SECURITY.md)**.

## Try it in 30 seconds

```sh
bun install
bun run demo                 # CLI: relay + two clients sync, one shot

# Or the browser demo, two devices side by side:
bun run relay:go             # terminal 1 — relay on :4100
bun run docs:dev             # terminal 2 — docs + demo on :4200
```

## Components

**On the device** (the part you ship in your app):

| Package | What it is |
| --- | --- |
| `@simplysync/engine` | **The client API** — typed schema, local SQLite store, Kysely queries, mutations, and the sync loop. |
| `@simplysync/react` | React bindings: `SyncProvider`, `useQuery`, `useSyncState`. |
| `@simplysync/protocol` | The crypto/wire primitives the engine builds on: identity, key derivation, AES-GCM envelopes, HLC, blobs. |

**The relay — optional.** Without one, the app is purely local-first and every
edit stays on-device. Add one to sync across devices. It's a dumb, opaque event
store (ciphertext only), and both implementations are wire-identical — pick
one or [self-host](./self-hosting.md):

| Relay | Stack |
| --- | --- |
| `relays/go` | Go + SQLite — canonical self-hosted relay. |
| `relays/cloudflare` | Cloudflare Workers + D1 + R2 — serverless. |

**Reference clients:** `examples/cli` (CLI) and `examples/expo`
(native Expo) — read and copy them. For fully native, JavaScript-free clients
there are clean-room **Swift** (`ports/swift`) and **Kotlin/JVM**
(`ports/kotlin`) ports of the protocol — see
[Native clients](./native.md).

## Credits & prior art

SimplySync is heavily inspired by **[Evolu](https://evolu.dev)**. The typed
schema, [Kysely](https://kysely.dev) queries, BIP39-mnemonic identity,
HLC-timestamped changes, and the reactive `useQuery` all follow trails Evolu
blazed. It's a mature, excellent project — **if you're choosing a local-first
stack, evaluate Evolu first.**

We built our own because we wanted a few specific things:

- **A tiny core you read and copy, not a platform you import.** The protocol is a
  few hundred lines over WebCrypto + `@scure/bip39`; the client is meant to be
  copied into your app and owned, so you can audit every line. (Evolu is a fuller,
  more featureful platform with a larger surface.)
- **A deliberately dumb relay over plain HTTP** (keyset-paginated pull + cursor),
  shipped as three wire-identical implementations — Go, Bun, and Cloudflare — so
  you can self-host on whatever you already run. (Evolu syncs over WebSocket;
  also self-hostable, just more to reimplement.)
- **First-class encrypted binary blobs** — lazy, content-addressed, chunked — for
  image-heavy apps.

The trade-off we accepted: **row-level last-writer-wins** instead of Evolu's finer
**cell-level** merge. If two devices must edit *different fields* of the same row
offline and have both survive, **prefer Evolu.**
