# Client API

This is everything an app developer touches: define a typed schema, create the
engine, read and write data, bind it into React, and connect a relay. The engine
(`@simplysync/engine`) owns the local SQLite database, the outbox, the clock, and
the sync loop — you write app code, not plumbing.

For what happens beneath this API, see **[How it works](./architecture.md)** (the
on-device store, clock, and read/write paths) and
**[Sync & the relay](./sync.md)** (the encrypted envelope, the wire protocol, the
relay).

## Mental model

- **The local SQLite database is the source of truth.** Reads come from it;
  writes land in it first. The app is fully usable offline.
- **Every write also produces an encrypted sync event.** The engine queues it in
  a local outbox and pushes it when a relay is configured and reachable.
- **Sync is automatic and opportunistic.** The engine polls, pushes the outbox,
  pulls remote events, decrypts them, and applies them last-writer-wins. You
  rarely call `sync()` yourself.
- **Queries are reactive.** A `useQuery` re-renders when the rows it depends on
  change — whether the change came from a local write or an incoming sync.

```
 engine.insert(...) ──▶ local SQLite row  ──▶ useQuery re-renders (instant)
                   └──▶ encrypted envelope ──▶ outbox ──▶ relay (background)

 relay ──▶ pull + decrypt ──▶ apply (last-writer-wins) ──▶ useQuery re-renders
```

## Install

The engine and React bindings are workspace packages. In this monorepo, depend
on them with the workspace protocol:

```jsonc
// package.json
{
  "dependencies": {
    "@simplysync/engine": "workspace:*",
    "@simplysync/react": "workspace:*"
  }
}
```

```sh
bun install
```

**Runtime requirements:** the engine needs WebCrypto (`globalThis.crypto.subtle`)
and `btoa`/`atob`. These exist in modern browsers, Node 20+, and Bun. In React
Native they do not exist by default — install `react-native-quick-crypto` and a
base64 polyfill and load them *before* the engine (see
`examples/expo/crypto-setup.js` for a working setup).

## 1. Define a schema

A schema is a plain `{ table: { column: Type } }` object. Column types come from
the engine's small typed-schema DSL and double as runtime validators.

```ts
import { FiniteNumber, id, NonEmptyString, nullOr } from "@simplysync/engine";

export const schema = {
  category: {
    id: id("category"),
    name: NonEmptyString,
  },
  entry: {
    id: id("entry"),
    description: NonEmptyString,
    amountCents: FiniteNumber,
    categoryId: nullOr(id("category")), // nullable foreign key
  },
};

export type AppSchema = typeof schema;
```

You declare `id` per table. The engine adds three **system columns** to every
table automatically: `createdAt`, `updatedAt` (both ISO strings), and
`isDeleted` (a `0 | 1` SQLite boolean). You never write the physical `CREATE
TABLE` — the engine derives it from the schema.

**Built-in column types:** `String`, `NonEmptyString`, `NonEmptyString1000`,
`PositiveInt`, `FiniteNumber`, `SqliteBoolean`, `SimpleName`, `Mnemonic`, and
`id("Table")`. Wrap any of them with `nullOr(...)` to allow `null`, or
`maxLength(n)(...)` to bound a string. Each type validates on write and rejects
bad values with a typed error.

## 2. Create the engine

`createSync(deps)` takes the platform plumbing once, then returns a factory you
call with your schema and config.

```ts
import { createSync } from "@simplysync/engine";

const engine = createSync({
  createSqliteDriver, // (name) => SqliteDriver — platform SQLite (see §8)
  secureStorage,      // stores the recovery phrase in the OS secret store (§8)
  reloadApp,          // optional: re-evaluate app state after restore/reset
})(schema, {
  name: "my-app",
  transports: [{ type: "Http", url: "http://localhost:4100" }], // optional relay
  syncIntervalMs: 5000, // poll cadence; default 5000
});

await engine.ready; // resolves once the DB is open and the owner is loaded
```

On first run the engine mints a new owner (a fresh recovery phrase, stored via
`secureStorage`). On later runs it loads the existing one. Pass
`externalAppOwner` to supply an owner you derived yourself instead.

## 3. Writing data

Mutations are synchronous against local SQLite and return a `MutationResult`.
Each one also enqueues an encrypted envelope for sync — you don't manage that.

