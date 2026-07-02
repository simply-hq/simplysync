# Client API — Swift

The Swift client is a **full engine**, not just the protocol core. Like
`@simplysync/engine`, it owns a local SQLite database, a typed schema, the HLC
clock, the outbox, a reactive query cache, and the sync loop — so you call
`insert` / `update` / `query` and bind reactive results into SwiftUI, the same way
the React version works. It lives in
[`apps/simplysync-ios-swift`](../../apps/simplysync-ios-swift/README.md)
(`SimplySyncDemo/Engine/`, built on the `Kit/` protocol port).

> This page mirrors the [React/TypeScript guide](./guide.html) section-for-section.
> For the on-the-wire protocol and the identity interop boundary, see
> [Native clients](./native.md). Pure Foundation + CryptoKit + `SQLite3` — no
> third-party dependencies.

## Mental model

- **The local SQLite database is the source of truth.** Reads come from it; writes
  land in it first, so the app is fully usable offline.
- **Every write also produces an encrypted sync event.** The engine queues it in a
  local outbox and pushes it when a relay is configured and reachable.
- **Sync is automatic and opportunistic.** The engine polls, pushes the outbox,
  pulls remote events, decrypts them, and applies them last-writer-wins. You
  rarely call `sync()` yourself.
- **Queries are reactive.** A `LiveQuery` republishes its rows when the data it
  depends on changes — from a local write *or* an incoming sync.

```
 engine.insert(...) ──▶ local SQLite row  ──▶ LiveQuery.rows updates (instant)
                   └──▶ encrypted envelope ──▶ outbox ──▶ relay (background)

 relay ──▶ pull + decrypt ──▶ apply (last-writer-wins) ──▶ LiveQuery.rows updates
```

## Add the engine

