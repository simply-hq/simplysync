# API reference — Swift

The public API of the Swift `SimplySync` engine, grouped by what you are doing. For how they fit together, with examples, see the [Client API](./guide.swift.md) guide.

## Lifecycle

Build the engine, wait for it to open, and shut it down.

| Member | Signature | Notes |
| --- | --- | --- |
| `createSync` | `(SyncEngineDeps) -> (Schema, SyncEngineConfig) -> SyncEngine` | Wire deps once, then build. |
| `engine.ready` | `await engine.ready` | Resolves when DB open + owner loaded. |

## State

Writes land in the local database and sync on their own; queries read it.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.insert` | `(String, [String: SyncValue]) -> MutationResult` | Generates id + system columns. |
| `engine.update` | `(String, [String: SyncValue]) -> MutationResult` | Requires `id`; updates passed fields. |
| `engine.upsert` | `(String, [String: SyncValue]) -> MutationResult` | Insert or update by id. |
| `engine.createQuery` | `(String, [SQLiteValue] = [], as: Row.Type) -> Query<Row>` | Reusable typed query. |
| `engine.loadQuery` | `(Query<Row>) -> [Row]` | One-shot read. |
| `engine.getQueryRows` | `(Query<Row>) -> [Row]` | Cached snapshot. |
| `engine.liveQuery` | `(Query<Row>) -> LiveQuery<Row>` | Reactive result (`useQuery` analog). |
| `engine.subscribeQuery` | `(Query<Row>, () -> Void) -> () -> Void` | Low-level reactive primitive. |

## Identity

The owner, its recovery key, and moving it between devices.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.appOwner` | `await -> AppOwner?` | `{ id, recoveryKey, writeKey, mnemonic? }`. |
| `engine.restoreAppOwner` | `(String, force: Bool) async throws` | Restore from a key/phrase. |
| `engine.resetAppOwner` | `(force: Bool) async throws` | New owner, wipes local data. Refuses unless a relay is confirmed to hold a copy. |

## Sync

Relays, sync status, and diagnostics.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.setTransports` | `([Transport]) -> Void` | Set relays; triggers sync + polling. |
| `engine.sync` | `() async` | Push outbox, pull + apply. |
| `engine.syncState` / `getSyncState()` | `SyncState` | Reactive + synchronous status. |
| `engine.getRelayStatuses` | `() async -> [RelayStatus]` | Per-relay health + storage usage (live `GET /v1/status` probe per relay). |
