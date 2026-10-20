# SimplySync

**Private, offline-friendly sync for apps.**

SimplySync lets an app save data on the user's device first, so it stays fast
and keeps working without an internet connection. When the device comes back
online, SimplySync sends encrypted changes through a relay to the user's other
devices. The relay helps deliver those changes, but cannot read them.

> Think of it as iCloud or Google Drive for an app's data, except the app owns
> the system and the sync service cannot see the contents.

SimplySync is open-source infrastructure for people building apps. It is not a
standalone cloud-drive app for end users.

## How it works

1. **The app saves locally.** Reads and writes happen in a SQLite database on
   the phone, tablet, or computer.
2. **SimplySync encrypts each change.** Readable data never leaves the device.
3. **A relay passes on the encrypted change.** Think of the relay as a mailbox
   that cannot open the letters inside it.
4. **The user's other devices decrypt and save it.** If a device is offline, it
   catches up the next time it connects.

```text
 Phone or laptop                 Optional relay                 Other device
┌───────────────┐            ┌──────────────────┐            ┌───────────────┐
│ Local database│ ─encrypted▶│ Stores and sends│ ─encrypted▶│ Local database│
│ Readable data │ ◀──────────│ unreadable data │ ◀──────────│ Readable data │
└───────────────┘            └──────────────────┘            └───────────────┘
```

In short:

- **Local-first** means the app works from the copy on the device, even offline.
- **End-to-end encrypted** means data is locked before it leaves the device and
  unlocked only on another device with the user's recovery secret.
- A **relay** is the small server that moves encrypted changes between devices.
  It is optional if the app never needs to sync.

## Is SimplySync a good fit?

Use it for private, single-user apps such as notes, journals, personal finance,
health trackers, or other tools that should work offline and sync across a
person's own devices.

Choose a different approach if the app needs:

- live collaboration between several people;
- teams, sharing, roles, or server-managed permissions;
- a server that can search, validate, or act on the user's data; or
- strong, immediate consistency across devices.

SimplySync resolves simultaneous edits at the row level: the latest edit wins.
It is designed for one owner using several devices, not a shared team database.

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

Use `web`, `cli`, `node`, `swift`, `kotlin`, `relay-go`, `relay-cloudflare`, or
`core` in place of `react-native`. From a full checkout,
run `bun run clone --list` to see every preset.

## Explore the complete repository

