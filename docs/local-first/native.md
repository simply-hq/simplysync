# Native clients (Swift & Kotlin)

The engine and React bindings are TypeScript, but **the protocol isn't** — it's a
few hundred lines of standard crypto over a tiny HTTP wire format. So a fully
native app can join the same sync network without a JavaScript runtime. Two
clean-room ports live in the repo and are byte-verified against the canonical
`@simplysync/protocol`:

| Port | Path | Shape |
| --- | --- | --- |
| **Swift** (`SimplySync`) | [`Package.swift`](../../Package.swift) · [guide](../../apps/todolist/swift/README.md) | SwiftPM library: Foundation + CryptoKit + `SQLite3`, engine + SwiftUI `LiveQuery`; also runs on macOS. |
| **Kotlin / JVM** | [`apps/todolist/kotlin`](../../apps/todolist/kotlin/README.md) | Source-owned pure JVM module with `StateFlow`; Android injects platform storage. |

This page is the cross-language reference: why interop works, what each port
covers, the exact API surface, and — importantly — the **one place identity
derivation diverges**, so you know which secrets sync across which clients.

## Why a native client can interoperate

Everything rests on the same guarantee the rest of these docs are built on: **the
relay only ever sees ciphertext.** It never holds keys or plaintext, so a native
client doesn't have to reimplement the engine — it only has to speak the same
bytes on the wire. Concretely, three things must match the TypeScript
implementation exactly:

- **Identity** — derive `ownerId`, `relayAuth` (the bearer token), the AES data
  key, and the `streamKey` from one secret. Auto-detected from an `sf1_` recovery
  key (HKDF-SHA256) or a 24-word BIP39 phrase (SLIP-21), exactly like
  `deriveIdentity`.
