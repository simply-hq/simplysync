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

## Try the demo

You need [Bun](https://bun.sh/) and Go 1.25 or newer.

```sh
bun install
bun run demo
```

The demo starts a local relay, syncs two example clients, shows their decrypted
local state and an unreadable relay message, then shuts everything down.

For a visual, two-device browser demo:

```sh
# Terminal 1
bun run relay:go

# Terminal 2
bun run docs:dev
```

Then open <http://localhost:4200> and choose **Demo**.

For the Expo example, keep the relay running and use `bun run expo`.

## Choose your next step

| I want to… | Start here |
| --- | --- |
| Understand the idea and its limits | [What is SimplySync?](docs/local-first/README.md) |
| Add SimplySync to a TypeScript or React app | [Client API guide](docs/local-first/guide.md) |
| See the smallest working client | [CLI example](examples/cli) |
| See a complete app | [AI chat example](examples/ai-chat) |
| Build for Expo | [Expo example](examples/expo) |
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
| [Swift client](ports/swift) | Native, JavaScript-free Swift protocol and engine implementation. |
| [Kotlin client](ports/kotlin) | Native, JavaScript-free Kotlin/JVM protocol and engine implementation. |

Your schema, interface, React components, and relay configuration remain
app-specific and can evolve independently.

### Relays

A relay is needed only for syncing between devices. Both implementations store
encrypted data rather than readable app content.

| Relay | Purpose |
| --- | --- |
| [Go relay](relays/go) | Canonical self-hosted relay using Go and SQLite. |
| [Cloudflare relay](relays/cloudflare) | Serverless relay using Cloudflare Workers, D1, and R2. |

### Examples and tests

| Project | Purpose |
| --- | --- |
| [CLI example](examples/cli) | Small reference client and one-shot two-client demo. |
| [Expo example](examples/expo) | Mobile example using Expo SQLite and secure device storage. |
| [AI chat example](examples/ai-chat) | Complete local-first application built on the engine. |
| [Compatibility tests](tests) | Confirms that relays and clients follow the same protocol. |

## Privacy and security

SimplySync is designed so the relay does not receive the user's readable data,
encryption key, or recovery phrase.

- Data is encrypted on the device with AES-256-GCM.
- The relay stores encrypted payloads plus the small amount of routing metadata
  required to sync them.
- The relay stores a SHA-256 hash of its authentication token, not the token
  itself.
- Self-hosted and hosted relays use the same protocol, so changing providers
  does not weaken encryption.

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
6. [Self-hosting a relay](docs/local-first/self-hosting.md)

Run `bun run docs:dev` to view the documentation site and browser demo locally.
The repository's reconstructed public timeline is explained in
[Project history](HISTORY.md).

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
