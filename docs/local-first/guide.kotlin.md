# Client API — Kotlin

The Kotlin client is `com.simplysync.kotlin`, in
[`apps/simplysync-android-kotlin`](../../apps/simplysync-android-kotlin/README.md).
It's the **protocol core** as a pure-JVM library — no Android framework
dependencies, no JavaScript. You own the local store and the sync loop; the
library gives you identity, the encrypted envelope, the Hybrid Logical Clock, the
relay client, and the encrypted DB-snapshot format — wire-compatible with the
TypeScript and Swift clients.

> New here? Read **[Native clients](./native.md)** for the big picture — and
> especially the
> **[identity interop boundary](./native.md#identity-derivation-the-interop-boundary)**,
> because Kotlin pins **different BIP39 paths** than TS/Swift (see §1). This page
> is the step-by-step API; the [React/TypeScript guide](./guide.html) is the
> engine equivalent.

## Mental model

- **Your local store is the source of truth.** Reads come from it; writes land in
  it first, so the app is fully usable offline. The library doesn't ship a store —
  you bring one (on Android, SQLite).
- **Every write also produces an encrypted envelope.** You encrypt a `SyncPayload`
  into a `SyncEnvelope` and queue it for the relay.
- **Sync is push + pull.** Push your envelopes, pull others', decrypt them, and
  apply **last-writer-wins** by HLC.
- **The relay only sees ciphertext.** All crypto runs on-device (JCE primitives,
  minSdk-24 safe).

```
 write ──▶ local row (your store)         ──▶ UI reads it (instant)
       └─▶ Envelope.encrypt ──▶ outbox ──▶ RelayClient.push

 RelayClient.pull ──▶ Envelope.decrypt ──▶ apply LWW (Hlc.compare) ──▶ local row
```

There is **no schema DSL, no Kysely, no reactive queries** — those are the
TypeScript engine. You write plain Kotlin models and your own SQL.

## Add the dependency

The module is pure JVM (depends only on kotlinx-serialization, kotlinx-coroutines,
and OkHttp), so it unit-tests without an emulator and drops into any Android app.
Build and run the suite with:

```sh
cd apps/simplysync-android-kotlin
./gradlew test
```

Treat the protocol core as **pinned** — update it wholesale, don't fork it, or
clients stop being able to sync with each other.

## 1. Derive an identity

A user's whole account derives from one secret — an `sf1_` recovery key or a
24-word BIP39 phrase, auto-detected:

```kotlin
// Generate a fresh native key, or a 24-word phrase, for a new user…
val recoveryKey = IdentityDeriver.createRecoveryKey()   // "sf1_…"
val phrase      = Bip39.generate()                       // 24 words

// …or derive from whatever the user pasted (sf1_ key OR phrase):
val identity = IdentityDeriver.derive(recoveryKeyOrPhrase)

identity.ownerId    // base64url; relay routing + envelope AAD
identity.relayAuth  // bearer token presented to the relay (a capability)
identity.dataKey    // AES-256-GCM key (raw bytes) — never leaves the device
identity.streamKey  // derives the compaction streamId
identity.source     // Source.RECOVERY_KEY | Source.MNEMONIC
identity.mnemonic   // the phrase, if derived from one (show it for backup)
```

Persist only the **secret** (Android Keystore / `EncryptedSharedPreferences`) and
re-derive on launch — never store the derived keys.

> **Interop — read this.** Kotlin deliberately pins its BIP39 SLIP-21 paths to
> `"Evolu"`, **not** `"SimplySync"` (a locked regression test enforces it), so the
> Simply Finance Android migration keeps resolving the same owners. The
> consequence: a 24-word phrase derives a **different owner** here than on
> TS/Swift. To sync a Kotlin client with a web/Expo/Swift client, share an
> **`sf1_` recovery key** (identical HKDF on all three), not a phrase. Full detail
> in the [interop boundary](./native.md#identity-derivation-the-interop-boundary).

## 2. Model a row and its payload

You define your own row type. To sync a change, wrap it in a `SyncPayload` — the
decrypted event body:

```kotlin
data class Todo(
    val id: String,
    val title: String,
    val done: Boolean,
    val updatedAt: String,   // the HLC that stamped the last write
)

val payload = SyncPayload(
    schemaVersion = 1,
    table = "todos",
    op = "upsert",                       // or "delete" (a soft-delete tombstone)
    rowId = todo.id,
    hlc = clock.next(),                  // see §3
    value = mapOf(
        "id" to JsonValue.Str(todo.id),
        "title" to JsonValue.Str(todo.title),
        "done" to JsonValue.Bool(todo.done),
    ),
)
```

`value` is `Map<String, JsonValue>` (`Str` / `IntVal` / `DoubleVal` / `Bool` /
`Null` / `Arr` / `Obj`). **Keep column names lowercase-ASCII** so canonical-JSON
key ordering matches JS `localeCompare` across clients (see `CanonicalJson.kt`).
Deletes are soft: emit `op: "delete"` (or carry an `isDeleted` flag in `value`) so
the deletion propagates and can lose to a later edit — never just drop the row
locally.

## 3. Stamp writes with the clock

Every write needs a monotonic HLC so edits order deterministically across devices:

```kotlin
val clock = HlcClock(deviceId)   // one per device, long-lived, thread-safe
val hlc = clock.next()            // never repeats for this device
```

`HlcClock` bumps a counter within the same millisecond and never goes backward.
Two extras over Swift help you restore the clock across launches and on receive:

```kotlin
clock.seed(millis, counter)   // restore the high-water mark on startup
clock.observe(incomingHlc)    // the HLC "receive" step when applying a pulled event
```

Compare two HLCs with `Hlc.compare(a, b)` → `-1 / 0 / 1` (and `null` always
loses) — that's your last-writer-wins test in §6.

## 4. Encrypt an envelope

```kotlin
val envelope = Envelope.encrypt(
    identity = identity,
    eventId = payload.hlc,        // the engine convention: eventId == hlc
    deviceId = deviceId,
    createdAt = Instant.now().toString(),
    payload = payload,
)
```

This produces a `SyncEnvelope` — AES-256-GCM, the canonical-JSON header as AAD,
everything base64url. Setting `eventId = payload.hlc` is what keeps relay
compaction sound. The envelope is opaque to the relay; see
[the encrypted envelope](./sync.md#the-encrypted-envelope-crypto).

## 5. Push & pull via the relay

```kotlin
val relay = RelayClient(baseUrl, identity.ownerId, identity.relayAuth)

// push() and pull() are suspend fns — call them from a coroutine; they run on Dispatchers.IO.
val pushed = relay.push(outbox)          // idempotent; relay dedupes by (ownerId, eventId)
//   pushed.accepted / pushed.duplicate

val pulled = relay.pull(after = cursor)
//   pulled.events      : List<SyncEnvelope>
//   pulled.nextCursor  : String  — persist it; pass it back next time
```

`RelayClient` is OkHttp under the hood. `after = ""` starts from the beginning —
that's also how a **new device restores**: derive the identity, pull from an empty
cursor, apply. Drive `push`/`pull` from a `WorkManager` job or a foreground poll
loop.

> **Emulator note:** an Android emulator reaches your host relay at
> `http://10.0.2.2:4100`, not `localhost`.

## 6. Apply incoming events (last-writer-wins)

```kotlin
for (env in pulled.events) {
    if (env.eventId in seen) continue                              // dedupe
    val row = Envelope.decrypt(identity, env)                      // verifies owner + GCM
    val local = store.updatedAt(row.table, row.rowId)
    if (Hlc.compare(local, row.hlc) <= 0) {                        // incoming wins ties + newer
        store.apply(row)                                           // upsert, or tombstone if op == "delete"
    }
    clock.observe(row.hlc)                                         // advance the local clock
    seen += env.eventId
}
persistCursor(pulled.nextCursor)
```

`decrypt` rejects envelopes whose `ownerId` ≠ yours before attempting decryption,
and GCM verification fails on any tampering. Applies are idempotent, so re-pulling
is harmless.

## 7. Your local store

The library deliberately stops at the protocol — you bring persistence. On Android
that's SQLite: one table per type plus `updatedAt` (the HLC) and a soft-delete
flag, an outbox of un-pushed envelopes, and a per-relay cursor. The Simply Finance
Android app's `SyncEngine` is the reference implementation of this glue layer.

## 8. Encrypted DB snapshots (relay-free device switch)

`SnapshotCrypto` ports the protocol's encrypted DB-snapshot format — for moving a
whole database to a new device **without** a relay (export → transfer → import).
It encrypts a string (your serialized DB) with AES-256-GCM under one of two
keyings:

```kotlin
// Default: keyed by the recovery phrase (SLIP-21 ["SimplySync","BackupKey"]).
val key = SnapshotCrypto.deriveBackupKeyBytes(recoveryKey)
val env = SnapshotCrypto.encryptStringWithKey(key, snapshotJson, identity.ownerId)
val back = SnapshotCrypto.decryptStringWithKey(key, env)

// Optional: keyed by a user passphrase (PBKDF2-HMAC-SHA256, default 600k iters).
val penv = SnapshotCrypto.encryptStringWithPassphrase("hunter2", snapshotJson)
val pback = SnapshotCrypto.decryptStringWithPassphrase("hunter2", penv)
```

The result is an `EncryptedEnvelopeV1` (`format: "simplysync-db-snapshot"`,
versioned, carrying the nonce/tag and — for the passphrase keying — the KDF
params). This is the one piece of functionality the Kotlin port ships and the
Swift port does not. Binary blobs are **not** ported in either.

## Library API reference

| Type / function | Signature | Notes |
| --- | --- | --- |
| `IdentityDeriver.derive` | `(String) -> Identity` | Auto-detects `sf1_` vs phrase. |
| `IdentityDeriver.createRecoveryKey` | `() -> String` | Fresh `sf1_` key. |
| `Bip39.generate` | `(strengthBits = 256) -> String` | New 24-word phrase. |
| `Identity` | `{ ownerId, relayAuth, dataKey, streamKey, source, mnemonic? }` | Derived; persist only the secret. |
| `SyncPayload` | `{ schemaVersion, table, op, rowId, hlc, value: Map<String, JsonValue> }` | The decrypted body. |
| `Envelope.encrypt` | `(identity, eventId, deviceId, createdAt, payload) -> SyncEnvelope` | AES-GCM; header is AAD. |
| `Envelope.decrypt` | `(identity, envelope) -> SyncPayload` | Verifies owner; GCM-authenticated. |
| `SyncEnvelope` | `{ version, ownerId, eventId, deviceId, nonce, ciphertext, createdAt, streamId? }` | On-the-wire; `@Serializable`. |
| `HlcClock` | `(deviceId)` · `next()` · `seed()` · `observe()` | Monotonic, thread-safe. |
| `Hlc.compare` | `(String?, String) -> Int` | LWW test; `null` loses. |
| `RelayClient` | `(baseUrl, ownerId, relayAuth, pullLimit = 500)` | OkHttp; `suspend` calls. |
| `RelayClient.push` | `suspend (List<SyncEnvelope>) -> PushResult` | `{ accepted, duplicate }`. |
| `RelayClient.pull` | `suspend (after: String) -> PullResult` | `{ events, nextCursor }`. |
| `SnapshotCrypto` | `deriveBackupKeyBytes · encryptStringWithKey/…WithPassphrase (+ decrypt)` | Encrypted DB snapshots. |
| `Crypto` | `deriveBytes · slip21 · hmacSha256/512 · aesGcmSeal/Open · pbkdf2 · randomBytes` | Primitives, if you extend the protocol. |

## Scope & pitfalls

- **Protocol core only.** No schema validation, Kysely, reactive queries, or
  platform drivers — those are the TypeScript engine. You write models and SQL
  yourself.
- **Phrases don't interop with TS/Swift** — Kotlin pins `"Evolu"` BIP39 paths;
  share an `sf1_` key to sync across languages (see §1).
- **Lowercase-ASCII column names** — otherwise canonical-JSON ordering can diverge
  from JS and break cross-client decryption.
- **Don't hard-delete.** Emit a tombstone so the delete syncs and can lose to a
  later edit.
- **`eventId` must equal the HLC** — anything else breaks relay log compaction.
- **Not ported:** binary blobs (the snapshot format *is* ported — see §8).

---

**Next:** [Native clients](./native.md) (the cross-language map & parity rules) ·
[Sync & the relay](./sync.md) (the wire protocol these calls speak).