In a complete repository checkout, start with [Bun](https://bun.sh/):

```sh
bun install
bun run docs:dev
```

Open <http://localhost:4200> and choose **Demo**. Both browser devices work
locally without a relay. Paste the URL from the [Cloudflare self-hosting
guide](docs/local-first/self-hosting.md) when you want to test encrypted sync.

## Choose your next step

| I want to… | Start here |
| --- | --- |
| Understand the idea and its limits | [What is SimplySync?](docs/local-first/README.md) |
| Point a coding agent at SimplySync | [SimplySync for coding agents](docs/local-first/agents.md) |
| Add SimplySync to a TypeScript or React app | [Client API guide](docs/local-first/guide.md) |
| See one app built for every platform | [TodoList](apps/todolist) |
| Run the canonical todo from a terminal | [TodoList CLI](apps/todolist/cli) |
| Build for React Native / Expo | [`@simplysync/react-native`](packages/simplysync-react-native) and the [todo UI](apps/todolist/expo) |
| Build a Raycast extension or Node CLI | [`@simplysync/node`](packages/simplysync-node) |
| Build a native Swift or Kotlin client | [Native client guide](docs/local-first/native.md) |
| Run my own sync service | [Self-hosting guide](docs/local-first/self-hosting.md) |
| Check the privacy and security claims | [Security and threat model](SECURITY.md) |

## What's in this repository

The code is separated by responsibility so an app can use only the pieces it
needs.

### Core engine

These packages define SimplySync's shared data, encryption, and sync behavior:

| Package | Purpose |
| --- | --- |
| [`@simplysync/protocol`](packages/simplysync-protocol) | Shared identity, recovery, encryption, ordering, and wire-format rules. |
| [`@simplysync/engine`](packages/simplysync-engine) | The TypeScript local database, typed queries, mutations, and encrypted sync engine. |

Changes to the protocol must remain compatible across every client. Update or
port it as a whole rather than creating a different wire format for one app.

### Client engines

These packages and ports connect the core engine to a particular app platform.
`@simplysync/react` belongs here; it is a client integration, not part of the
core engine.

| Client | Purpose |
| --- | --- |
| [`@simplysync/react`](packages/simplysync-react) | React context and hooks for queries, sync status, and errors. |
| [`@simplysync/react-native`](packages/simplysync-react-native) | React Native hooks plus Expo SQLite, SecureStore, optional SQLCipher, native crypto, and app-lifecycle wiring. |
| [`@simplysync/browser`](packages/simplysync-browser) | Browser storage, encrypted recovery-secret storage, and a single-writer tab lock. |
| [`@simplysync/node`](packages/simplysync-node) | Built-in `node:sqlite` driver and lifecycle wiring for Raycast, Node CLIs, and desktop commands. |
| [`SimplySync` Swift source module](Package.swift) | Swift package sources with the native engine, SwiftUI `LiveQuery`, Keychain/SQLite adapters, and protocol core. |
| [Kotlin/JVM source module](apps/todolist/kotlin) | Kotlin engine with `StateFlow` queries and Android-injectable storage. |

Your schema, interface, React components, and relay configuration remain
app-specific and can evolve independently.

### Relay

A relay is needed only for syncing between devices. The source-owned deployment
stores encrypted data rather than readable app content.

| Relay | Purpose |
| --- | --- |
| [Go relay](apps/relay-go) | Canonical, self-hostable reference relay: Go + SQLite, ciphertext-only. The implementation SECURITY.md points at to verify the claims. |
| [Cloudflare relay](apps/relay-cloudflare) | Serverless relay using Cloudflare Workers, D1, and R2. |

### Canonical example and tools

| Project | Purpose |
| --- | --- |
| [TodoList](apps/todolist) | The only product example: one schema, owner, and relay across CLI, browser, React Native, Swift, and Kotlin. |
| [Raw protocol tool](tools/protocol-demo) | Low-level envelope/HLC diagnostics for protocol port authors. |
| [Relay conformance tests](apps/relay-conformance) | Checks that relay implementations follow the same contract. |
| [Cross-platform tests](apps/todolist/e2e) | Proves that the TodoList web, Swift, and Kotlin clients converge on the same data. |

## Privacy and security

SimplySync is designed so the relay does not receive the user's readable data,
encryption key, or recovery phrase.

- Data is encrypted on the device with AES-256-GCM.
- The relay stores encrypted payloads plus the small amount of routing metadata
  required to sync them.
- The relay stores a SHA-256 hash of its authentication token, not the token
  itself.
- The Cloudflare relay implements the same ciphertext-only wire contract used
  by every client.

A relay can delay or delete encrypted updates, and it can see routing metadata.
It cannot read valid payloads or silently alter them without clients rejecting
the change. The user's recovery secret is the only way to recover encrypted
data: if it is lost, the data cannot be recovered.

See [Security and Threat Model](SECURITY.md) for the exact guarantees,
limitations, and source files to audit.

## Documentation

1. [What SimplySync is and when to use it](docs/local-first/README.md)
2. [Client API and React guide](docs/local-first/guide.md)
3. [Architecture and local data flow](docs/local-first/architecture.md)
4. [Sync protocol and relay behavior](docs/local-first/sync.md)
5. [Native Swift and Kotlin clients](docs/local-first/native.md)
6. [iCloud sync for Apple apps](docs/local-first/icloud.md)
7. [Self-hosting a relay](docs/local-first/self-hosting.md)
8. [SimplySync for coding agents](docs/local-first/agents.md)

Run `bun run docs:dev` to view the documentation site and browser demo locally.

### Using an AI agent

Point the agent at [`docs/local-first/agents.md`](docs/local-first/agents.md) —
the constraints that cause silent bugs come first, followed by a complete
working app, the platform wiring, and the whole API surface. The docs build also
generates `llms.txt` and `llms-full.txt` (the entire corpus in one fetch), so an
agent can load the reference without crawling. Agents working *on this
repository* instead read [`AGENTS.md`](AGENTS.md). Ask an agent to use the
repo-owned `clone-simplysync` skill for requests such as “give me only the React
Native example.”

## Credits

SimplySync is heavily inspired by [Evolu](https://evolu.dev), an established
MIT-licensed local-first platform. SimplySync is an independent, clean-room
implementation with different design trade-offs, including row-level rather
than cell-level conflict resolution. If you are choosing a local-first stack,
evaluate Evolu too.

Read [Credits and prior art](docs/local-first/README.md#credits--prior-art) for
the full acknowledgement and comparison.

## License

[MIT](LICENSE) © 2026 Jerico Pulvera. Use it as you see fit.
