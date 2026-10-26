# API reference

The public API of `@simplysync/engine` and `@simplysync/react`, grouped by what you are doing. For how they fit together, with examples, see the [Client API](./guide.md) guide.

## Lifecycle

Build the engine, wait for it to open, and shut it down.

| Member | Signature | Notes |
| --- | --- | --- |
| `createSync` | `(deps) => (schema, config) => SyncEngine` | Wire platform deps once, then build engines. |
| `engine.ready` | `Promise<void>` | Resolves when the DB is open and owner loaded. |
| `engine.close` | `() => void` | Stop the poller, listeners, and further syncs. Idempotent; local writes still work. |

## State

Writes land in the local database and sync on their own; queries read it.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.insert` | `(table, values, opts?) => MutationResult` | Generates id + system columns. |
| `engine.update` | `(table, values & { id }, opts?) => MutationResult` | Updates passed fields only. |
| `engine.upsert` | `(table, values & { id }, opts?) => MutationResult` | Insert or update by id. |
| `engine.delete` | `(table, id, opts?) => MutationResult` | Soft-delete one row (replicating tombstone). Idempotent. |
| `engine.deleteMany` | `(table, ids, opts?) => BatchResult` | Soft-delete many rows of one table atomically. |
| `engine.batch` | `(ops, opts?) => BatchResult` | Many writes in one transaction, refresh, and sync. All-or-nothing. |
| `engine.purgeDeleted` | `({ olderThanMs? }?) => { purged }` | Hard-delete tombstones past the grace window (default 30 days). |
| `engine.purgeRows` | `(rows) => { purged }` | "Delete permanently" for specific tombstones; best-effort across devices. |
| `engine.createQuery` | `((db) => Compilable<O>, opts?) => Query<O>` | Build a reusable Kysely query. Warns on a missing `isDeleted` filter unless `{ includeDeleted: true }`. |
| `engine.loadQuery` | `(query) => Promise<readonly R[]>` | One-shot async read. |
| `engine.getQueryRows` | `(query) => readonly R[]` | Cached snapshot (sync). |
| `engine.subscribeQuery` | `(query) => (listener) => unsubscribe` | Low-level reactive primitive (`useQuery` wraps it). |

## Identity

The owner, its recovery key, and moving it between devices.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.appOwner` | `Promise<AppOwner \| null>` | `{ id, recoveryKey, mnemonic?, writeKey }`. |
| `engine.restoreAppOwner` | `(recoveryKey, { force? }) => Promise<void>` | Restore from an `sf1_` key or BIP39 phrase. |
| `engine.resetAppOwner` | `({ force? }) => Promise<void>` | New owner, wipes local data. Refuses unless a relay is confirmed to hold a copy. |
| `engine.exportDatabase` | `({ passphrase? }?) => Promise<EncryptedEnvelopeV1>` | Encrypted application-state snapshot: app rows + metadata, not outbox state or blob chunk bytes. Pause writes/sync for a self-consistent export. |
| `engine.importDatabase` | `(file, { recoveryKey \| passphrase }) => Promise<void>` | Restore a backup: adopts its identity and REPLACES local data. |

## Sync

Relays, sync status, and diagnostics.

| Member | Signature | Notes |
| --- | --- | --- |
| `engine.setTransports` | `(transports) => void` | Set relays; triggers sync + polling. `[]` stops the poller. |
| `engine.sync` | `() => Promise<void>` | Push outbox, pull + apply; resolves after a pass covering your writes. |
| `engine.getSyncState` / `subscribeSyncState` | — | Backing store for `useSyncState`. |
| `engine.getRelayStatuses` | `() => Promise<RelayStatus[]>` | Per-relay health + storage usage (live `GET /v1/status` probe per relay). |
| `engine.getSyncLog` | `(limit?) => SyncLogEntry[]` | Most-recent-first on-device sync diagnostics log. |
| `engine.getPendingOutboxCount` | `() => number` | Events not yet accepted by **any** relay. Zero does not prove every configured relay acknowledged the retained outbox. |
| `engine.getError` / `subscribeError` | — | Backing store for `useSyncError`. |

## React exports

| Export | Signature | Notes |
| --- | --- | --- |
| `SyncProvider` | `({ value, children })` | Provides the engine to the tree. |
| `useSync<S>` | `() => SyncEngine<S>` | The engine; throws outside a provider. |
| `useQuery` | `(query) => readonly R[]` | Reactive rows. |
| `useSyncState` | `() => SyncState` | Reactive sync status. |
| `useSyncError` | `() => SyncError \| null` | Reactive last error. |

## Key types

| Type | Shape |
| --- | --- |
| `MutationResult` | `{ ok: true, value: { id } } \| { ok: false, error: { message } }` |
| `AppOwner` | `{ id, recoveryKey, mnemonic?, writeKey }` |
| `Transport` | `{ url }` |
| `SyncEngineConfig` | `{ name, transports?, externalAppOwner?, syncIntervalMs?, autoSync?, indexes?, requestTimeoutMs? }` |
| `SyncState` | `Initial \| IsSyncing \| IsSynced{lastSyncedAt} \| IsNotSynced{error?,status?,terminal?}` |
| `Query<R>` | `{ sql, parameters, Row }` (the `Row` field is a phantom type carrier) |
