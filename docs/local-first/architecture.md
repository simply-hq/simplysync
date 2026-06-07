# How it works

This page is the on-device half: how a write lands in local SQLite and how reads
stay reactive. The networked half — the sync loop, the encrypted envelope, and
the relay — lives in **[Sync & the relay](./sync.md)**.

For the API you actually call, see **[Client API](./guide.md)**.

## The three layers

SimplySync is three layers, each doing one job:

| Layer | Package | Job |
| --- | --- | --- |
| **Engine** | `@simplysync/engine` | Local SQLite store, the HLC clock, the outbox, the sync loop, reactive queries. The client API. |
| **Protocol** | `@simplysync/protocol` | The crypto and wire primitives: identity derivation, the AES-GCM envelope, blob chunking, HLC encoding. |
| **Relay** | `apps/relay-*` | A dumb, opaque event store. Holds ciphertext + routing metadata. Optional and self-hostable. |

```
┌─ Engine (on device) ─────────────────────────────────┐     ┌─ Relay (optional) ─┐
│  insert/update ─▶ local SQLite row (source of truth)  │     │                    │
│                └▶ encrypt ─▶ outbox ──────────────────┼─push▶ opaque event store │
│  reactive query cache ◀─ refresh on change            │     │ (ciphertext only)  │
│  poll loop: pull ─▶ decrypt ─▶ apply (LWW) ─▶ row ◀───┼─pull─                    │
└───────────────────────────────────────────────────────┘     └────────────────────┘
        ▲ this page                                                ▲ Sync & the relay
```

The crucial property: **all encryption and decryption happen in the engine, on
the device.** The relay only ever moves opaque bytes — covered in
[Sync & the relay](./sync.md).

## The local database is the source of truth

The engine opens one SQLite database per `name`. From your schema it creates a
physical table per entry, with `id` as the primary key plus three system columns
appended to every table:

```sql
create table "entry" (
  "id" text primary key,
  "description" text,
  "amountCents" real,
  "categoryId" text,
  "createdAt" text,
  "updatedAt" text,
  "isDeleted" integer default 0
);
```

Alongside your tables it maintains three internal ones — the entire sync state
machine, all just rows you can inspect:

```sql
_sync_outbox(event_id text primary key, envelope_json text, pushed_at text)
_sync_seen(event_id text primary key)            -- dedupe pulled events
_sync_meta(key text primary key, value text)     -- HLC high-water mark + per-relay cursor
```

Reads go straight to your tables. Writes go to your tables *and* the outbox, in
the same step. (`_sync_outbox`, `_sync_seen`, and the cursor are consumed by the
[sync loop](./sync.md#the-sync-loop).)

## The Hybrid Logical Clock

Every write is stamped with an HLC so edits from different devices order
deterministically. `createHlc(deviceId, now, counter)` produces
`base36(now,10)-base36(counter,4)-deviceId` — a fixed-width string whose
lexicographic order is physical time, then counter, then device id (a stable
tiebreaker). `compareHlc(null, x)` returns `-1`, so "no value" always loses.

Monotonicity is the engine's job: it persists the last `(time, counter)` to
`_sync_meta` (`hlc:time`, `hlc:counter`) and, within the same millisecond,
increments the counter — so a backward wall clock or a restart can't mint an HLC
that sorts below existing rows (which would make last-writer-wins silently
discard a newer edit).

## The write path

When you call `engine.insert` / `update` / `upsert`:

1. **Validate & coerce** the values against the typed schema; an invalid value
   returns `{ ok: false, error }` and writes nothing.
2. **Upsert the row** into your local SQLite table (instant; the UI can read it
   immediately), stamping `updatedAt` with a fresh HLC.
3. **Encrypt an envelope** for the change and insert `JSON.stringify(envelope)`
   into `_sync_outbox` with `pushed_at = NULL`.
4. **Refresh affected reactive queries**, so every `useQuery` over that table
   re-renders (see [the read path](#the-read-path)).
5. **Kick a sync** opportunistically, if a relay is configured.

The plaintext inside the envelope is a `SyncPayload`:
`{ schemaVersion, table, op: "upsert" | "delete", rowId, hlc, value }`. How it's
encrypted and pushed is in [Sync & the relay](./sync.md).

**Deletes are soft.** A delete sets the `isDeleted` system column and emits a
normal envelope; queries filter `where isDeleted = 0`. You never hard-delete a
row — a real delete couldn't propagate or lose to a later edit.

## The read path

Queries are built once and cached, and they re-render reactively when their data
changes — from a local write *or* an incoming sync.

- **`engine.createQuery((db) => …)`** compiles your Kysely builder to a SQL string
  + parameters once. The result is a `Query<R>` whose row type is inferred.
- **The query cache** keys each query by `sql::params` and holds a **stable `rows`
  array reference**, so React's `useSyncExternalStore` only re-renders when the
  data actually changes. It also records which tables each query touches (by
  scanning the compiled SQL).
- **On a change**, `refreshQueries(changedTables)` re-runs only the queries whose
  tables overlap the change, swaps their `rows`, and fires their listeners.
  Mutations pass the table they wrote; a sync passes every table it applied.
- **`useQuery(query)`** subscribes to that entry; **`getQueryRows`** reads the
  cached snapshot synchronously; **`loadQuery`** does a one-shot eager read.

So a write to `entry` re-runs every cached query that references `"entry"` — and
nothing else — then those components re-render. No manual invalidation, no
refetch wiring.

## Building, testing, running

```sh
bun install

bun run test                       # turbo: all package tests
bun run typecheck                  # turbo: all typechecks

bun run demo                       # relay + two clients + sync, one shot
bun run relay:go                   # canonical Go relay (needs Go 1.24+)
bun run relay:bun                  # Bun relay on :4100
bun run docs:dev                   # these docs + the browser Demo on :4200
bun run --cwd apps/simplysync-example blob-demo   # encrypted image round-trip
```

---

**Next:** [Sync & the relay →](./sync.md) — how the engine pushes and pulls, the
encrypted envelope, the relay's wire protocol, storage, and threat model.
