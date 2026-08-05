# Client API — Kotlin

The Kotlin client is a **full engine**, not just the protocol core. Like
`@simplysync/engine`, it owns a local SQLite database, a typed schema, the HLC
clock, the outbox, a reactive query cache, and the sync loop — so you call
`insert` / `update` / `query` and collect reactive results into Compose, the same
way the React version works. It lives in
[`apps/todolist/kotlin`](../../apps/todolist/kotlin/README.md)
(`com.simplysync.kotlin`), built on the protocol port in the same package.

> This page mirrors the [React/TypeScript guide](./guide.md) section-for-section.
> For the on-the-wire protocol and the versioned mnemonic identity migration, see
> [Native clients](./native.md).
> Pure JVM (no Android framework deps), so it unit-tests without an emulator.

## Mental model

- **The local SQLite database is the source of truth.** Reads come from it; writes
  land in it first, so the app is fully usable offline.
- **Every write also produces an encrypted sync event.** The engine queues it in a
  local outbox and pushes it when a relay is configured and reachable.
- **Sync is automatic and opportunistic.** The engine polls, pushes the outbox,
  pulls remote events, decrypts them, and applies them last-writer-wins. You
  rarely call `sync()` yourself.
- **Queries are reactive.** `liveQuery` returns a `StateFlow` that re-emits when
  the rows it depends on change — from a local write *or* an incoming sync.

```
 engine.insert(...) ──▶ local SQLite row  ──▶ liveQuery StateFlow re-emits (instant)
                   └──▶ encrypted envelope ──▶ outbox ──▶ relay (background)

 relay ──▶ pull + decrypt ──▶ apply (last-writer-wins) ──▶ liveQuery StateFlow re-emits
```

## Clone the source module

Use the `kotlin` selective clone preset, then include its directory as a local
Gradle project:

```sh
bun run clone kotlin ../my-kotlin-sync
```

```kotlin
// settings.gradle.kts
include(":simplysync-kotlin")
project(":simplysync-kotlin").projectDir =
    file("../my-kotlin-sync/apps/todolist/kotlin")

// app/build.gradle.kts
dependencies {
    implementation(project(":simplysync-kotlin"))
}
```

