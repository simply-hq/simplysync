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

## Quickstart: a source-owned React Native app

<!-- quickstart:react-native:start -->
SimplySync is clone-only: the app owns the exact source it ships. This path
needs Git, Bun, and either Xcode or Android Studio.

```sh
# Clone only Expo/React Native and its source dependencies.
curl -fsSL https://raw.githubusercontent.com/simply-hq/simplysync/main/clone-simplysync.sh |
  sh -s -- react-native simplysync-mobile
cd simplysync-mobile

# Derive your app from the checked-in TodoList client.
sh scaffold-simplysync.sh react-native my-notes
bun install --no-save
bun run build

# iOS Simulator
bun run --cwd apps/my-notes ios

# Android Emulator (use this instead of the iOS command)
bun run --cwd apps/my-notes android
```

If Expo reports that Metro port 8081 is already in use, rerun the same platform
command with `--port 8082`.

The app now writes to its local SQLite database and keeps working offline. Save
the recovery key and choose **I saved this key**.

If you only want the canonical React Native example, skip the scaffold command
and use `apps/todolist/expo` in the launch command.

When you are ready for device-to-device sync, [deploy the Cloudflare
relay](https://simplysync.org/self-hosting). Paste the verified URL it
prints into the app's **Relay URL** setting on each device, then restore the
same recovery key on the second device. Changes will sync through the
ciphertext-only relay.
<!-- quickstart:react-native:end -->

## Why use this

- **Local-first & fast** — writes hit local SQLite; the network is never on the critical path.
- **End-to-end encrypted** — AES-256-GCM on-device; the relay only ever holds ciphertext + routing metadata.
- **No lock-in** — deploy the Cloudflare Workers + D1/R2 relay in your own
  account and keep the source.
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
5. **[For agents](./agents.md)** — the dense contract for coding agents: invariants first, then a complete app and the whole API surface.
6. **[Demo](./demo.html)** — a two-device sync demo in your browser.

Also: **[self-hosting a relay](./self-hosting.md)** · **[security & threat model](../../SECURITY.md)**.

## Components

**On the device** (the part you ship in your app):

| Package | What it is |
| --- | --- |
| `@simplysync/engine` | **The client API** — typed schema, local SQLite store, Kysely queries, mutations, and the sync loop. |
| `@simplysync/react` | React bindings: `SyncProvider`, `useQuery`, `useSyncState`. |
| `@simplysync/react-native` | React Native bindings and Expo SQLite, SecureStore, SQLCipher, crypto, and lifecycle adapters. |
| `@simplysync/node` | Built-in `node:sqlite` driver and lifecycle adapters for Node 22.13+, Raycast, and CLI apps. |
| `@simplysync/protocol` | The crypto/wire primitives the engine builds on: identity, key derivation, AES-GCM envelopes, HLC, blobs. |

**The relay — optional.** Without one, the app is purely local-first and every
edit stays on-device. Add the source-owned Cloudflare relay to sync across
devices; it is a dumb, opaque event store that only receives ciphertext:

| Relay | Stack |
| --- | --- |
| `apps/relay-cloudflare` | Cloudflare Workers + D1 + R2 — serverless. |

**Canonical example:** [`apps/todolist`](../../apps/todolist) groups its CLI,
browser, React Native, Swift, and Kotlin clients around one schema, owner, and
relay. Every face uses the same source-module surface rather than app-specific
sync code. Use the repository's selective clone command to keep only one face
and its dependencies — see [Native clients](./native.md).

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
  deployed in your Cloudflare account with Workers + D1/R2. (Evolu syncs over
  WebSocket; also self-hostable, just more to reimplement.)
- **First-class encrypted binary blobs** — lazy, content-addressed, chunked — for
  image-heavy apps.

The trade-off we accepted: **row-level last-writer-wins** instead of Evolu's finer
**cell-level** merge. If two devices must edit *different fields* of the same row
offline and have both survive, **prefer Evolu.**