- **Envelope** — AES-256-GCM with the **canonical-JSON** header as additional
  authenticated data, base64url on the wire. See
  [the encrypted envelope](./sync.md#the-encrypted-envelope-crypto).
- **Transport** — `POST` / `GET /v1/events`, `Authorization: Bearer <relayAuth>`,
  an integer-free keyset cursor. See
  [the relay wire protocol](./sync.md#the-relay-wire-protocol).

Get those three byte-identical and a native client and a TypeScript client that
share a secret become the same owner and converge — through any of the
[wire-identical relays](./README.md#components).

## What's ported, what stays app-owned

Both ports include the **protocol core** (identity, envelope, HLC, …) **and** a
port of the *engine* layer — the local SQLite store, the reactive query cache, the
sync loop — so each gives the same schema/mutations/queries DX as the React
version. (Re-read [the three layers](./architecture.md#the-three-layers) for the
split.)

| Layer | TypeScript | Swift | Kotlin |
| --- | --- | --- | --- |
| **Protocol** (identity, envelope, HLC, canonical JSON, BIP39, base64url, relay client) | `@simplysync/protocol` | **Ported** — `Sources/SimplySync/Kit/` | **Ported** — `com.simplysync.kotlin` |
| **Engine** (schema, SQLite store, outbox, sync loop, reactive queries) | `@simplysync/engine` | **Ported** — `Sources/SimplySync/Engine/` ([guide](./guide.swift.md)) | **Ported** — same package ([guide](./guide.kotlin.md)) |
| **Relay** | `apps/relay-*` | Unchanged | Unchanged |

So on the server you port nothing, and both native clients get the full engine
DX. The reactive layer is idiomatic per platform — SwiftUI `LiveQuery`
(`ObservableObject`) in Swift, a `StateFlow` in Kotlin — over the same SQLite store
and sync loop.

## The Swift package — `SimplySync`

`Sources/SimplySync/Kit/` is a clean-room Swift port of `@simplysync/protocol` built on **Foundation
+ CryptoKit only** — no UIKit, no third-party packages — so it also compiles and
runs on macOS and is unit-testable without a simulator. The repository-root
SwiftPM product and the `SimplySyncDemo` SwiftUI app compile that same standard
package source tree.

Use the `swift` selective clone, add its repository root as a local package in
Xcode, and select the `SimplySync` product. The
[Swift README](../../apps/todolist/swift/README.md#clone-and-use-the-source)
has the complete dependency and engine setup.

> For the step-by-step API — derive identity → build a payload → encrypt → push /
> pull → apply — see the **[Client API → Swift](./guide.swift.md)** guide.

| File | Role |
| --- | --- |
| `Base64URL.swift` | RFC 4648 §5 base64url (no padding) — the only wire encoding. |
| `Crypto.swift` | HMAC-SHA256/512, HKDF (`deriveBytes`), SLIP-21, AES-256-GCM, SHA-256, random bytes. |
| `CanonicalJSON.swift` | `JSON.stringify`-compatible canonical form — the AES-GCM AAD and plaintext bytes. |
| `BIP39.swift` / `BIP39Wordlist.swift` | Mnemonic ⇄ entropy + the 2048-word English list. |
| `Identity.swift` | `IdentityDeriver` — `sf1_` (HKDF) and BIP39 (SLIP-21) derivation. |
| `Envelope.swift` | `SyncEnvelope` ⇄ `SyncPayload` (encrypt / decrypt). |
| `HLC.swift` | The Hybrid Logical Clock string + a monotonic `HLCClock`. |
| `RelayClient.swift` | `push` / `pull` against `/v1/events` over `URLSession` (async/await). |

```swift
// Derive once from a recovery key or a 24-word phrase (auto-detected).
let identity = try IdentityDeriver.derive(from: recoveryKeyOrPhrase)
let clock = HLCClock(deviceId: deviceId)
let relay = RelayClient(baseURL: url, ownerId: identity.ownerId, relayAuth: identity.relayAuth)

// Encrypt a row mutation and push it.
let payload = SyncPayload(
    schemaVersion: 1, table: "todo", op: "upsert",
    rowId: rowId, hlc: clock.next(), value: ["title": .string("Buy milk")]
)
let envelope = try Envelope.encrypt(
    identity: identity, eventId: payload.hlc,
    deviceId: deviceId, createdAt: isoNow, payload: payload
)
_ = try await relay.push([envelope])

// Pull + decrypt; apply last-writer-wins with HLC.compare.
let pulled = try await relay.pull(after: cursor)
for env in pulled.events {
    let row = try Envelope.decrypt(identity: identity, envelope: env)
    // overwrite local row only if HLC.compare(localUpdatedAt, row.hlc) <= 0
}
```

Above `Kit/`, `Sources/SimplySync/Engine/` ports `@simplysync/engine`: a typed schema, a real SQLite
store, typed mutations, and reactive `LiveQuery` results — so the example above is
the *low-level* path, and most app code uses the engine instead (see the
[Client API → Swift](./guide.swift.md) guide). Run the demo from Xcode against a
local relay (`bun run relay:go`), then **⋯ → Show recovery key** and paste the
same key into a second simulator, the TodoList web client, or the Expo app to watch them
converge. Full run/verify steps are in the
[Swift README](../../apps/todolist/swift/README.md).

**Not ported (by design):** binary blobs, the encrypted DB export/import (snapshot)
format, and legacy import. Conflict resolution is row-level last-writer-wins by
HLC; delete is a soft delete (`isDeleted`).

## The Kotlin / JVM port

The Kotlin port is **pure JVM** — no Android framework dependencies — so the
crypto unit-tests without an emulator and the same artifact is reusable from any
Android app. It's the protocol core behind the Simply Finance Android build.

The `kotlin` selective clone contains this Gradle source module and its tests.
Android apps include that directory as a local Gradle project; the
[Kotlin README](../../apps/todolist/kotlin/README.md#clone-and-use-the-source)
shows the exact source dependency.

> For the step-by-step API — including snapshot crypto and the phrase-interop
> caveat — see the **[Client API → Kotlin](./guide.kotlin.md)** guide.

| File | Role |
| --- | --- |
| `Base64Url.kt` | RFC 4648 §5 base64url (no padding). |
| `CanonicalJson.kt` | Deterministic, `JSON.stringify`-compatible canonical JSON (the AAD/plaintext bytes). |
| `Crypto.kt` | HMAC-SHA256/512, HKDF `deriveBytes`, SLIP-21, AES-256-GCM, PBKDF2 (minSdk-24 safe). |
| `Bip39.kt` / `Bip39Wordlist.kt` | BIP39 decode/validate **and** mnemonic generation. |
| `Identity.kt` | `IdentityDeriver` — see [the interop boundary](#identity-derivation-the-interop-boundary). |
| `Hlc.kt` | `Hlc` string + a thread-safe `HlcClock` (`next` / `seed` / `observe`). |
| `Envelope.kt` | `SyncEnvelope` (AES-256-GCM, ct‖tag) ⇄ `SyncPayload`. |
| `RelayClient.kt` | `POST` / `GET /v1/events` over OkHttp; `suspend` (coroutines). |
| `SnapshotCrypto.kt` | Encrypted DB-snapshot envelope (recovery-phrase **and** passphrase keyings). |

```kotlin
val identity = IdentityDeriver.derive(recoveryPhraseOrKey)   // 24-word BIP39 or sf1_ key
val clock = HlcClock(deviceId)
val relay = RelayClient(baseUrl, identity.ownerId, identity.relayAuth)

// Encrypt a row mutation and push it.
val payload = SyncPayload(1, "todos", "upsert", rowId, clock.next(), columns)
val envelope = Envelope.encrypt(identity, payload.hlc, deviceId, createdAtIso, payload)
relay.push(listOf(envelope))

// Pull + decrypt; last-writer-wins by Hlc.compare.
val pulled = relay.pull(after = cursor)
pulled.events.forEach { Envelope.decrypt(identity, it) }
```

This module is **library-only** — no UI. Above the protocol core it ships a port
of `@simplysync/engine`: a typed schema, a SQLite store, typed mutations, and
reactive `StateFlow` queries (the example above is the *low-level* path; most app
code uses the engine — see the [Client API → Kotlin](./guide.kotlin.md) guide).
The default `JdbcSqliteDriver` keeps the module pure-JVM and emulator-free for
tests; an Android app injects its own `android.database`-backed driver. Treat the
protocol core as pinned: **update it wholesale, don't fork it**, or clients stop
being able to sync with each other.

**Extra over Swift:** `SnapshotCrypto` ports the encrypted DB-snapshot format for
relay-free device switches — AES-256-GCM keyed either by the recovery phrase
(`deriveBackupKeyBytes`, SLIP-21 `["SimplySync","BackupKey"]`) or by a passphrase
(PBKDF2-HMAC-SHA256, default 600k iterations). **Not ported:** binary blobs.

## Identity derivation & the interop boundary

This is the one subtlety to get right. Two secret encodings derive an identity,
and they interoperate differently:

| Secret | Scheme | TypeScript | Swift | Kotlin |
| --- | --- | --- | --- | --- |
| `sf1_` recovery key | HKDF-SHA256, labels `owner-id` · `data-key` · `relay-auth` · `stream-key` | ✓ | ✓ | ✓ |
| 24-word BIP39 phrase | SLIP-21 path prefix | `SimplySync` | `SimplySync` | `SimplySync` (default) · `Evolu` (legacy profile) |

- **`sf1_` recovery keys interoperate everywhere.** All three derive `ownerId` /
  `dataKey` / `relayAuth` / `streamKey` with byte-identical HKDF labels, so a key
  generated on any client resolves to the same owner on every other.
- **New BIP39 phrases interoperate everywhere.** The one-argument Kotlin API uses
  the same `"SimplySync"` prefix as TypeScript and Swift.
- **Existing Android owners stay existing owners.** Older Simply Finance builds
  used Evolu's prefix. Kotlin retains that derivation as
  `MnemonicIdentityProfile.EVOLU_LEGACY_V1`; the engine persists the selected
  profile, recognizes an existing outbox/local database, and probes both profiles
  when restoring from a relay. An upgrade therefore does not silently strand the
  prior local or remote owner.

> The Evolu profile is a Kotlin migration profile, not the cross-platform
> default. For a brand-new multi-platform app, use the default `SimplySync`
> profile or an **`sf1_` recovery key**. An app intentionally opening an old
> Android owner can select `EVOLU_LEGACY_V1` explicitly; TypeScript and Swift do
> not currently expose that legacy profile.

Everything below the secret — the AES-GCM envelope, canonical JSON, the
`streamId` grouping key, the HLC encoding, the wire protocol — is shared verbatim,
so once two clients agree on an owner they converge regardless of language.

## Cross-language primitive map

The same concept, three names. Useful when reading one port against another or
against the [protocol source](../../packages/simplysync-protocol).

| Concept | TypeScript | Swift | Kotlin |
| --- | --- | --- | --- |
| Derive identity | `deriveIdentity(secret)` | `IdentityDeriver.derive(from:)` | `IdentityDeriver.derive(...)` |
| New recovery key | `createRecoveryKey()` | `IdentityDeriver.createRecoveryKey()` | `IdentityDeriver.createRecoveryKey()` |
| New mnemonic | `createMnemonic()` | — | `Bip39.generate()` |
| Encrypt event | `encryptPayload(...)` | `Envelope.encrypt(identity:…)` | `Envelope.encrypt(identity, …)` |
| Decrypt event | `decryptEnvelope(...)` | `Envelope.decrypt(identity:envelope:)` | `Envelope.decrypt(identity, envelope)` |
| HLC make / compare | `createHlc` / `compareHlc` | `HLC.make` / `HLC.compare` | `Hlc.make` / `Hlc.compare` |
| Monotonic clock | engine-internal | `HLCClock.next()` | `HlcClock.next()` |
| Push / pull | engine sync loop | `RelayClient.push` / `.pull` | `RelayClient.push` / `.pull` |
| Encrypted DB snapshot | `snapshot-crypto.ts` | — (not ported) | `SnapshotCrypto` |
| Define a schema | `{ table: { col: Type } }` | `Schema([...])` | `Schema(mapOf(...))` |
| Create the engine | `createSync(deps)(schema, cfg)` | `createSync(deps)(schema, cfg)` | `createSync(deps)(schema, cfg)` |
| Declare payload compatibility | `cfg.schemaVersion` | `cfg.schemaVersion` | `cfg.schemaVersion` |
| Write a row | `engine.insert(...)` | `engine.insert(...)` | `engine.insert(...)` |
| Reactive query | `useQuery(q)` | `engine.liveQuery(q)` → `LiveQuery` | `engine.liveQuery(q)` → `StateFlow` |

## Verification — these aren't "should match," they're checked

Both ports are tested against vectors generated by the **real** TypeScript
protocol, so drift is caught, not hoped against.

**Swift** — host-side, no simulator needed:

```sh
cd apps/todolist/swift
# 1) crypto byte-compatibility vs @simplysync/protocol (verify/vectors.json)
swiftc ../../../Sources/SimplySync/Kit/*.swift verify/main.swift -o /tmp/ssverify && /tmp/ssverify
# 2) live end-to-end against a running relay (push → pull → decrypt)
swiftc ../../../Sources/SimplySync/Kit/*.swift verify/itest/main.swift -o /tmp/ssintegration
/tmp/ssintegration http://localhost:4100
```

**Kotlin** — the JUnit suite covers the canonical BIP39 zero-entropy vector, the
`Evolu` identity-path regression guard, envelope round-trips, `SnapshotCrypto`,
HLC ordering, canonical JSON, and PBKDF2:

```sh
cd apps/todolist/kotlin
./gradlew test
```

## Parity rules — what must stay byte-identical

If you change a port (or add a third language), these are the load-bearing
contracts. Break any one and decryption fails or owners drift:

- **Canonical JSON.** Keys sorted to match JavaScript's raw UTF-16 code-unit
  `<`/`>` comparison; it is both the AES-GCM plaintext *and* the AAD. Keep
  row/column names lowercase-ASCII so ordering matches across runtimes.
- **The AAD is the header.** `{version, ownerId, eventId, deviceId, createdAt,
  streamId?}` as canonical JSON. A relay can't rebind a ciphertext to a different
  event/owner without GCM failing on decrypt.
- **Derivation labels & paths.** The HKDF labels and SLIP-21 paths are part of the
  contract — see [the interop boundary](#identity-derivation-the-interop-boundary).
  Add a new vector, never edit an existing one.
- **Fixed-width HLC.** `base36(millis,10)-base36(counter,4)-deviceId`, so plain
  string order *is* causal order and `eventId = hlc` keeps relay compaction sound.
- **AES-256-GCM, 12-byte random nonce per event**, ciphertext stored as
  `ct‖tag`, everything base64url (no padding) on the wire.

## Read next

- **[Sync & the relay](./sync.md)** — the envelope, the wire protocol, and the
  threat model these ports implement.
- **[How it works](./architecture.md)** — the on-device store + clock the engine
  layer (the part you write natively) owns.
- **[Security](../../SECURITY.md)** — the end-to-end-encryption claim, walked
  through the source.