It exposes kotlinx-serialization, coroutines, and OkHttp as API dependencies.
Android injects an `android.database` driver. A JVM app using the optional
`JdbcSqliteDriver` also adds
`runtimeOnly("org.xerial:sqlite-jdbc:3.45.3.0")`; desktop SQLite binaries are
deliberately not pulled into Android apps. The
[Kotlin source README](../../apps/todolist/kotlin/README.md#clone-and-use-the-source)
includes the standalone test command.

Treat the protocol core as **pinned** — update it wholesale, don't fork it, or
clients stop being able to sync with each other.

## 1. Define a schema

A schema is `{ table -> { column -> Column } }`. Column types come from the
engine's typed DSL and double as runtime validators.

```kotlin
val appSchema = Schema(mapOf(
    "category" to mapOf(
        "id" to Column.id("category"),
        "name" to Column.nonEmptyString,
    ),
    "entry" to mapOf(
        "id" to Column.id("entry"),
        "description" to Column.nonEmptyString,
        "amountCents" to Column.finiteNumber,
        "categoryId" to Column.nullable(Column.id("category")), // nullable foreign key
    ),
))
```

You declare `id` per table. The engine adds three **system columns** to every
table automatically: `createdAt`, `updatedAt` (ISO/HLC strings), and `isDeleted`
(a `0 | 1` SQLite boolean). You never write `CREATE TABLE`.

**Built-in column types:** `Column.string`, `.nonEmptyString`,
`.nonEmptyString1000`, `.positiveInt`, `.finiteNumber`, `.sqliteBoolean`,
`.simpleName`, `.mnemonic`, and `.id("Table")`. Wrap any with `Column.nullable(...)`
to allow `null`, or `Column.maxLength(n, ...)` to bound a string.

## 2. Create the engine

`createSync(deps)` takes the platform plumbing once, then returns a factory you
call with your schema and config — exactly like the TS `createSync(deps)(schema,
config)`.

```kotlin
val deps = SyncEngineDeps(
    makeDriver = { name -> JdbcSqliteDriver(dbPath(name)) }, // platform SQLite (§8)
    secureStorage = AndroidSecureStorage(context),           // OS secret store (§8)
    reloadApp = { /* re-evaluate app state after restore/reset */ },
)

val engine = createSync(deps)(appSchema, SyncEngineConfig(
    name = "my-app",
    transports = listOf(Transport("http://10.0.2.2:4100")), // optional relay
    syncIntervalMs = 3000,                                    // poll cadence
    schemaVersion = 1,                                        // optional; default 1
))

engine.ready() // suspend: resolves once the DB is open and the owner is loaded
```

Keep `schemaVersion` at `1` for additive table and column changes. Only bump it
when payload meaning changes incompatibly. Older clients durably retain a newer
payload without partially applying it, then replay it after an upgraded app
declares support.

On first run the engine mints a new owner (a fresh `sf1_` recovery key, stored via
`secureStorage`). On later runs it loads the existing one.

## 3. Writing data

Mutations are synchronous against local SQLite and return a `MutationResult`. Each
also enqueues an encrypted envelope for sync. Pass columns as `vararg Pair`s —
`String`, `Int`/`Long`, `Double`, `Boolean`, and `null` are accepted directly.

```kotlin
// insert — the engine generates the id and system columns
val result = engine.insert("entry",
    "description" to "Coffee",
    "amountCents" to -450,
    "categoryId" to null,
)
when (result) {
    is MutationResult.Ok -> println(result.value)
    is MutationResult.Failure -> println(result.message)
}

// update — requires the id; updates only the fields you pass
engine.update("entry", "id" to id, "amountCents" to -500)

// upsert — insert or update by id
engine.upsert("entry", "id" to id, "description" to "Latte")
```

**Deletes are soft.** Set the `isDeleted` system column and filter it out in your
queries:

```kotlin
engine.update("entry", "id" to id, "isDeleted" to sqliteTrue)
```

Values are validated against the schema, so an invalid write returns
`MutationResult.Failure(message)` rather than corrupting the row.

## 4. Querying data

Build a query once with `createQuery` from SQL plus a mapper that turns each `Row`
into a typed value. Double-quote table names so the reactive cache knows which
writes affect the query.

```kotlin
data class EntryRow(val id: String, val description: String, val amountCents: Double, val categoryName: String?)

val entriesQuery = engine.createQuery("""
    select e.id as id, e.description as description, e.amountCents as amountCents,
           c.name as categoryName
    from "entry" e
    left join "category" c on c.id = e.categoryId
    where e."isDeleted" = 0
    order by e."createdAt" desc
""") { row ->
    EntryRow(row.string("id"), row.string("description"), row.double("amountCents"), row.stringOrNull("categoryName"))
}

val rows = engine.loadQuery(entriesQuery)     // one-shot read → List<EntryRow>
val cached = engine.getQueryRows(entriesQuery) // cached snapshot
```

`Row` has typed accessors: `string` / `stringOrNull` / `int` / `long` / `double` /
`boolean` / `has`.

## 5. Reactive queries with Compose

`engine.liveQuery(query)` returns a `StateFlow<List<Row>>` — the Kotlin analog of
React's `useQuery`. It re-emits whenever a local write or an incoming sync changes
the data. `engine.syncState` is a `StateFlow<SyncState>` for status UI.

```kotlin
@Composable
fun Ledger(engine: SyncEngine) {
    val entries by engine.liveQuery(entriesQuery).collectAsState()
    val state by engine.syncState.collectAsState()

    Column {
        SyncBadge(state)
        Button(onClick = { engine.insert("entry", "description" to "Tea", "amountCents" to -300) }) {
            Text("Add")
        }
        LazyColumn {
            items(entries) { e -> Text("${e.description}: ${e.amountCents}") }
        }
    }
}
```

- **`engine.liveQuery(q)`** → `StateFlow<List<Row>>`; collect it. Re-emits on a
  local write *or* an incoming sync. (The flow for a query is shared.)
- **`engine.syncState`** — a `StateFlow<SyncState>` (§7).
- **`engine.subscribeQuery(q) { … }`** — the low-level listener `liveQuery` wraps.

## 6. Identity & recovery

A user's whole account derives from one secret. The engine manages it through
`secureStorage` and exposes the owner:

```kotlin
val owner = engine.appOwner()    // suspend → AppOwner? (or engine.currentOwner)
owner?.id          // public owner id used for relay routing
owner?.recoveryKey // the secret to back up — an sf1_ key or a 24-word phrase
owner?.writeKey    // bearer token presented to the relay (a capability)
owner?.mnemonic    // the 24-word phrase, if the owner was derived from one
```

Surface `owner.recoveryKey` during onboarding so the user can save it — it's the
**only** thing that can decrypt their data.

**Restore on a new device** — boot with the saved secret and sync from scratch:

```kotlin
engine.restoreAppOwner(recoveryKey)               // refuses to wipe unless the relay confirms data
engine.restoreAppOwner(recoveryKey, force = true) // intentional switch to a new/empty owner
```

For a BIP39 phrase, restore probes both the current cross-platform profile and
the older Evolu-derived Android profile, then selects the owner that actually has
relay data. If you already know the profile (including an offline forced
restore), pass it explicitly:

```kotlin
engine.restoreAppOwner(
    phrase,
    MnemonicIdentityProfile.EVOLU_LEGACY_V1,
    force = true,
)
```

**Reset** mints a brand-new owner and wipes local data:

```kotlin
engine.resetAppOwner()
```

Both call your `reloadApp` afterward so the UI re-evaluates against the new owner.

> **Interop and upgrades.** New Kotlin mnemonic identities use the same
> `"SimplySync"` SLIP-21 profile as TS/Swift. Existing Evolu-derived Android
> databases remain on their legacy profile; the engine detects and records that
> choice instead of silently changing owners. Full detail is in the
> [interop boundary](./native.md#identity-derivation-the-interop-boundary).

## 7. Connecting a relay & sync state

A relay is **optional** — without one the app is purely local-first. Configure one
(or several) via `transports`, at creation or at runtime:

```kotlin
engine.setTransports(listOf(Transport("https://relay.example.com")))
```

Setting transports triggers an immediate sync and starts the background poller.
You can still force a sync (`suspend`):

```kotlin
engine.sync() // push the outbox, then pull + apply remote events
```

Watch progress with `engine.syncState` (`getSyncState()` for a synchronous read):

| `SyncState` | Meaning |
| --- | --- |
| `Initial` | Idle, nothing synced yet. |
| `Syncing` | A push/pull is in flight. |
| `Synced(lastSyncedAt)` | Up to date. |
| `NotSynced(error, terminal, status)` | Failed. |

A **terminal** failure (auth/quota/bad request — 400/401/403/413) won't fix itself
by retrying the same batch, so the engine backs the poller off.

With multiple relays, every one receives a full copy of the outbox and
`SyncState` stays `Synced` while **any** relay works. For the per-relay truth —
which relay is failing, and how full each one is against its per-owner storage
quota — use `getRelayStatuses()` (one `GET /v1/status` probe per relay):

```kotlin
for (s in engine.getRelayStatuses()) {  // suspend
    println("${s.url} reachable=${s.reachable} ${s.usedBytes}/${s.quotaBytes} bytes")
}
```

> **For Android emulators** point the relay at `http://10.0.2.2:4100`; a device on
> the LAN uses the host's IP.

## 8. Platform drivers

The engine is platform-agnostic: you inject a SQLite driver and a secret store.

**`SqliteDriver`** — a thin synchronous wrapper over the platform's SQLite:

```kotlin
interface SqliteDriver {
    fun exec(sql: String, params: List<SqliteValue> = emptyList())
    fun select(sql: String, params: List<SqliteValue> = emptyList()): List<Map<String, SqliteValue>>
    fun <T> transaction(body: () -> T): T
}
```

`JdbcSqliteDriver(path)` (libsqlite3-jdbc) is the default for JVM/desktop and the
tests (`":memory:"` for in-memory). On Android, inject a thin
`android.database.sqlite`-backed implementation instead.

**`SecureStorage`** — stores the recovery secret in the OS secret store
(`getItem` / `setItem` / `removeItem`). `InMemorySecureStorage` is for tests; on
Android, back it with the Keystore / `EncryptedSharedPreferences`.

## Engine API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `createSync` | `(SyncEngineDeps) -> (Schema, SyncEngineConfig) -> SyncEngine` | Wire deps once, then build. |
| `engine.ready` | `suspend () -> Unit` | Resolves when DB open + owner loaded. |
| `engine.insert` | `(String, vararg Pair<String, Any?>) -> MutationResult` | Generates id + system columns. |
| `engine.update` | `(String, vararg Pair<String, Any?>) -> MutationResult` | Requires `id`; updates passed fields. |
| `engine.upsert` | `(String, vararg Pair<String, Any?>) -> MutationResult` | Insert or update by id. |
| `engine.createQuery` | `(String, List<SqliteValue> = [], map: (Row) -> T) -> Query<T>` | Reusable typed query. |
| `engine.loadQuery` | `(Query<T>) -> List<T>` | One-shot read. |
| `engine.getQueryRows` | `(Query<T>) -> List<T>` | Cached snapshot. |
| `engine.liveQuery` | `(Query<T>) -> StateFlow<List<T>>` | Reactive result (`useQuery` analog). |
| `engine.appOwner` | `suspend () -> AppOwner?` | `{ id, recoveryKey, writeKey, mnemonic? }`. |
| `engine.restoreAppOwner` | `suspend (String, force: Boolean)` or `(String, MnemonicIdentityProfile, force: Boolean)` | Restore from a key/phrase; mnemonic restore can auto-detect or explicitly select a profile. |
| `engine.resetAppOwner` | `suspend ()` | New owner, wipes local data. |
| `engine.setTransports` | `(List<Transport>)` | Set relays; triggers sync + polling. |
| `engine.sync` | `suspend ()` | Push outbox, pull + apply. |
| `engine.syncState` | `StateFlow<SyncState>` | Reactive status. |
| `engine.getRelayStatuses` | `suspend () -> List<RelayStatus>` | Per-relay health + storage usage (live `GET /v1/status` probe per relay). |

## Differences from the React engine

- **Raw SQL + a row mapper, not Kysely.** `createQuery` takes a SQL string and a
  `(Row) -> T` mapper instead of a typed query builder.
- **`StateFlow`, not hooks.** Compose collects `liveQuery(...).collectAsState()`
  and `syncState.collectAsState()` instead of `useQuery` / `useSyncState`.
- **Not ported:** binary blobs, legacy import, and the fluent index builder. The
  encrypted DB snapshot format *is* ported separately as `SnapshotCrypto`.
- **A legacy mnemonic profile.** New phrases interoperate with TS/Swift; Kotlin
  additionally retains Evolu-derived owners for safe Android upgrades (§6).

## Common pitfalls

- **Quote table names in SQL** (`from "entry"`) so the cache can track which writes
  refresh a query.
- **Filter `isDeleted`.** Soft-deleted rows stay in the table; add
  `where "isDeleted" = 0` to queries that should hide them.
- **Keep column names lowercase-ASCII** so canonical-JSON ordering matches the
  other clients (see [parity rules](./native.md#parity-rules-what-must-stay-byte-identical)).
- **Don't hard-delete.** Use soft deletes so a delete can lose to a later edit and
  propagate to other devices.
- **Android needs its own drivers** — inject an `android.database`-backed
  `SqliteDriver` and a Keystore-backed `SecureStorage`; the bundled JDBC/in-memory
  ones are for JVM and tests.

---

**Next:** [Native clients](./native.md) (the cross-language map & interop
boundary) · [Sync & the relay](./sync.md) (the wire protocol the engine speaks).
