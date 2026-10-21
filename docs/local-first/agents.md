# SimplySync for coding agents

The dense contract for writing app code against SimplySync. Read this before
generating code; read **[Client API](./guide.md)** when you need the full prose
reference. Everything here is verified against the shipped API.

## Get the requested source

SimplySync is clone-only. If the user asks for one platform, use the repo-owned
`clone-simplysync` skill or `clone-simplysync.sh`; do not substitute registry
packages or copy directories manually. For example:

```sh
sh clone-simplysync.sh react-native my-mobile-app
```

That preset includes the Expo TodoList plus its React Native, React, engine, and
protocol source dependencies while excluding the other client implementations.
Use `sh clone-simplysync.sh --list` for the other platform and relay presets.

## Is SimplySync the right tool?

Build on it when the app is **single-user, offline-capable, and private**: notes,
journals, personal finance, health trackers, local AI chat. One person, several
of their own devices.

Do **not** build on it for live multi-user collaboration, teams/sharing/roles,
server-side validation or search over user data, or strong immediate
consistency. Conflicts resolve **row-level last-write-wins**, not CRDT merge —
two offline edits to different fields of one row keep one row wholesale. Say so
and propose another stack rather than working around it.

## Non-negotiables

Violating any of these produces silent data bugs, not errors.

1. **Filter `isDeleted` in every query** that shouldn't show deleted rows. Soft
   deletes stay in the table. `createQuery` warns once per query when the filter
   is missing — that warning is a bug report. Pass `{ includeDeleted: true }`
   only for a trash view or diagnostic.
2. **Never hard-delete.** Use `engine.delete(table, id)`. A raw `DELETE` through
   the driver resurrects the row from a peer on the next pull.
3. **Never bypass the engine to write.** Writes must go through
   `insert`/`update`/`upsert`/`delete`/`batch` — that is what encrypts the change
   into the outbox. Direct driver `INSERT`s never sync.
4. **The recovery key is the only key.** Show `owner.recoveryKey` during
   onboarding for backup. Never copy it into app state, plain SQLite, logs, or
   analytics. If the user loses it, the data is gone by design.
   `recoveryKey` holds whichever form the owner has; `mnemonic` is set only when
   that form is a phrase. There are exactly two forms, and you rarely choose:
   `createMnemonic()` (12 words) is what every engine mints for a user, and
   `createRecoveryKey()` (`sf1_…`, one whitespace-free token) is for fixtures,
   CLI flags, and CI secrets. `deriveIdentity` accepts either — the `sf1_`
   prefix is checked *before* the BIP39 test, so the string decides, not you.
   The two derive **different** owners from the same bytes; neither converts to
   the other, and `sf1_` is never removed.
5. **Treat the relay as untrusted transport.** It can delay, withhold, or drop
   encrypted events; it cannot read or forge them. Never move validation,
   search, or authorization server-side.
6. **Don't touch protocol constants.** `DERIVATION_SALT`, the envelope format,
   canonical JSON, and the HLC format are wire constants shared by every client
   and relay implementation.

## A complete working app

```ts
// schema.ts
import { FiniteNumber, id, NonEmptyString, nullOr } from "@simplysync/engine";

export const schema = {
  category: { id: id("category"), name: NonEmptyString },
  entry: {
    id: id("entry"),
    description: NonEmptyString,
    amountCents: FiniteNumber,
    categoryId: nullOr(id("category")),
  },
};
export type AppSchema = typeof schema;
```

The engine adds `createdAt`, `updatedAt` (both ISO/HLC strings) and `isDeleted`
(`0 | 1`) to every table. You never write `CREATE TABLE`.

```ts
// engine.ts — browser
import { createSync } from "@simplysync/engine";
import {
  createEncryptedSecureStorage,
  createIndexedDbSnapshotStore,
  createSqlJsDriverFactory,
} from "@simplysync/browser";
import { schema } from "./schema";

const snapshots = createIndexedDbSnapshotStore({ databaseName: "my-app" });

export const engine = createSync({
  createSqliteDriver: createSqlJsDriverFactory({
    store: snapshots,
    locateFile: () => "/sql-wasm.wasm", // must resolve sql.js' wasm
  }),
  secureStorage: createEncryptedSecureStorage({ databaseName: "my-app" }),
})(schema, {
  name: "my-app",
  transports: [], // local-only; add your relay's HTTPS URL when needed
});

await engine.ready;
```

```ts
// queries.ts — build once, reuse; the compiled SQL is cached
import type { Query } from "@simplysync/engine";
import { engine } from "./engine";

type EntryRow = { id: string; description: string; amountCents: number };

export const entriesQuery: Query<EntryRow> = engine.createQuery((db) =>
  db
    .selectFrom("entry")
    .select(["id", "description", "amountCents"])
    .where("isDeleted", "=", 0) // required — see Non-negotiables
    .orderBy("createdAt", "desc"),
);
```

```tsx
// App.tsx
import { SyncProvider, useQuery, useSync, useSyncState } from "@simplysync/react";
import { engine } from "./engine";
import { entriesQuery } from "./queries";
import type { AppSchema } from "./schema";

export default function App() {
  return (
    <SyncProvider value={engine}>
      <Entries />
    </SyncProvider>
  );
}

function Entries() {
  const sync = useSync<AppSchema>();
  const entries = useQuery(entriesQuery); // re-renders on local write OR sync
  const state = useSyncState();

  return (
    <>
      <span>{state.type}</span>
      <button
        onClick={() => {
          const r = sync.insert("entry", { description: "Tea", amountCents: -300 });
          if (!r.ok) console.error(r.error.message);
        }}
      >
        Add
      </button>
      <ul>
        {entries.map((e) => (
          <li key={e.id}>
            {e.description} {e.amountCents}
            <button onClick={() => sync.delete("entry", e.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </>
  );
}
```

