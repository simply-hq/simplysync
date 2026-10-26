# API reference — Kotlin

The public API of the Kotlin engine, grouped by what you are doing. For how they fit together, with examples, see the [Client API](./guide.kotlin.md) guide.

## Lifecycle

Build the engine, wait for it to open, and shut it down.

| Member | Signature | Notes |
| --- | --- | --- |
| `createSync` | `(SyncEngineDeps) -> (Schema, SyncEngineConfig) -> SyncEngine` | Wire deps once, then build. |
| `engine.ready` | `suspend () -> Unit` | Resolves when DB open + owner loaded. |

## State

Writes land in the local database and sync on their own; queries read it.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.insert` | `(String, vararg Pair<String, Any?>) -> MutationResult` | Generates id + system columns. |
| `engine.update` | `(String, vararg Pair<String, Any?>) -> MutationResult` | Requires `id`; updates passed fields. |
| `engine.upsert` | `(String, vararg Pair<String, Any?>) -> MutationResult` | Insert or update by id. |
| `engine.createQuery` | `(String, List<SqliteValue> = [], map: (Row) -> T) -> Query<T>` | Reusable typed query. |
| `engine.loadQuery` | `(Query<T>) -> List<T>` | One-shot read. |
| `engine.getQueryRows` | `(Query<T>) -> List<T>` | Cached snapshot. |
| `engine.liveQuery` | `(Query<T>) -> StateFlow<List<T>>` | Reactive result (`useQuery` analog). |

## Identity

The owner, its recovery key, and moving it between devices.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.appOwner` | `suspend () -> AppOwner?` | `{ id, recoveryKey, writeKey, mnemonic? }`. |
| `engine.restoreAppOwner` | `suspend (String, force: Boolean)` or `(String, MnemonicIdentityProfile, force: Boolean)` | Restore from a key/phrase; mnemonic restore can auto-detect or explicitly select a profile. |
| `engine.resetAppOwner` | `suspend (force: Boolean)` | New owner, wipes local data. Refuses unless a relay is confirmed to hold a copy. |

## Sync

Relays, sync status, and diagnostics.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.setTransports` | `(List<Transport>)` | Set relays; triggers sync + polling. |
| `engine.sync` | `suspend ()` | Push outbox, pull + apply. |
| `engine.syncState` | `StateFlow<SyncState>` | Reactive status. |
| `engine.getRelayStatuses` | `suspend () -> List<RelayStatus>` | Per-relay health + storage usage (live `GET /v1/status` probe per relay). |