Copy `SimplySyncDemo/Engine/*.swift` and `SimplySyncDemo/Kit/*.swift` into your
app (the demo's layout), or build them as a local Swift package. The engine is
pure Foundation + Combine + CryptoKit + `SQLite3` (in the iOS/macOS SDK), so there
are no external dependencies and it also runs on macOS.

## 1. Define a schema

A schema is `{ table: { column: Column } }`. Column types come from the engine's
typed DSL and double as runtime validators.

```swift
let appSchema = Schema([
    "category": [
        "id": .id("category"),
        "name": .nonEmptyString,
    ],
    "entry": [
        "id": .id("entry"),
        "description": .nonEmptyString,
        "amountCents": .finiteNumber,
        "categoryId": .nullable(.id("category")), // nullable foreign key
    ],
])
```

You declare `id` per table. The engine adds three **system columns** to every
table automatically: `createdAt`, `updatedAt` (ISO/HLC strings), and `isDeleted`
(a `0 | 1` SQLite boolean). You never write `CREATE TABLE` — the engine derives it.

**Built-in column types:** `.string`, `.nonEmptyString`, `.nonEmptyString1000`,
`.positiveInt`, `.finiteNumber`, `.sqliteBoolean`, `.simpleName`, `.mnemonic`, and
`.id("Table")`. Wrap any with `.nullable(...)` to allow `null`, or
`.maxLength(n, ...)` to bound a string. Each validates on write and rejects bad
values with a typed message.

## 2. Create the engine

`createSync(deps)` takes the platform plumbing once, then returns a factory you
call with your schema and config — exactly like the TS `createSync(deps)(schema,
config)`.

```swift
let deps = SyncEngineDeps(
    makeDriver: { name in try SQLite3Driver(path: dbPath(name)) }, // platform SQLite (§8)
    secureStorage: KeychainStorage(),                              // OS secret store (§8)
    reloadApp: { /* re-evaluate app state after restore/reset */ })

let engine = createSync(deps)(appSchema, SyncEngineConfig(
    name: "my-app",
    transports: [Transport(url: "http://localhost:4100")], // optional relay
    syncIntervalMs: 3000))                                  // poll cadence

await engine.ready // resolves once the DB is open and the owner is loaded
```

On first run the engine mints a new owner (a fresh `sf1_` recovery key, stored via
`secureStorage`). On later runs it loads the existing one.

## 3. Writing data

Mutations are synchronous against local SQLite and return a `MutationResult`. Each
also enqueues an encrypted envelope for sync — you don't manage that. Column values
are `[String: SyncValue]`, and Swift literals work directly.

```swift
// insert — the engine generates the id and system columns
let result = engine.insert("entry", [
    "description": "Coffee",
    "amountCents": -450,
    "categoryId": nil,
])
switch result {
case .ok(let id): print(id)
case .failure(let message): print(message)
}

// update — requires the id; updates only the fields you pass
_ = engine.update("entry", ["id": .string(id), "amountCents": -500])

// upsert — insert or update by id
_ = engine.upsert("entry", ["id": .string(id), "description": "Latte"])
```

**Deletes are soft.** Set the `isDeleted` system column and filter it out in your
queries:

```swift
_ = engine.update("entry", ["id": .string(id), "isDeleted": sqliteTrue])
```

Values are validated against the schema, so an invalid write returns
`.failure(message:)` rather than corrupting the row.

## 4. Querying data

Build a query once with `createQuery` from SQL plus the row type to decode into
(any `Decodable` struct). Double-quote table names so the reactive cache knows
which writes affect the query.

```swift
struct EntryRow: Decodable, Identifiable {
    let id: String
    let description: String
    let amountCents: Double
    let categoryName: String?
}

let entriesQuery = engine.createQuery("""
    select e.id as id, e.description as description, e.amountCents as amountCents,
           c.name as categoryName
    from "entry" e
    left join "category" c on c.id = e.categoryId
    where e."isDeleted" = 0
    order by e."createdAt" desc
""", as: EntryRow.self)

let rows = engine.loadQuery(entriesQuery)     // one-shot read → [EntryRow]
let cached = engine.getQueryRows(entriesQuery) // cached snapshot
```

## 5. Reactive queries in SwiftUI

`engine.liveQuery(query)` returns a `LiveQuery` — the Swift analog of React's
`useQuery`. It's an `ObservableObject` whose `rows` republishes on the main thread
whenever a local write or an incoming sync changes the data. The engine is itself
an `ObservableObject`, so `engine.syncState` drives status UI.

```swift
struct Ledger: View {
    @ObservedObject var engine: SyncEngine
    @StateObject private var entries: LiveQuery<EntryRow>

    init(engine: SyncEngine) {
        self.engine = engine
        _entries = StateObject(wrappedValue: engine.liveQuery(entriesQuery))
    }

    var body: some View {
        VStack {
            SyncBadge(state: engine.syncState)              // re-renders on sync state change
            Button("Add") {
                _ = engine.insert("entry", ["description": "Tea", "amountCents": -300])
            }
            List(entries.rows) { e in                        // re-renders on any relevant change
                Text("\(e.description): \(e.amountCents)")
            }
        }
    }
}
```

- **`engine.liveQuery(q)`** → a `LiveQuery<Row>`; read `.rows`. Updates on a local
  write *or* an incoming sync.
- **`engine.syncState`** — the current `SyncState` (§7), published for SwiftUI.
- **`engine.subscribeQuery(q) { … }`** — the low-level listener `liveQuery` wraps.

## 6. Identity & recovery

A user's whole account derives from one secret. The engine manages it through
`secureStorage` and exposes the owner:

```swift
let owner = await engine.appOwner        // AppOwner? (or engine.currentOwner, sync)
owner?.id          // public owner id used for relay routing
owner?.recoveryKey // the secret to back up — an sf1_ key or a 24-word phrase
owner?.writeKey    // bearer token presented to the relay (a capability)
owner?.mnemonic    // the 24-word phrase, if the owner was derived from one
```

Surface `owner.recoveryKey` during onboarding so the user can save it. It is the
**only** thing that can decrypt their data — lose it and the data is unrecoverable
by design. The engine keeps it in the Keychain, never in plain SQLite.

**Restore on a new device** — boot with the saved secret and sync from scratch:

```swift
try await engine.restoreAppOwner(recoveryKey)
// By default this refuses to wipe local data unless the relay confirms the owner
// has data, so a wrong key or an unreachable relay can't destroy what's here.
try await engine.restoreAppOwner(recoveryKey, force: true) // intentional switch
```

**Reset** mints a brand-new owner and wipes local data:

```swift
await engine.resetAppOwner()
```

Both call your `reloadApp` afterward so the UI re-evaluates against the new owner.

## 7. Connecting a relay & sync state

A relay is **optional** — without one the app is purely local-first. Configure one
(or several) via `transports`, at creation or at runtime:

```swift
engine.setTransports([Transport(url: "https://relay.example.com")])
```

Setting transports triggers an immediate sync and starts the background poller.
You can still force a sync (e.g. a "Sync now" button):

```swift
await engine.sync() // push the outbox, then pull + apply remote events
```

The engine also syncs opportunistically after local writes. Watch progress with
`engine.syncState` (`getSyncState()` for a synchronous read):

| `SyncState` | Meaning |
| --- | --- |
| `.initial` | Idle, nothing synced yet. |
| `.syncing` | A push/pull is in flight. |
| `.synced(lastSyncedAt:)` | Up to date. |
| `.notSynced(error:terminal:status:)` | Failed. |

A **terminal** failure (auth/quota/bad request — 400/401/403/413) won't fix itself
by retrying the same batch, so the engine backs the poller off (still retrying on
the next explicit `sync()`). Network and 5xx/429 errors retry at the normal cadence.

With multiple relays, every one receives a full copy of the outbox and
`syncState` stays `.synced` while **any** relay works. For the per-relay truth —
which relay is failing, and how full each one is against its per-owner storage
quota — use `getRelayStatuses()` (one `GET /v1/status` probe per relay):

```swift
for s in await engine.getRelayStatuses() {
    print(s.url, s.reachable, "\(s.usedBytes ?? 0)/\(s.quotaBytes ?? 0) bytes")
}
```

> **For Android emulators** the React guide notes `http://10.0.2.2:4100`; iOS
> simulators reach your Mac at `http://localhost:4100`.

## 8. Platform drivers

The engine is platform-agnostic: you inject a SQLite driver and a secret store.

**`SqliteDriver`** — a thin synchronous wrapper over the platform's SQLite:

```swift
protocol SqliteDriver: AnyObject {
    func exec(_ sql: String, _ params: [SQLiteValue]) throws
    func select(_ sql: String, _ params: [SQLiteValue]) throws -> [SQLiteRow]
    func transaction<T>(_ body: () throws -> T) throws -> T
}
```

`SQLite3Driver(path:)` is the bundled libsqlite3 implementation (`":memory:"` for
tests). 

**`SecureStorage`** — stores the recovery secret in the OS secret store:

```swift
protocol SecureStorage: AnyObject {
    func getItem(_ key: String) -> String?
    func setItem(_ key: String, _ value: String)
    func removeItem(_ key: String)
}
```

`KeychainStorage()` is the default; `InMemorySecureStorage()` is for tests.

## Engine API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `createSync` | `(SyncEngineDeps) -> (Schema, SyncEngineConfig) -> SyncEngine` | Wire deps once, then build. |
| `engine.ready` | `await engine.ready` | Resolves when DB open + owner loaded. |
| `engine.insert` | `(String, [String: SyncValue]) -> MutationResult` | Generates id + system columns. |
| `engine.update` | `(String, [String: SyncValue]) -> MutationResult` | Requires `id`; updates passed fields. |
| `engine.upsert` | `(String, [String: SyncValue]) -> MutationResult` | Insert or update by id. |
| `engine.createQuery` | `(String, [SQLiteValue] = [], as: Row.Type) -> Query<Row>` | Reusable typed query. |
| `engine.loadQuery` | `(Query<Row>) -> [Row]` | One-shot read. |
| `engine.getQueryRows` | `(Query<Row>) -> [Row]` | Cached snapshot. |
| `engine.liveQuery` | `(Query<Row>) -> LiveQuery<Row>` | Reactive result (`useQuery` analog). |
| `engine.subscribeQuery` | `(Query<Row>, () -> Void) -> () -> Void` | Low-level reactive primitive. |
| `engine.appOwner` | `await -> AppOwner?` | `{ id, recoveryKey, writeKey, mnemonic? }`. |
| `engine.restoreAppOwner` | `(String, force: Bool) async throws` | Restore from a key/phrase. |
| `engine.resetAppOwner` | `() async` | New owner, wipes local data. |
| `engine.setTransports` | `([Transport]) -> Void` | Set relays; triggers sync + polling. |
| `engine.sync` | `() async` | Push outbox, pull + apply. |
| `engine.syncState` / `getSyncState()` | `SyncState` | Reactive + synchronous status. |
| `engine.getRelayStatuses` | `() async -> [RelayStatus]` | Per-relay health + storage usage (live `GET /v1/status` probe per relay). |

## Differences from the React engine

- **Raw SQL, not Kysely.** `createQuery` takes a SQL string + a `Decodable` row
  type instead of a typed query builder. The reactive cache (table extraction,
  refresh-on-change) works the same way.
- **`LiveQuery` / `ObservableObject`, not hooks.** SwiftUI observes `LiveQuery.rows`
  and `engine.syncState` instead of `useQuery` / `useSyncState`.
- **Not ported:** encrypted DB export/import (snapshot), legacy import, binary
  blobs, and the fluent index builder. The protocol, schema, mutations, queries,
  identity, relay sync, and LWW are all here.
- **Identity interoperates by `sf1_` key and phrase** — Swift uses the same
  SLIP-21 labels as the TS protocol (`"SimplySync"`); see the
  [interop boundary](./native.md#identity-derivation-the-interop-boundary).

## Common pitfalls

- **Quote table names in SQL** (`from "entry"`) so the reactive cache can tell
  which writes refresh a query.
- **Filter `isDeleted`.** Soft-deleted rows stay in the table; add
  `where "isDeleted" = 0` to queries that should hide them.
- **Make row fields match what you insert.** A non-optional `Bool` field over a
  column you left `NULL` will fail to decode and the row is dropped — provide the
  value or make the field optional.
- **Keep column names lowercase-ASCII** so canonical-JSON ordering matches the
  other clients (see [parity rules](./native.md#parity-rules-what-must-stay-byte-identical)).
- **Don't hard-delete.** Use soft deletes so a delete can lose to a later edit and
  propagate to other devices.

---

**Next:** [Native clients](./native.md) (the cross-language map & interop
boundary) · [Sync & the relay](./sync.md) (the wire protocol the engine speaks).