Mutations are synchronous against local SQLite and return
`{ ok: true, value: { id } } | { ok: false, error: { message } }` — check `ok`,
don't `try/catch`. Sync happens on its own; `engine.sync()` is only for an
explicit "sync now" button.

## Platform wiring

`createSync` needs a `SqliteDriver` (`exec` / `select` / `transaction`, all
synchronous) and a `SecureStorage` (`getItem` / `setItem` / `removeItem`).

| Platform | SQLite | Secret store | Notes |
| --- | --- | --- | --- |
| Browser | `createSqlJsDriverFactory` (`@simplysync/browser`) | `createEncryptedSecureStorage` | Keep the writer lock on; `locateFile` must resolve `sql-wasm.wasm`. |
| Expo / React Native | `createExpoSyncDeps` (`@simplysync/react-native`) | `expo-secure-store` | Import the package's `/install` bootstrap before the engine and pass `reloadApp` (no `location`). |
| Node 22.13+ / Raycast | `@simplysync/node` (`node:sqlite`) | host-encrypted store (Raycast `LocalStorage`) | Use `createNodeSyncDeps`; see the package README. |
| Bun CLI / tests | `bun:sqlite` | an OS secret store; file storage only for demos | See `apps/todolist/cli`. |

The engine requires WebCrypto (`globalThis.crypto.subtle`) and `btoa`/`atob`.
Modern browsers, Node 20+, and Bun have them; React Native does not by default.

## API surface

**Writes** — `insert(table, values)`, `update(table, {id, ...})`,
`upsert(table, {id, ...})`, `delete(table, id)`, `deleteMany(table, ids)`,
`batch(ops)` (atomic, one refresh, one sync), `purgeDeleted({olderThanMs?})`,
`purgeRows(rows)`.

**Reads** — `createQuery(fn, opts?)`, `loadQuery(q)` (async one-shot),
`getQueryRows(q)` (sync snapshot), `subscribeQuery(q)`.

**Identity** — `appOwner`, `restoreAppOwner(key, {force?})`, `resetAppOwner({force?})`,
`exportDatabase({passphrase?})`,
`importDatabase(file, {recoveryKey|passphrase})`.

**Sync** — `setTransports(ts)`, `sync()`, `getSyncState()`,
`subscribeSyncState(fn)`, `getRelayStatuses()`, `getSyncLog(limit?)`,
`getPendingOutboxCount()`, `getError()`, `subscribeError(fn)`.

**Column types** — `String`, `NonEmptyString`, `NonEmptyString1000`,
`PositiveInt`, `FiniteNumber`, `SqliteBoolean` (+ `sqliteTrue`/`sqliteFalse`),
`SimpleName`, `Mnemonic`, `JsonText`, `FractionalIndex`, `id("Table")`, wrapped
with `nullOr(...)`, `maxLength(n)(...)`, or `withDefault(...)`.

**Helpers** — `searchFilter(columns, input)` (case-insensitive multi-term
search), `keyBetween(a, b)` / `keysBetween` / `compareOrderKeys` (fractional
ordering for drag-and-drop), `counterColumns()` + `incrementCounter` /
`decrementCounter` / `counterTotalQuery` (conflict-free counters),
`encodeJson` / `decodeJsonOr` (JSON columns), `createPresenceChannel`.

**React** — `SyncProvider`, `useSync<S>()`, `useQuery(q)`, `useSyncState()`,
`useSyncError()`.

## Mistakes and their fixes

| Instead of | Write |
| --- | --- |
| `db.selectFrom("t").selectAll()` | add `.where("isDeleted", "=", 0)` |
| `engine.update("t", { id, isDeleted: 1 })` | `engine.delete("t", id)` |
| a raw `DELETE FROM` | `engine.delete` / `engine.purgeRows` |
| a loop of `insert` calls | `engine.batch([...])` — one transaction and sync |
| `try { engine.insert(...) }` | check the returned `result.ok` |
| `getQueryRows` during boot | `await engine.ready` first, or use `loadQuery` (it awaits) |
| storing `recoveryKey` in state or SQLite | leave it in `secureStorage`; display once |
| a server endpoint that reads user rows | keep it on-device; the relay can't decrypt |
| `schemaVersion: 2` for a new column | keep `1`; additive changes need no bump |
| renaming or removing a column | add a new column and read both; keep the old one declared ([Schema evolution](./schema.md)) |
| a new non-null column | `nullOr(...)` or `withDefault(...)` — old rows read `NULL` |

## Deeper

- **[Client API](./guide.md)** — full reference and React patterns.
- **[How it works](./architecture.md)** — on-device store, clock, read/write paths.
- **[Sync & the relay](./sync.md)** — envelope, wire protocol, relay behavior.
- **[Native clients](./native.md)** — Swift and Kotlin ports.
- **[iCloud sync](./icloud.md)** — Swift apps parking the log in the user's iCloud instead of a relay.
- **[Self-hosting](./self-hosting.md)** — running a relay.
- **[Security model](../../SECURITY.md)** — guarantees, limits, files to audit.
- Working code: [`apps/todolist`](../../apps/todolist) groups the canonical
  CLI, browser, React Native, Swift, and Kotlin clients. There is no second
  product example.
