# SimplySync — Kotlin / Android source module

A pure-Kotlin port of SimplySync, wire-compatible with the TypeScript
(`@simplysync/protocol`, `@simplysync/engine`) and Swift clients. It interoperates
byte-for-byte against the same relay, so a Kotlin/Android client can join an
existing SimplySync network with no protocol changes.

It ships **two layers**: the protocol core (identity, envelope, HLC, relay client)
and a near-complete port of `@simplysync/engine` — a typed schema, a local SQLite
store, typed `insert`/`update`/`upsert`, reactive `StateFlow` queries (the Compose
`useQuery` analog), owner restore/reset, and the push/pull/last-writer-wins sync
loop. Same developer experience as the React version; see the
[**Client API → Kotlin**](../../../docs/local-first/guide.kotlin.md)
guide.

This module is **pure JVM** (no Android framework dependencies) so it unit-tests
without an emulator and is reusable from Android apps. The default
`JdbcSqliteDriver` is JVM-only; on Android, inject an `android.database`-backed
`SqliteDriver` and a Keystore-backed `SecureStorage`.

## Clone and use the source

```sh
bun run clone kotlin ../my-kotlin-sync
cd ../my-kotlin-sync/apps/todolist/kotlin
./gradlew test
```

To use the cloned module from an Android project, include its source directory:

```kotlin
// settings.gradle.kts
include(":simplysync-kotlin")
project(":simplysync-kotlin").projectDir =
    file("../my-kotlin-sync/apps/todolist/kotlin")
```

```kotlin
// app/build.gradle.kts
dependencies {
    implementation(project(":simplysync-kotlin"))
}
```

`JdbcSqliteDriver` is an optional JVM adapter so Android consumers do not pull
desktop SQLite native binaries. JVM apps using that adapter add:

```kotlin
runtimeOnly("org.xerial:sqlite-jdbc:3.45.3.0")
```

## What's in the box

| File | Role |
| --- | --- |
| `Base64Url.kt` | RFC 4648 §5 base64url (no padding) — the only wire encoding. |
| `CanonicalJson.kt` | Deterministic, `JSON.stringify`-compatible canonical JSON (the AES-GCM AAD/plaintext bytes). |
| `Crypto.kt` | HMAC-SHA256/512, HKDF `deriveBytes`, SLIP-21, AES-256-GCM, PBKDF2 (minSdk-24 safe). |
| `Bip39.kt` / `Bip39Wordlist.kt` | BIP39 English decode/validate + mnemonic generation. |
| `Identity.kt` | Versioned identity derivation. New phrases use the cross-platform `SimplySync` SLIP-21 profile; the `Evolu` legacy profile keeps existing Android owners recoverable. |
| `Hlc.kt` | Hybrid Logical Clock string + monotonic clock (send/receive/seed). |
| `Envelope.kt` | The on-the-wire `SyncEnvelope` (AES-256-GCM, ct‖tag) + `SyncPayload`. |
| `RelayClient.kt` | `POST/GET /v1/events` over OkHttp with the `relayAuth` bearer token. |
| `SnapshotCrypto.kt` | Encrypted DB-snapshot envelope (recovery-phrase + passphrase keyings). |

Plus the **engine layer** (the `@simplysync/engine` port):

| File | Role |
| --- | --- |
| `Schema.kt` | Typed schema DSL (`Column.id`/`nonEmptyString`/`finiteNumber`/`nullable`, …) + system columns. |
| `SqliteDriver.kt` | `SqliteDriver` interface + a JDBC-backed `JdbcSqliteDriver` (no Android dep). |
| `SecureStorage.kt` | `SecureStorage` interface + an in-memory impl. |
| `Store.kt` | DDL + system columns, `_sync_*` tables, `writeRow`, value coercion. |
| `Query.kt` | `Query<T>` + a reactive cache. |
| `EngineTypes.kt` | `MutationResult`, `AppOwner`, `SyncState`, `Transport`, config/deps. |
| `SyncEngine.kt` | Mutations, typed reactive `StateFlow` queries, sync loop, owner restore/reset. |

## Build & test

```sh
./gradlew test                                           # local engine + protocol tests
./gradlew test -PrelayUrl=https://your-relay.workers.dev # + live two-device interop
```

`SyncKitTest.kt` covers the protocol (canonical BIP39 vector, current and legacy
identity profiles, envelope round-trips, snapshot crypto, HLC, canonical JSON,
PBKDF2). `EngineTest.kt` covers the engine: schema → DDL, mutations, identity
upgrade detection, typed reactive queries, soft deletes, validation, and a live
two-device round-trip.

## Using it

Most app code uses the engine — define a schema, then read and write:

```kotlin
val schema = Schema(mapOf("todo" to mapOf(
    "id" to Column.id("todo"), "title" to Column.nonEmptyString, "done" to Column.sqliteBoolean,
)))
val engine = createSync(SyncEngineDeps(
    makeDriver = { JdbcSqliteDriver(dbPath(it)) },   // Android: an android.database driver
    secureStorage = secureStorage,
))(schema, SyncEngineConfig(name = "todos", transports = emptyList()))
engine.ready()

engine.insert("todo", "title" to "Buy milk", "done" to false)

val q = engine.createQuery("""select id, title, done from "todo" where "isDeleted" = 0""") {
    Triple(it.string("id"), it.string("title"), it.boolean("done"))
}
val todos: StateFlow<List<Triple<String, String, Boolean>>> = engine.liveQuery(q) // collect in Compose
```

Add the HTTPS URL from the [Cloudflare relay
setup](../../../docs/local-first/self-hosting.md) with `engine.setTransports(...)`
when you are ready to sync.

`SyncEngineConfig.schemaVersion` defaults to `1`. Keep it there for additive
tables/columns; bump it only for an incompatible payload-meaning change. Older
clients retain higher-version events and replay them after an upgrade declares
support.

The protocol core stays usable directly if you want the low-level path
(`IdentityDeriver` / `Envelope` / `RelayClient`). It is the **pinned** part: update
it wholesale, don't fork it, or clients can't sync with each other.

Mnemonic identities are versioned. The one-argument `IdentityDeriver` API and
new databases use `MnemonicIdentityProfile.SIMPLYSYNC_V1`, matching TypeScript
and Swift. The engine preserves pre-profile Android databases by recording the
chosen profile and recognizing existing legacy rows/outbox envelopes. Restore
also probes both profiles when a relay is configured. If an app knows it must
open an Evolu-derived phrase, it can pass
`MnemonicIdentityProfile.EVOLU_LEGACY_V1` explicitly in `SyncEngineConfig` or the
three-argument `restoreAppOwner` overload.

## License

[MIT](../../../LICENSE) © 2026 Jerico Pulvera.