```ts
// insert — the engine generates the id and system columns
const result = engine.insert("entry", {
  description: "Coffee",
  amountCents: -450,
  categoryId: null,
});
if (!result.ok) console.error(result.error.message);
else console.log(result.value.id);

// update — requires the id; updates only the fields you pass
engine.update("entry", { id, amountCents: -500 });

// upsert — insert or update by id
engine.upsert("entry", { id, description: "Latte", amountCents: -500 });
```

**Deletes are soft.** In a distributed log you can't truly delete one change —
you mark the row deleted and let it sync. Set the `isDeleted` system column and
filter it out in your queries:

```ts
import { sqliteTrue } from "@simplysync/engine";

engine.update("entry", { id, isDeleted: sqliteTrue });
```

Inserts allow partial values (omitted columns are left `NULL`); updates require
the `id`. Values are validated against the schema, so an invalid write returns
`{ ok: false, error }` rather than corrupting the row.

## 4. Querying data

Build a query once with `createQuery` using the full [Kysely](https://kysely.dev)
builder — joins, filters, ordering, aggregates. The compiled SQL is reused, and
the row type is inferred.

```ts
import type { Query } from "@simplysync/engine";

type EntryRow = {
  id: string;
  description: string;
  amountCents: number;
  categoryName: string | null;
};

const entriesQuery: Query<EntryRow> = engine.createQuery((db) =>
  db
    .selectFrom("entry")
    .leftJoin("category", "category.id", "entry.categoryId")
    .select([
      "entry.id as id",
      "entry.description as description",
      "entry.amountCents as amountCents",
      "category.name as categoryName",
    ])
    .where("entry.isDeleted", "=", 0)
    .orderBy("entry.createdAt", "desc"),
);
```

Read it imperatively, or (preferably) reactively in React (§5):

```ts
const rows = await engine.loadQuery(entriesQuery); // one-shot read
const rows = engine.getQueryRows(entriesQuery);    // cached snapshot (sync)
```

## 5. React bindings

`@simplysync/react` wires the engine into components. Wrap your tree in a
`SyncProvider`, then read the engine with `useSync` and rows with the reactive
`useQuery`.

```tsx
import {
  SyncProvider,
  useSync,
  useQuery,
  useSyncState,
} from "@simplysync/react";

function App() {
  return (
    <SyncProvider value={engine}>
      <Ledger />
    </SyncProvider>
  );
}

function Ledger() {
  const engine = useSync<AppSchema>();
  const entries = useQuery(entriesQuery); // re-renders on any relevant change
  const state = useSyncState();

  return (
    <>
      <SyncBadge state={state} />
      <button onClick={() => engine.insert("entry", { description: "Tea", amountCents: -300 })}>
        Add
      </button>
      <ul>
        {entries.map((e) => (
          <li key={e.id}>{e.description}: {e.amountCents}</li>
        ))}
      </ul>
    </>
  );
}
```

- **`useQuery(query)`** — subscribes to the query and returns the current rows.
  Re-renders when matching rows change, from a local write *or* an incoming sync.
- **`useSyncState()`** — the current `SyncState` (see §7).
- **`useSyncError()`** — the last `SyncError | null`, for surfacing failures.
- **`useSync<S>()`** — the engine instance, for mutations and `engine.sync()`.

## 6. Identity & recovery

A user's whole account derives from one secret. The engine manages it through
`secureStorage` and exposes the owner:

```ts
const owner = await engine.appOwner; // AppOwner | null
owner.id;       // public owner id used for relay routing
owner.mnemonic; // the 24-word BIP39 recovery phrase — show this for backup
owner.writeKey; // bearer token presented to the relay (a capability)
```

Surface `owner.mnemonic` during onboarding so the user can save it. It is the
**only** thing that can decrypt their data — if they lose it, the data is
unrecoverable by design. Never store it in app state or plain SQLite; the engine
keeps it in the platform secret store.

**Restore on a new device** — boot with the saved phrase and sync from scratch:

```ts
await engine.restoreAppOwner(mnemonic);
// By default this refuses to wipe local data unless the relay confirms the owner
// has data — so a wrong phrase or an unreachable relay can't destroy what's here.
// Pass { force: true } to switch to an empty/new owner intentionally.
await engine.restoreAppOwner(mnemonic, { force: true });
```

**Reset** mints a brand-new owner and wipes local data:

```ts
await engine.resetAppOwner();
```

Both `restoreAppOwner` and `resetAppOwner` call your `reloadApp` afterward so the
UI re-evaluates against the new owner.

## 7. Connecting a relay & sync state

A relay is **optional** — without one, the app is purely local-first and every
edit stays on-device. Configure one (or several) via `transports`, either at
creation or at runtime:

```ts
engine.setTransports([{ type: "Http", url: "https://relay.example.com" }]);
```

Setting transports triggers an immediate sync and starts the background poller.
You can still force a sync (e.g. on a "Sync now" button):

```ts
await engine.sync(); // push the outbox, then pull + apply remote events
```

The engine also syncs opportunistically after local writes and on web
focus/online. Watch progress with `useSyncState()`:

| `SyncState.type` | Meaning |
| --- | --- |
| `SyncStateInitial` | Idle, nothing synced yet. |
| `SyncStateIsSyncing` | A push/pull is in flight. |
| `SyncStateIsSynced` | Up to date (`lastSyncedAt` set). |
| `SyncStateIsNotSynced` | Failed (`error`, optional `status`, and `terminal`). |

A **terminal** failure (auth/quota/bad request — 400/401/403/413) won't fix
itself by retrying the same batch, so the engine backs the poller off (but still
retries on focus/online/write). Network and 5xx/429 errors are retried normally.

### Multiple relays, per-relay status & storage usage

`setTransports` accepts any number of relays; every one receives a full copy of
the outbox (write redundancy) and is pulled independently. `SyncState` stays
`Synced` as long as **any** relay works — the data is safe somewhere — so for
the per-relay truth (which relay is failing, and how full each one is) use
`getRelayStatuses()`:

```ts
const statuses = await engine.getRelayStatuses(); // one HTTP probe per relay
for (const s of statuses) {
  console.log(s.url, s.reachable, `${s.usedBytes} / ${s.quotaBytes} bytes`);
}
```

Each `RelayStatus` combines this device's last sync outcome (`lastSyncedAt`,
`lastFailure`) with the relay-reported account snapshot from `GET /v1/status`:
`usedBytes` / `quotaBytes` / `usedPct` (storage against the relay's per-owner
quota — warn the user well before a `413`), plus `headSeq`, `streams`, `events`
and the relay `version`. A relay that has never seen this owner reports
`reachable: true` with no account block. In React, `useRelayStatuses()` polls it
for you (default every 30 s) — right-sized for a diagnostics or settings screen.

