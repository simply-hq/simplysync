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
│  insert/update ─▶ row + pending outbox intent         │     │                    │
│                └▶ async seal ─▶ encrypted outbox ─────┼─push▶ opaque event store │
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

Alongside your tables it maintains seven internal ones — the sync state machine,
all just rows you can inspect:

```sql
_sync_outbox(...)        -- pending plaintext intent, then its sealed envelope
_sync_outbox_relay(...)  -- exact (event, relay) delivery acknowledgements
_sync_seen(...)          -- bounded dedupe set for pulled events
_sync_deferred(...)      -- authenticated events not safe to apply yet
_sync_meta(...)          -- HLC state plus per-relay cursor/backfill progress
_sync_log(...)           -- bounded device-local sync diagnostics
_sync_purge(...)         -- compatibility queue for older purge requests
```

Reads go straight to your tables. A normal engine-stamped write commits the
application row and a plaintext-pending `_sync_outbox` intent in the **same
SQLite transaction**.
That pending payload has the same local trust boundary as the readable row. An
asynchronous seal step then encrypts it before any push; the relay never receives
`payload_json`. See the [sync loop](./sync.md#the-sync-loop).

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
2. **Merge and stamp the full row** with a fresh HLC in `updatedAt`.
3. **Commit the row and replication intent together.** One SQLite transaction
   upserts the local row and inserts its plaintext payload into `_sync_outbox`
   with an empty `envelope_json`. If either write throws, both roll back.
4. **Publish the committed result** to sibling tabs and refresh affected
   reactive queries. The UI can read it immediately.
5. **Kick an asynchronous sync.** It seals every pending intent with AES-GCM,
   then pushes only non-empty encrypted envelopes if relays are configured.

The plaintext eventually sealed inside the envelope is a `SyncPayload`:
`{ schemaVersion, table, op, rowId, hlc, value }`. Current writers emit
`op: "upsert"` for every full-row payload, including tombstones. How it is
encrypted and pushed is in [Sync & the relay](./sync.md).

> **Imported-HLC boundary.** A caller-supplied `updatedAt` also becomes the
> outbox primary key, so the engine refuses it unless it is newer than the row's
> current version and not already queued (also within one `batch`). An older
> stamp would regress a row every peer keeps under last-writer-wins; an equal or
> reused one would commit a row whose replication event the outbox dropped.
> Engine-minted HLCs are unique, so ordinary writes never hit this check.

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
  tables overlap the change, then structurally compares the result (including
  byte-wise BLOB comparison). It swaps `rows` and fires listeners only when the
  result actually differs. Mutations pass the table they wrote; a sync passes
  every table it applied.
- **`useQuery(query)`** subscribes to that entry; **`getQueryRows`** reads the
  cached snapshot synchronously; **`loadQuery`** does a one-shot eager read.

So a write to `entry` re-runs every cached query that references `"entry"` — and
nothing else — then those components re-render. No manual invalidation, no
refetch wiring.

## Building, testing, running

```sh
bun install

bun run typecheck                  # turbo: all typechecks
bun run docs:dev                   # these docs + the browser Demo on :4200

RELAY_URL=https://your-relay.workers.dev \
  bun run --cwd tools/protocol-demo demo  # raw envelope/HLC diagnostic
RELAY_URL=https://your-relay.workers.dev \
  bun run --cwd tools/protocol-demo blob-demo  # encrypted image round-trip
```

---

**Next:** [Sync & the relay →](./sync.md) — how the engine pushes and pulls, the
encrypted envelope, the relay's wire protocol, storage, and threat model.