> **For Android emulators** point the relay URL at `http://10.0.2.2:4100`; iOS
> simulators and the web use `http://localhost:4100`.

## 8. Platform drivers

The engine is platform-agnostic: you inject a SQLite driver and a secret store.

**`SqliteDriver`** — a thin synchronous wrapper over the platform's SQLite:

```ts
interface SqliteDriver {
  exec(sql: string, params?: readonly unknown[]): void;
  select<R>(sql: string, params?: readonly unknown[]): R[];
  transaction<T>(fn: () => T): T;
}
```

- **Web:** `sql.js` (WASM) is what the browser [Demo](../../docs/site)
  uses — see `docs/site/playground/sql-driver.ts`.
- **React Native:** `expo-sqlite` — see `examples/expo`.

**`SecureStorage`** — stores the recovery phrase in the OS secret store:

```ts
interface SecureStorage {
  getItem(key: string): Promise<string | null> | string | null;
  setItem(key: string, value: string): Promise<void> | void;
  removeItem(key: string): Promise<void> | void;
}
```

- **React Native:** `expo-secure-store`.
- **Web:** a password-derived key or a platform credential store. Avoid
  `localStorage` for anything beyond a demo.

## 9. Importing legacy data

If you're migrating from a previous SQLite database with the same per-table
layout, `importLegacy` does a one-time, best-effort import and re-emits the rows
as sync events so they propagate to the relay:

```ts
const { imported, skipped } = await engine.importLegacy("old-db-name");
```

It's safe to call on every boot — it no-ops if the legacy DB is missing,
incompatible, or already imported.

## Engine API reference

| Member | Signature | Notes |
| --- | --- | --- |
| `createSync` | `(deps) => (schema, config) => SyncEngine` | Wire platform deps once, then build engines. |
| `engine.ready` | `Promise<void>` | Resolves when the DB is open and owner loaded. |
| `engine.insert` | `(table, values, opts?) => MutationResult` | Generates id + system columns. |
| `engine.update` | `(table, values & { id }, opts?) => MutationResult` | Updates passed fields only. |
| `engine.upsert` | `(table, values & { id }, opts?) => MutationResult` | Insert or update by id. |
| `engine.createQuery` | `((db) => Compilable<O>) => Query<O>` | Build a reusable Kysely query. |
| `engine.loadQuery` | `(query) => Promise<readonly R[]>` | One-shot async read. |
| `engine.getQueryRows` | `(query) => readonly R[]` | Cached snapshot (sync). |
| `engine.subscribeQuery` | `(query) => (listener) => unsubscribe` | Low-level reactive primitive (`useQuery` wraps it). |
| `engine.appOwner` | `Promise<AppOwner \| null>` | `{ id, mnemonic, writeKey }`. |
| `engine.restoreAppOwner` | `(mnemonic, { force? }) => Promise<void>` | Restore from a recovery phrase. |
| `engine.resetAppOwner` | `() => Promise<void>` | New owner, wipes local data. |
| `engine.setTransports` | `(transports) => void` | Set relays; triggers sync + polling. |
| `engine.sync` | `() => Promise<void>` | Push outbox, pull + apply. |
| `engine.getSyncState` / `subscribeSyncState` | — | Backing store for `useSyncState`. |
| `engine.getRelayStatuses` | `() => Promise<RelayStatus[]>` | Per-relay health + storage usage (live `GET /v1/status` probe per relay). |
| `engine.getSyncLog` | `(limit?) => SyncLogEntry[]` | Most-recent-first on-device sync diagnostics log. |
| `engine.getPendingOutboxCount` | `() => number` | Unpushed events still in the outbox (0 = drained). |
| `engine.getError` / `subscribeError` | — | Backing store for `useSyncError`. |
| `engine.importLegacy` | `(name) => Promise<{ imported, skipped }>` | One-time legacy row import. |

### React bindings

| Export | Signature | Notes |
| --- | --- | --- |
| `SyncProvider` | `({ value, children })` | Provides the engine to the tree. |
| `useSync<S>` | `() => SyncEngine<S>` | The engine; throws outside a provider. |
| `useQuery` | `(query) => readonly R[]` | Reactive rows. |
| `useSyncState` | `() => SyncState` | Reactive sync status. |
| `useRelayStatuses` | `({ refreshMs? }?) => readonly RelayStatus[]` | Per-relay health + storage usage, polled (default 30 s). |
| `useSyncError` | `() => SyncError \| null` | Reactive last error. |
| `createUseSync` | `(engine) => () => mutations` | Hook bound to one engine's mutations + owner helpers. |

### Key types

| Type | Shape |
| --- | --- |
| `MutationResult` | `{ ok: true, value: { id } } \| { ok: false, error: { message } }` |
| `AppOwner` | `{ id, mnemonic, writeKey }` |
| `Transport` | `{ type: "Http" \| "WebSocket", url }` |
| `SyncEngineConfig` | `{ name, transports?, externalAppOwner?, syncIntervalMs?, indexes? }` |
| `SyncState` | `Initial \| IsSyncing \| IsSynced{lastSyncedAt} \| IsNotSynced{error?,status?,terminal?}` |
| `Query<R>` | `{ sql, parameters, Row }` (the `Row` field is a phantom type carrier) |

## Common pitfalls

- **Calling crypto before polyfills load (RN).** Import your crypto setup first
  (`index.js` → `crypto-setup.js`) or engine boot throws "WebCrypto is required".
- **Forgetting to filter `isDeleted`.** Soft-deleted rows stay in the table; add
  `.where("isDeleted", "=", 0)` to every query that should hide them.
- **Hard-deleting rows.** Use soft deletes so a delete can lose to a later edit
  and so other devices learn about the deletion.
- **Expecting field-level merges.** Conflicts resolve row-level last-writer-wins;
  two offline edits to different fields of one row keep one row wholesale.
- **Treating the relay as authoritative.** It can withhold or reorder events
  (availability), but cannot read or forge payloads. Design for eventual
  consistency.
