# SimplySync pipeline reference

This document describes the current SimplySync implementation as a set of
input → transformation → output pipelines. It stays inside the SimplySync
repository boundary: the host application supplies domain schema and UI, while
SimplySync owns local persistence, ordering, encryption primitives, relay
replication, and reactive outputs.

The implementation links in each section are authoritative. This reference does
not assume that older prose under `docs/local-first/` still matches the current
engine.

Unless a section explicitly says protocol, relay, adapter, Swift, or Kotlin,
the concrete storage and lifecycle mechanics below describe the canonical
TypeScript `@simplysync/engine`. The native ports preserve the wire, HLC, and
LWW contracts but seal before their transaction, use four internal sync tables,
and track multi-relay delivery with event-ID high-water metadata rather than the
TypeScript engine's exact acknowledgement table.

```text
local intent
  → validate and stamp
  → commit row + durable replication intent
  → seal on device
  → push opaque envelope to one or more relays
  → pull on another device
  → decrypt, classify, and apply by HLC
  → refresh local reactive queries
```

SQLite is the source of truth on each device. A relay is optional and stores
only envelope headers, ciphertext, and encrypted blob bytes.

## TypeScript engine durable state at a glance

Every application table has a text primary key plus three implicit system
columns: `createdAt`, `updatedAt`, and `isDeleted`. The engine also creates these
internal tables:

| Table | Durable responsibility |
| --- | --- |
| `_sync_outbox` | Plaintext-pending or sealed replication intents not yet pruned |
| `_sync_outbox_relay` | Exact `(event, relay)` delivery acknowledgements |
| `_sync_seen` | Pulled-event deduplication set |
| `_sync_deferred` | Authenticated events that cannot be interpreted or applied yet |
| `_sync_meta` | HLC state, relay cursors, push/backfill markers, and lifecycle metadata |
| `_sync_log` | Device-local bounded sync diagnostics |
| `_sync_purge` | Old stream-compaction requests awaiting relay acknowledgement |

Source: [application and internal table creation](../../packages/simplysync-engine/src/engine/store.ts#L71-L198).

---

## 1. Boot, schema, and identity

```text
schema + config + platform dependencies
  → validate config
  → open SQLite and derive identity
  → create/additively migrate schema
  → restore engine metadata
  → ready engine
```

### Inputs

- A runtime schema shaped as `{ table: { column: Type } }`.
- Platform dependencies:
  - `createSqliteDriver(name)`;
  - secure key/value storage;
  - optional `fetch`, browser-tab coordinator, app reload callback, and native
    passphrase KDF.
- Engine configuration:
  - database `name`;
  - optional payload `schemaVersion`, indexes, transports, external owner
    credential, and poll interval.

The schema type DSL carries both a decoded TypeScript type and the runtime
SQLite type/validator used at the write boundary.

### Transformations

1. `createSync` validates that `schemaVersion` is a positive safe integer.
2. It assembles one shared engine state plus the store, persisted HLC, query
   cache, tab bridge, relay synchronizer, mutation path, and lifecycle path.
3. Lifecycle initialization opens the named SQLite database and obtains an
   identity:
   - a valid external recovery key or mnemonic wins;
   - otherwise a valid credential is loaded from secure storage;
   - otherwise a fresh 24-word mnemonic is generated and persisted.
4. A device id is loaded or generated. Browser tabs append a random per-tab
   suffix so independent HLC writers cannot mint the same event id.
5. The driver is exposed to the engine, WAL mode is enabled, and tables are
   created. Existing schemas receive additive `ADD COLUMN`, `CREATE TABLE`, and
   `CREATE INDEX IF NOT EXISTS` migrations only.
6. Declared defaults are installed in DDL and used to normalize existing `NULL`
   values. Defaults are limited to finite numbers and strings.
7. Compatible deferred events are replayed, HLC time/counter are restored from
   `_sync_meta`, active queries are hydrated, and tab buffering starts.
8. When transports are already configured, the engine requests a sync and
   starts polling.

### Outputs

- `engine.ready`, resolved after schema and identity initialization.
- Application tables with the implicit system columns.
- The seven durable internal tables listed above.
- A stable `appOwner` promise containing the derived owner id, normalized
  recovery credential, optional mnemonic, and relay write capability.
- A monotonic HLC state restored across process restarts.
- Optional background relay polling and cross-tab coordination.

### Failure/retry boundary

- Invalid configured `schemaVersion` throws synchronously before assembly.
- Initialization failures set `InitError` and reject `engine.ready`.
- Queries created or read before readiness safely expose an empty snapshot;
  `loadQuery` waits for readiness.
- Schema evolution is additive only. Renames, drops, and type changes require an
  explicit migration outside this automatic path.
- Partial inserts are allowed. Omitted columns without SQLite defaults can be
  `NULL`, even when their runtime `Type` rejects an explicitly supplied `null`.
- An invalid external credential does not fail boot; it falls back to the
  persisted/generated local identity. The supplied external `id` and `writeKey`
  are not trusted directly—the credential is re-derived.
- `SyncEngineConfig.encryptionKey` is currently unused. `Transport.type` also
  does not choose a transport implementation: engine replication is HTTP, with
  `ws:`/`wss:` URLs normalized to `http:`/`https:`.

### Source anchors

- [schema and platform contracts](../../packages/simplysync-engine/src/engine-types.ts#L10-L200)
- [runtime type DSL](../../packages/simplysync-engine/src/type.ts#L25-L181)
- [engine assembly](../../packages/simplysync-engine/src/engine.ts#L97-L179)
- [identity loading and device id](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L304-L392)
- [boot sequence](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L409-L470)
- [schema creation and additive migration](../../packages/simplysync-engine/src/engine/store.ts#L53-L198)
- [protocol identity derivation](../../packages/simplysync-protocol/src/index.ts#L59-L181)

---

## 2. Query compilation and reactive cache

```text
typed Kysely builder
  → SQL + bound parameters
  → local SQLite read
  → structurally diffed cache entry
  → stable row snapshot + notifications
```

### Inputs

- `engine.createQuery(db => ...)`, which receives a typed, compile-only Kysely
  database.
- Optional `{ includeDeleted: true }` when a query intentionally reads
  tombstones.
- `getQueryRows`, `loadQuery`, or a subscription.
- A set of changed table names produced by a mutation, pull, deferred replay,
  snapshot import, or cross-tab apply.

### Transformations

1. The builder is compiled once into SQLite SQL and bound parameters; creating a
   query does not execute it.
2. The engine heuristically warns once when a `SELECT` references an application
   table but has no `isDeleted` predicate.
3. The cache key is `sql::JSON(parameters)`.
4. Referenced tables are inferred by scanning compiled SQL for quoted schema
   table names.
5. The cache reads directly from the local driver.
6. `refreshQueries(changedTables)` reruns only entries whose inferred table set
   overlaps the changed set.
7. Rows are structurally compared. Byte columns use byte-for-byte comparison;
   other cells use `Object.is`.
8. A cached array reference is replaced, and listeners are notified, only when
   the result actually differs.

### Outputs

- A stable synchronous rows array for `getQueryRows` and React external-store
  consumers.
- An eager current read from `loadQuery`.
- Listener notifications for result changes, without no-op rerenders.
- Automatic cache eviction after the last listener unsubscribes.

### Failure/retry boundary

- Before schema readiness, a missing-table/read error behaves as an empty result.
- After readiness, a database/query error is logged, one `QueryError` is exposed,
  and the query still returns `[]`; the cache does not throw into rendering code.
- `includeDeleted` only acknowledges and suppresses the warning. It does not add
  or remove a SQL predicate.
- Table dependency detection and the tombstone warning are SQL-string
  heuristics, not a full parser. Complex queries should not treat them as a
  correctness boundary.

### Source anchors

- [compile-only Kysely and tombstone warning](../../packages/simplysync-engine/src/engine.ts#L45-L95)
- [public query methods](../../packages/simplysync-engine/src/engine.ts#L181-L202)
- [cache keys and table inference](../../packages/simplysync-engine/src/engine/query-cache.ts#L14-L35)
- [structural row comparison](../../packages/simplysync-engine/src/engine/query-cache.ts#L37-L98)
- [execution, refresh, stable snapshots, and subscription](../../packages/simplysync-engine/src/engine/query-cache.ts#L100-L186)

---

## 3. Local mutation, durable outbox intent, and async sealing

```text
insert/update/upsert/delete/batch
  → validate supplied values
  → merge row and mint/observe HLC
  → one SQLite transaction:
       write row + insert plaintext-pending outbox intent
  → async seal into ciphertext
  → tab publication + query refresh + opportunistic sync
```

### Inputs

- `insert`, `update`, `upsert`, `delete`, `deleteMany`, or `batch`.
- Schema-typed values and optional system-column overrides.
- Optional mutation settings:
  - `onComplete` callback;
  - `{ local: true }` for an intentionally device-local intermediate state.

### Transformations

1. The engine verifies that the table exists and validates each supplied schema
   value using its runtime type.
2. An absent id becomes a random 16-byte base64url id.
3. `update`, `upsert`, and `delete` read the current row and merge supplied
   values over it. `update` fails when no row exists. `delete` is allowed even
   when the row is absent, producing a future-proof tombstone.
4. A caller-supplied `updatedAt` must be a valid admissible SimplySync HLC and is
   absorbed into the local clock. Otherwise the clock mints a fresh HLC.
5. The final row receives stable `createdAt`, fresh `updatedAt`, and an
   `isDeleted` value. Delete forces `isDeleted = 1`.
6. The engine builds a full-row `SyncPayload`. Current writers always use
   `op: "upsert"`; a deletion is represented by the tombstone flag inside the
   value.
7. For a normal mutation, one synchronous SQLite transaction commits both:
   - the application row;
   - `_sync_outbox(event_id, payload_json, envelope_json='', pushed_at=NULL)`.
8. After commit, the engine requests an asynchronous sync, publishes the
   plaintext payload to same-origin sibling tabs, refreshes affected queries,
   and invokes `onComplete`.
9. At the start of `sync()`, `sealPendingOutbox()` encrypts every still-unsealed
   payload with the owner data key. It uses canonical JSON, a fresh AES-GCM
   nonce, authenticated envelope header data, and a pseudonymous per-row
   `streamId` when available.
10. The sealed JSON replaces the empty `envelope_json`. Push never selects an
    empty/unsealed envelope.

`batch` prepares every operation before opening the business-row/outbox
transaction, then writes every row and uniquely keyed replication intent in
that transaction. It refreshes each changed table once and requests one sync.

### Outputs

- An immediately readable local SQLite row.
- For an engine-minted or otherwise unique event id, a durable replication
  intent committed atomically with that row.
- A sealed, end-to-end-encrypted envelope ready for any configured relay.
- Cross-tab local visibility and reactive query updates.
- A synchronous mutation result containing either the written id(s) or a local
  validation/transaction error.

### Failure/retry boundary

- Validation failure writes no application row or outbox intent and returns
  `{ ok: false }`.
- If row or outbox insertion fails, the transaction rolls both back. A normal
  committed row therefore has a pending-or-sealed replication intent.
- HLC allocation happens during preparation and persists its high-water mark
  before the row transaction. A failed transaction—or an invalid later item in
  a batch—can consume HLC values even though no application rows commit. Gaps in
  HLCs are harmless; monotonicity matters, not contiguity.
- Callers overriding `updatedAt` must preserve event-id uniqueness. The outbox is
  keyed only by HLC/event id and uses `INSERT OR IGNORE`; reusing the same valid
  HLC for two rows lets both rows commit but retains only the first replication
  payload. Engine-minted HLCs avoid this collision.
- Encryption is intentionally outside the write transaction because WebCrypto
  is asynchronous. Plaintext exists in the local outbox between commit and a
  successful leader seal, at the same trust level as the local row, but it is
  never sent to a relay.
- A seal failure sets `SealError`, leaves that row pending, skips it, and
  continues sealing other rows. A later `sync()` retries it.
- A normal mutation requests sealing even with no relay configured. After a
  crash between commit and seal, however, boot auto-syncs only when transports
  exist. With no transport, the pending entry waits for a later mutation,
  explicit `sync()`, or transport attachment. A follower tab is another
  exception: its `sync()` is a no-op, so that tab's plaintext-pending copy stays
  in memory until promotion. Promotion first persists the complete in-memory
  database and then starts leader sync; the current leader has already received,
  sealed, and pushed its own copy of the event.
- `{ local: true }` deliberately creates no outbox entry and no relay push. It
  still persists locally, gets a fresh HLC, refreshes queries, and appears in
  sibling tabs. The host must later perform a normal commit if peers should see
  the final state.
- Batch preparation reads pre-batch database state. Operations do not read
  earlier operations from the same batch.
- `insert` is not a strict duplicate-id failure. The physical writer uses
  `ON CONFLICT(id) DO UPDATE`, so an explicit existing id updates the columns in
  that insert-shaped row.

### Source anchors

- [mutation preparation and HLC stamping](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L72-L142)
- [payload construction and sync kick](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L144-L167)
- [single mutation transaction](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L169-L217)
- [batch transaction](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L219-L279)
- [durable pending outbox insert](../../packages/simplysync-engine/src/engine/store.ts#L600-L618)
- [physical row upsert](../../packages/simplysync-engine/src/engine/store.ts#L620-L650)
- [async outbox sealing](../../packages/simplysync-engine/src/engine/relay.ts#L134-L169)
- [protocol envelope sealing](../../packages/simplysync-protocol/src/index.ts#L289-L394)
- [atomicity tests](../../packages/simplysync-engine/test/write-atomicity.test.ts#L107-L339)

---

## 4. Multi-relay push and outbox pruning

```text
sealed outbox
  → one delivery queue per relay URL
  → POST batches until drained
  → exact per-relay acknowledgement
  → prune only after every current relay has acknowledged
```

### Inputs

- The current list of configured relay transports.
- Sealed rows in `_sync_outbox`.
- Per-relay acknowledgements in `_sync_outbox_relay`.
- Per-relay `push:<base>` and `backfill:<base>` metadata.

### Transformations

1. Relay URLs are normalized from `ws:`/`wss:` to `http:`/`https:`.
2. Before first use of a relay URL, the engine backfills one canonical upsert
   event for every current application row—including tombstones and rows learned
   from other devices—if prior outbox history has already been pruned.
3. Pending backfill rows are sealed.
4. For each relay, the engine selects up to 1,000 sealed events for which that
   exact relay lacks an acknowledgement.
5. It POSTs only parsed `SyncEnvelope` objects and owner routing/authentication
   metadata. `payload_json` never enters the request.
6. After a successful batch, one SQLite transaction:
   - sets `pushed_at` if this is the event's first successful relay delivery;
   - inserts the exact `(event_id, relay)` acknowledgement.
7. `push:<base>` advances monotonically as a high-water/diagnostic marker, but
   it is not used as proof that every lower-sorting event reached the relay.
8. The pass repeats until a batch contains fewer than 1,000 events.
9. After all relay passes, the engine removes an outbox event only when every
   currently configured relay has an exact acknowledgement for it.

### Outputs

- A full opaque event copy on every configured relay that succeeds.
- Exact per-relay delivery state on device.
- A bounded send queue rather than a permanent local event archive.
- One-time current-state initialization for a relay that has never been used by
  this local database.

### Failure/retry boundary

- Relay insertion is idempotent by `(ownerId,eventId)`, so retrying a batch is
  safe.
- A failed relay keeps its acknowledgements missing; those events remain in the
  outbox even if another relay succeeded.
- `pushed_at` means “reached at least one relay.” Consequently,
  `getPendingOutboxCount()` can be zero while a retained event is still pending
  for a secondary relay. Use per-relay status/logs when redundancy matters.
- Pruning considers the currently configured relay set. Removing a relay no
  longer blocks pruning.
- Backfill is marked once per normalized URL. Reattaching a previously
  initialized URL is not treated as a brand-new relay and does not force another
  full-state backfill.
- A relay added after prior outbox pruning receives current row state, not the
  full mutation history. That is sufficient for row-level LWW convergence.

### Source anchors

- [exact delivery acknowledgements and pruning](../../packages/simplysync-engine/src/engine/store.ts#L495-L538)
- [new-relay current-state backfill](../../packages/simplysync-engine/src/engine/store.ts#L540-L598)
- [per-relay push](../../packages/simplysync-engine/src/engine/relay.ts#L171-L225)
- [draining push batches in one pass](../../packages/simplysync-engine/src/engine/relay.ts#L617-L645)
- [pending-count meaning](../../packages/simplysync-engine/src/engine/store.ts#L271-L278)
- [multi-relay tests](../../packages/simplysync-engine/test/multi-relay.test.ts#L42-L232)

---

## 5. Pull, decrypt, classify, defer, apply, and cursor

```text
relay page after cursor
  → dedupe
  → authenticate and decrypt
  → classify schema + HLC
  → defer or whole-row LWW apply
  → mark seen
  → commit
  → advance cursor
```

### Inputs

- Owner identity and relay bearer capability.
- A relay-specific `cursor:<base>` from `_sync_meta`.
- A page of encrypted envelopes plus `nextCursor`.
- The application schema and highest supported payload schema version.

### Transformations

1. The engine GETs `/v1/events?ownerId=...&after=...`. It omits an explicit
   page limit and uses the relay's default.
2. A relay `404` for an owner that has never pushed is interpreted as an empty
   successful pull.
3. Events already present in `_sync_seen` are skipped before decryption.
4. Every remaining envelope is decrypted asynchronously before the synchronous
   SQLite apply transaction begins. AES-GCM verifies the owner and authenticated
   envelope header.
5. The plaintext is classified:
   - supported schema version and valid payload shape;
   - future schema version;
   - structurally invalid.
6. The event id and payload HLC are independently classified as admissible,
   future, or malformed. Supported events must satisfy
   `payload.hlc === envelope.eventId`.
7. Admissible supported HLCs are observed by the local clock even when their row
   later loses LWW.
8. One SQLite transaction processes the decrypted page:
   - future payload versions are stored in `_sync_deferred`;
   - valid future HLCs are deferred until wall time catches up;
   - unknown tables are deferred for a later additive schema upgrade;
   - supported known-table rows are projected onto known columns and applied
     only when their HLC is strictly newer than the local row;
   - processed event ids are inserted into `_sync_seen`.
9. Applied rows are published to follower tabs with `outbox:false` because the
   relay already holds them.
10. Only after the apply transaction commits does the engine persist
    `nextCursor`. The cursor is opaque to the engine; it checks only whether the
    new string differs, not whether it is monotonically greater.
11. A sync pass keeps pulling pages until it gets an empty page, or until a
    non-empty response leaves the cursor unchanged.
12. Affected cached queries refresh once after the relay loop. The seen set is
    bounded to 50,000 event ids.
13. Deferred events are replayed during boot and every sync. Once their version,
    table, and HLC are acceptable, they pass through the same LWW apply path.

### Outputs

- Decrypted, schema-compatible local rows or tombstones.
- A durable per-relay cursor written only after committed processing.
- A bounded deduplication set.
- Durable deferred plaintext for events that a later app version or later wall
  clock may be able to apply.
- Query and cross-tab updates for rows that changed.

### Failure/retry boundary

- Pull transport/HTTP failure leaves the cursor unchanged and is retried by a
  later sync trigger.
- A bad envelope does not abort the rest of its page. It increments the decrypt
  failure count. The returned page cursor is still persisted, so that envelope
  is effectively skipped unless the cursor is rewound or the relay serves it
  again.
- Malformed payloads and known-column validation failures are counted, marked
  seen, and treated as terminal for that event so one bad row cannot wedge the
  cursor forever.
- Future-version, future-HLC, and unknown-table events are marked seen but also
  retained in `_sync_deferred`; persisting the page cursor does not lose them.
- A stale or equal-HLC event is marked seen but does not overwrite the local
  row. Equality preserves the existing row.
- Unknown columns from a newer additive schema are projected away instead of
  failing the whole row. An explicit invalid non-`NULL` value for a known column
  still fails apply.
- Cursor values are supplied by the relay. A malicious relay can withhold or
  skip data; it can also regress or oscillate cursor strings. Regression causes
  replay, while endless alternation can keep a drain running because the engine
  treats any inequality as progress. End-to-end encryption protects contents
  and authenticity, not relay availability, completeness, or cursor honesty.

### Source anchors

- [pull request, decryption, and classification](../../packages/simplysync-engine/src/engine/relay.ts#L381-L483)
- [transactional apply, seen set, and cursor commit](../../packages/simplysync-engine/src/engine/relay.ts#L485-L564)
- [multi-page drain and forward-progress guard](../../packages/simplysync-engine/src/engine/relay.ts#L646-L678)
- [payload-version classifier](../../packages/simplysync-engine/src/engine/schema-version.ts#L13-L52)
- [deferred replay](../../packages/simplysync-engine/src/engine/relay.ts#L313-L371)
- [schema projection and LWW row apply](../../packages/simplysync-engine/src/engine/store.ts#L653-L725)
- [authenticated protocol decryption](../../packages/simplysync-protocol/src/index.ts#L359-L394)
- [apply compatibility tests](../../packages/simplysync-engine/test/relay-apply.test.ts#L174-L676)

---

## 6. Hybrid logical clock and whole-row LWW

```text
wall clock + persisted high-water mark + device id
  → fixed-width HLC
  → event id and row version
  → deterministic lexicographic comparison
```

### Inputs

- Current wall-clock milliseconds.
- Persisted `_sync_meta` values `hlc:time` and `hlc:counter`.
- Stable device id, with an optional per-tab suffix.
- Remote authenticated HLCs observed during pull or tab apply.
- Optional historical `updatedAt` supplied by a trusted import caller.

### Transformations

1. An HLC is encoded as
   `base36(milliseconds,10)-base36(counter,4)-deviceId`.
2. A local write chooses the greater of wall time and its persisted logical time.
3. Repeated writes at the same logical millisecond increment the counter.
4. If the four-base36-digit counter would overflow, logical time advances by
   one millisecond and the counter resets instead of changing the wire shape.
5. Time and counter persist before the HLC is returned.
6. A remote HLC must match the strict grammar. A timestamp more than five
   minutes ahead of local wall time is classified as future rather than absorbed.
7. An admissible remote HLC raises the local high-water mark so the next local
   write sorts after it.
8. Row application compares strings lexicographically. Missing local versions
   lose; an existing version greater than or equal to the incoming version wins.

### Outputs

- Strictly increasing event ids per engine/device writer, including across
  restarts and backward wall-clock movement.
- A deterministic total order across devices, with device id as the final tie
  breaker.
- One version value used consistently as row `updatedAt`, payload `hlc`, and
  envelope `eventId`.
- Whole-row last-writer-wins convergence independent of relay delivery order.

### Failure/retry boundary

- Malformed HLCs are rejected rather than allowed to poison the clock.
- Authenticated but too-far-future remote events are deferred, not discarded,
  and are reconsidered during later syncs as wall time advances.
- A supplied mutation `updatedAt` must be admissible; otherwise the mutation
  returns a validation error.
- LWW is row-level, not field-level. Two offline edits to different fields of
  the same row do not merge; the row with the greatest HLC wins in full.
- Correctness depends on the fixed-width format. Changing its width, grammar, or
  comparison is a cross-platform protocol migration.

### Source anchors

- [persisted engine clock](../../packages/simplysync-engine/src/engine/store.ts#L825-L903)
- [strict HLC grammar, drift bound, creation, and comparison](../../packages/simplysync-protocol/src/index.ts#L208-L268)
- [LWW application](../../packages/simplysync-engine/src/engine/store.ts#L698-L725)
- [clock boundary tests](../../packages/simplysync-engine/test/hlc-clock.test.ts#L18-L127)

---

## 7. Tombstones and permanent purge policy

```text
delete intent
  → normal versioned row with isDeleted=1
  → encrypted replication like any upsert
  → explicit query filtering
  → permanent purge only when relay history cannot exist
```

### Inputs

- `delete`, `deleteMany`, or batch operations with `mode: "delete"`.
- Explicit `purgeDeleted({ olderThanMs? })` or `purgeRows([{ table, id }])`.
- Durable evidence of relay use in `_sync_meta`.

### Transformations

1. Delete uses the normal mutation path and forces `isDeleted = 1`.
2. Deleting an absent id creates a tombstone, so a stale row arriving later can
   still lose LWW.
3. The full tombstone row is staged, sealed, pushed, pulled, and applied exactly
   like any other upsert.
4. Queries decide whether to include tombstones with their own SQL predicate.
   The engine warns about likely omissions but never silently filters.
5. Public hard-purge APIs first reject any database that currently has a relay
   or has durable `push:*`, `cursor:*`, or `backfill:*` history.
6. For a never-synced database:
   - `purgeDeleted` hard-deletes tombstones older than the requested threshold,
     defaulting to 30 days;
   - `purgeRows` hard-deletes only the named rows that are already tombstones.
7. A hard delete and its `(table,rowId)` purge-queue entry are committed in one
   transaction. The queue preserves the material needed to derive an opaque
   `streamId` after the row is gone.
8. Sync continues to drain legacy `_sync_purge` entries from older versions,
   asking every current relay to compact the corresponding streams and retaining
   the queue entry until all acknowledge.

### Outputs

- A durable, replicable tombstone that prevents stale-peer resurrection.
- Hidden rows only in queries that explicitly filter `isDeleted`.
- Local storage reclamation for databases that have never participated in relay
  sync.
- Best-effort relay stream compaction for already-existing legacy purge work.

### Failure/retry boundary

- `tombstoneRetentionMs` is retained for source compatibility but currently has
  no effect.
- Once relay history exists, public purge methods return `{ purged: 0 }`, even
  after transports are detached. Time alone cannot prove that every offline
  device saw the delete.
- Stream compaction failure does not fail ordinary sync correctness. Each relay
  acknowledgement is retained and failed relays retry on a later sync.
- Blob chunk garbage collection is separate; event-stream compaction does not
  determine which encrypted chunks remain referenced by a manifest.

### Source anchors

- [soft-delete preparation](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L100-L156)
- [public purge guard and API](../../packages/simplysync-engine/src/engine.ts#L301-L323)
- [durable relay-history detection](../../packages/simplysync-engine/src/engine/store.ts#L297-L307)
- [hard delete and purge selection](../../packages/simplysync-engine/src/engine/store.ts#L353-L438)
- [purge queue storage](../../packages/simplysync-engine/src/engine/store.ts#L440-L493)
- [relay stream-compaction drain](../../packages/simplysync-engine/src/engine/relay.ts#L228-L311)
- [purge policy tests](../../packages/simplysync-engine/test/purge.test.ts#L60-L543)

---

## 8. Browser-tab coordination

```text
event committed in one tab
  → same-origin plaintext broadcast
  → sibling LWW apply
  → optional sibling outbox staging
  → leader-only relay work
```

### Inputs

- An injected `TabSync` implementation that provides leader election,
  publication/subscription, sync-state mirroring, locks, and an exclusive
  destructive-operation barrier.
- Events produced by local mutation, relay pull, or deferred replay.
- Promotion of a follower to leader.

### Transformations

1. The engine subscribes during construction, before SQLite is ready, and
   buffers events until `bridge.start()`.
2. Local event publication is chunked into batches of 500.
3. A receiving tab parses and classifies each payload, observes its HLC, and
   applies it through the same schema-projection/LWW path used by relay pulls.
4. When `event.outbox` is true, the receiver also stages the same pending
   replication intent. This ensures a later-promoted tab owns the full local
   backlog, not only the events it authored.
5. Relay-pulled events and `{ local: true }` mutations use `outbox:false`.
6. Only the elected leader seals, pushes, pulls, polls, and publishes sync state.
   Followers mirror that state for truthful UI.
7. A newly promoted leader requests a sync and starts polling.
8. Identity creation uses a cross-tab lock. Reset, owner restore, and database
   import acquire an exclusive barrier before replacing state.

### Outputs

- Near-immediate convergence among same-origin tabs.
- Unique HLC writers despite a shared persisted device id.
- A leader-owned relay connection with follower-visible health state.
- A transferable outbox backlog after leader failure/promotion.

### Failure/retry boundary

- A tab that receives events before DB readiness retains them in memory and
  applies them after startup; overlap with the loaded snapshot is safe under LWW.
- Invalid JSON/payloads and individual apply failures are skipped so one bad tab
  event does not wedge the batch.
- During a rolling page upgrade, an older leader does not apply a future-version
  follower payload, but it still stages the event for relay delivery.
- Calling `sync()` in a follower is an intentional no-op. Promotion is the retry
  boundary for relay ownership.
- Persistence of browser SQLite snapshots and the leader election algorithm are
  responsibilities of the injected platform coordinator, not this engine module.
- A follower's own normal mutation stages a plaintext-pending outbox copy but
  cannot seal it while it remains a follower. Leader delivery protects network
  progress; promotion is the follower copy's sealing boundary.

### Source anchors

- [tab coordination contract](../../packages/simplysync-engine/src/engine-types.ts#L126-L167)
- [tab bridge buffering, publication, and apply](../../packages/simplysync-engine/src/engine/tab-sync.ts#L10-L109)
- [tab-specific device id](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L340-L391)
- [leader sync-state mirroring](../../packages/simplysync-engine/src/engine.ts#L163-L175)
- [leader promotion and prompt sync](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L427-L445)
- [cross-tab tests](../../packages/simplysync-engine/test/tab-sync.test.ts#L121-L303)

---

## 9. Encrypted blob pipeline

Blobs are protocol and relay primitives, not an integrated `SyncEngine` method.
The host owns upload/download orchestration and decides how to persist the small
manifest as ordinary synced application data.

```text
owner identity + binary bytes
  → chunk
  → AES-GCM seal each chunk
  → content-address encrypted bytes
  → host uploads chunks and syncs manifest
  → peer fetches, verifies, decrypts, and reassembles
```

### Inputs

- A derived SimplySync identity.
- Plain `Uint8Array` data.
- MIME type and optional chunk size, blob id, and creation time.
- On read: a `BlobManifest` plus one or all encrypted stored chunks.

### Transformations

1. `encryptBlob` splits plaintext into chunks, defaulting to 256 KiB.
2. Every chunk receives a fresh 12-byte AES-GCM nonce.
3. AEAD additional data binds the chunk to protocol version, owner id, blob id,
   and index, preventing cross-owner/blob/index substitution.
4. Stored bytes are `nonce || ciphertext`.
5. SHA-256 of those stored bytes becomes the content-addressed chunk hash. The
   reference relay keys storage by `(ownerId, hash)`, so deduplication is scoped
   to one owner.
6. The protocol returns:
   - a compact manifest containing ordered hash/size references, whole-blob
     plaintext hash, MIME type, sizes, owner, and blob id;
   - the encrypted chunks ready for upload.
7. A host can use relay `HEAD` to skip an existing hash, `PUT` to upload raw
   encrypted bytes, and `GET` to fetch on demand. The reference relay
   authenticates the owner, recomputes the path hash, deduplicates, enforces
   chunk/owner quotas, and stores opaque bytes.
8. `decryptBlobChunk` first verifies the stored-byte hash, then decrypts with the
   manifest-bound AAD. `decryptBlob` decrypts all ordered chunks and verifies
   final byte length and whole-blob SHA-256.

### Outputs

- A syncable `BlobManifest`.
- Content-addressed encrypted chunks that can be cached and deduplicated within
  an owner without revealing plaintext. Fresh random nonces mean independently
  encrypting identical plaintext normally produces different hashes and does
  not deduplicate.
- Lazy verified plaintext chunks or a fully reassembled verified blob.

### Failure/retry boundary

- Non-positive/non-integer chunk size throws before encryption.
- Owner mismatch, missing chunk index, content-hash mismatch, AES-GCM failure,
  wrong chunk count, wrong final size, or wrong whole-blob hash rejects the read.
- An empty blob is valid and produces a zero-chunk manifest.
- Chunk PUT is idempotent by `(ownerId, hash)`. Auth, rate, size, hash, quota,
  and storage failures remain host-visible HTTP failures; the engine has no
  automatic blob retry queue.
- The protocol does not automatically insert the manifest into an application
  table or upload chunks. Both are host responsibilities.
- Orphaned encrypted chunks are not automatically garbage-collected when a
  manifest is superseded or deleted.

### Source anchors

- [blob wire types](../../packages/simplysync-protocol/src/types.ts#L61-L102)
- [blob encryption and manifest construction](../../packages/simplysync-protocol/src/index.ts#L406-L474)
- [chunk and whole-blob verification/decryption](../../packages/simplysync-protocol/src/index.ts#L476-L542)
- [reference relay blob HTTP handlers](../../apps/relay-go/handlers.go#L314-L445)
- [reference relay content-addressed storage and quota transaction](../../apps/relay-go/store.go#L365-L425)
- [blob protocol tests](../../packages/simplysync-protocol/test/blob.test.ts#L1-L115)

---

## 10. Database backup, import, and owner lifecycle

### 10.1 Encrypted database export

```text
current rows + sync metadata + owner credential
  → driver-neutral JSON snapshot
  → recovery-key or passphrase AES-GCM envelope
```

#### Inputs

- The current ready owner.
- Every row in every application schema table, including tombstones and system
  columns.
- `_sync_meta` entries.
- Optional independent backup passphrase.

#### Transformations

1. The store reads every application row.
2. It exports every metadata key except `legacyImported`.
3. It embeds the normalized recovery credential so the imported state can adopt
   the same owner.
4. Without an extra passphrase, a dedicated backup key is derived from the
   high-entropy recovery credential and used for AES-256-GCM.
5. With a passphrase, the protocol uses PBKDF2-HMAC-SHA256 with a random salt
   and 600,000 iterations by default, followed by AES-256-GCM. The default
   WebCrypto KDF NFKC-normalizes the passphrase; an injected platform KDF is
   called with the raw string.

#### Outputs

- A self-describing `EncryptedEnvelopeV1` for file/share-sheet handling by the
  host.
- Either `keying: "recovery-phrase"`—the historical wire label for both BIP39
  phrases and native `sf1_` keys—or `keying: "passphrase"`.

#### Failure/retry boundary

- Export fails if owner identity is not ready.
- The optional KDF is injectable because some React Native WebCrypto
  implementations do not provide reliable PBKDF2.
- Injected KDFs must apply the same passphrase normalization on export and
  import. The current Expo adapter passes the raw string to native PBKDF2, so a
  Unicode passphrase can derive different bytes from the default NFKC path even
  when it looks identical.
- This is an application-state snapshot, not a byte-for-byte SQLite backup. It
  does not include `_sync_outbox`, `_sync_outbox_relay`, `_sync_seen`,
  `_sync_deferred`, `_sync_log`, or `_sync_purge`.
- Encrypted blob chunk bytes are also absent. A backed-up application row may
  restore its manifest, but restoring the actual media still depends on the
  original relay/blob store retaining those chunks.
- Snapshot collection is not wrapped in one read transaction. Besides ordinary
  cross-table skew, a concurrent pull can update a table after that table was
  scanned and then advance `cursor:*` before metadata is read. Import would
  restore the later cursor without the row, so a later pull may not self-heal the
  omission. Hosts should quiesce local writes and relay sync while exporting.
- Because outbox intents are omitted, a snapshot is not proof that every local
  row was delivered before export. Hosts that need that guarantee should verify
  relay delivery before creating the backup.

#### Source anchors

- [snapshot shape](../../packages/simplysync-engine/src/engine-types.ts#L202-L227)
- [snapshot collection](../../packages/simplysync-engine/src/engine/store.ts#L728-L764)
- [export encryption choice](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L649-L673)
- [backup envelope and cryptography](../../packages/simplysync-protocol/src/snapshot-crypto.ts#L27-L286)
- [dedicated recovery backup key](../../packages/simplysync-protocol/src/index.ts#L184-L202)

### 10.2 Encrypted database import

```text
encrypted envelope + secret
  → parse and authenticate
  → adopt backup identity
  → atomically replace local application state
  → refresh, sync, reload
```

#### Inputs

- An encrypted envelope object or serialized JSON.
- Its passphrase, recovery key, or recovery phrase.
- Current schema and platform reload/tab coordination.

#### Transformations

1. The engine validates the outer envelope shape and keying mode.
2. Recovery-keyed import derives the supplied credential and rejects an owner-id
   mismatch before decryption. Passphrase mode derives the key from envelope KDF
   parameters.
3. AES-GCM decrypts and authenticates the snapshot JSON.
4. The engine validates the snapshot format/version and credential presence.
5. It derives the embedded owner and rejects conflicting `recoveryKey` and
   legacy `mnemonic` fields.
6. It acquires the cross-tab exclusive barrier.
7. The recovery credential is persisted to secure storage.
8. One SQLite transaction wipes current application/internal state, restores
   compatible application rows and metadata, and marks legacy import complete.
   Unknown tables and columns are ignored/projected for additive compatibility.
9. In-memory identity and HLC high-water state are replaced, queries refresh, a
   relay sync is requested when configured, and the app reloads.

#### Outputs

- The backup's local application state, tombstones, owner identity, and metadata.
- A current-schema projection of backups written by newer additive schemas.
- Refreshed local reads and a lifecycle restart under the restored owner.

#### Failure/retry boundary

- Invalid JSON/envelope, missing secret, wrong owner, wrong passphrase, corrupted
  ciphertext, conflicting credentials, or unrecognized snapshot rejects import.
- Wrong-secret and outer-format failures happen before destructive state change.
- Application-row replacement is one SQLite transaction, so a row validation or
  write failure rolls that database replacement back.
- The secure-storage credential is written immediately before that database
  transaction. A valid envelope containing an invalid known row can therefore
  update the persisted credential even though row replacement rolls back; this
  is a current implementation boundary worth accounting for in recovery UI.
- Imported rows are restored directly and do not create new outbox entries. The
  imported metadata also includes prior `push:*`/`backfill:*` markers, so import
  should not be described as automatically re-emitting every current row.
- Import restores blob manifests only when those manifests are application rows;
  it never restores encrypted blob chunk bytes.

#### Source anchors

- [snapshot replacement transaction](../../packages/simplysync-engine/src/engine/store.ts#L766-L792)
- [snapshot validation and restore lifecycle](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L675-L731)
- [envelope parse, decrypt, and import](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L733-L796)
- [backup round-trip tests](../../packages/simplysync-engine/test/db-export-import.test.ts#L72-L229)

### 10.3 Recovery-key owner restore and reset

```text
recovery credential
  → derive candidate identity
  → verify relay has events, unless forced
  → wipe local state and switch owner
  → pull and reload
```

#### Inputs

- A native `sf1_` recovery key or BIP39 phrase.
- Optional `{ force: true }`.
- Current relay list.

#### Transformations

1. The credential is validated and deterministically derived.
2. Unless forced, the engine queries configured relays for one event belonging
   to the candidate owner. It refuses to wipe current data when no relay is
   configured, all relays are unavailable, or a reachable relay has no backup.
3. After verification it acquires the tab-exclusive barrier, persists the new
   credential, wipes local application/internal state, records legacy import as
   complete, swaps identity, and refreshes queries.
4. It requests a sync and reloads so the empty local database rebuilds from the
   relay.
5. `resetAppOwner()` follows the same destructive switch path but generates a
   fresh mnemonic and does not restore remote state.

#### Outputs

- A local engine switched to the recovered owner, or a fresh empty owner after
  reset.
- Remote reconstruction through ordinary pull/LWW rather than a special restore
  protocol.

#### Failure/retry boundary

- Verification has a 10-second timeout per relay and tries the next configured
  relay after failure.
- A valid but wrong/empty credential does not wipe local data unless `force` is
  explicit.
- Relay `404` means that relay has never registered the owner and does not count
  as a verified non-empty backup.
- The destructive tab barrier is acquired only after preflight succeeds, so a
  failed credential check does not reboot sibling tabs.

#### Source anchors

- [owner switch primitive](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L394-L407)
- [relay-verified owner restore](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L555-L640)
- [fresh-owner reset](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L642-L647)
- [restore safety tests](../../packages/simplysync-engine/test/engine.test.ts#L366-L493)

### 10.4 Legacy SQLite import

```text
legacy database with matching table layout
  → validate/sanitize each row
  → normal current-engine mutations
  → current rows + fresh replication events
```

#### Inputs

- A legacy database name and the current schema.

#### Transformations

1. The importer opens the legacy database and reads every matching table that
   exists.
2. Existing destination ids are skipped.
3. Required SQLite booleans that are `NULL`/missing are normalized to false.
4. Every remaining row passes through normal `upsert`, validation, HLC, outbox,
   sealing, and replication.
5. Invalid rows are counted and up to 20 reasons are logged.
6. A versioned `legacyImported` marker prevents repeated import.

#### Outputs

- Valid legacy rows in the current database.
- New SimplySync events that can propagate them through current relays.
- `{ imported, skipped }` counts.

#### Failure/retry boundary

- Missing tables are skipped independently.
- An unreadable or incompatible legacy database is best-effort and leaves the
  current data intact.
- The completion marker is written even after the outer legacy open/read fails,
  so the same importer version will not automatically retry a transient failure.

#### Source anchors

- [legacy import implementation](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L472-L553)
- [legacy import version](../../packages/simplysync-engine/src/engine/constants.ts#L30-L33)

---

## 11. Relay status, diagnostics, scheduling, and retry

```text
sync triggers + per-relay outcomes
  → coalesced sync passes
  → progress/state/log updates
  → normal polling or backoff
```

### Inputs

- Explicit `engine.sync()` calls.
- Local normal mutations.
- Startup with configured transports.
- Poll timer, defaulting to five seconds.
- Browser `online`, `focus`, and `visibilitychange` signals.
- Transport changes and leader promotion.
- Relay HTTP outcomes and `/v1/status` responses.

### Transformations

1. Concurrent `sync()` callers share one active drain promise. A call arriving
   during a pass queues a follow-up so awaiting it covers writes made before that
   call; concurrent callers coalesce rather than multiplying round trips.
2. Only the browser-tab leader runs relay work.
3. A pass seals pending outbox entries and replays deferred events even when no
   relay is attached.
4. With relays, public state changes to `SyncStateIsSyncing`; large push/pull
   drains re-emit live pending/pulled/applied progress.
5. Every relay is contacted independently and its last success/failure is kept
   separately.
6. The pass appends bounded device-local diagnostics only for activity or
   failure, avoiding writes on every idle poll.
7. Overall `SyncStateIsSynced` means at least one configured relay succeeded.
   A failed redundant relay remains visible through `getRelayStatuses()`.
8. `getRelayStatuses()` performs live `/v1/status` requests. A `404` is treated
   as an unregistered/empty owner and followed by `/health` to report relay
   reachability/version.
9. After success, poll cadence returns to normal. Auth rejection, quota
   exhaustion, bad requests, and rate limiting switch polling to five minutes.
10. Removing all transports stops polling; adding transports requests a prompt
    sync and starts it.

### Outputs

- `SyncStateInitial`, `SyncStateIsSyncing`, `SyncStateIsSynced`, or
  `SyncStateIsNotSynced` for application UI.
- Per-relay reachability, last success/failure, server version, quota use,
  event/stream counts, and head sequence.
- A most-recent-first `_sync_log` capped at 200 rows.
- An outbox pending count and coalesced completion promise for scripted/CLI
  callers.

### Failure/retry boundary

| Failure | Classification | Poll behavior |
| --- | --- | --- |
| Browser reports offline | `offline` | Normal cadence |
| Fetch rejects otherwise | `unreachable` | Normal cadence |
| HTTP 401/403 | `authRejected`, terminal | Five-minute backoff |
| HTTP 413 | `quotaExceeded`, terminal | Five-minute backoff |
| HTTP 429 | `rateLimited`, nonterminal | Five-minute backoff |
| Other 4xx | `badRequest`, terminal | Five-minute backoff |
| 5xx | `serverError` | Normal cadence |
| Decrypt/apply row failures | Diagnostic `decryptFailed`/`applyFailed` | Other events continue |

- Focus, online, visibility, local write, explicit sync, and transport change can
  still request an immediate retry during backoff.
- Per-relay network/HTTP failures are caught inside the pass. `await sync()`
  usually resolves after state/log updates; callers should inspect sync state or
  relay status rather than expect a thrown network error.
- Ordinary push, pull, and status fetches have no request timeout. A fetch that
  never settles can keep the active sync drain pending indefinitely.
- The public failure union includes `timeout`, but the regular relay classifier
  does not currently emit it. The owner-restore preflight has its own explicit
  timeout.
- The log is device-local and never replicated.

### Source anchors

- [sync state and failure contracts](../../packages/simplysync-engine/src/engine-types.ts#L318-L410)
- [error classification and relay health](../../packages/simplysync-engine/src/engine/relay.ts#L57-L132)
- [sync pass and public state](../../packages/simplysync-engine/src/engine/relay.ts#L582-L774)
- [coalesced sync drain](../../packages/simplysync-engine/src/engine/relay.ts#L776-L830)
- [live relay status](../../packages/simplysync-engine/src/engine/relay.ts#L832-L896)
- [polling and transport changes](../../packages/simplysync-engine/src/engine/relay.ts#L898-L928)
- [diagnostic log storage](../../packages/simplysync-engine/src/engine/store.ts#L201-L279)
- [sync-await tests](../../packages/simplysync-engine/test/sync-await.test.ts#L100-L176)
- [per-relay status tests](../../packages/simplysync-engine/test/relay-status.test.ts#L57-L258)

---

## Adjunct utility pipelines

These helpers ship from `@simplysync/engine`, but they are modeling/query tools
around the durable engine rather than additional relay merge protocols.

### A. Ephemeral presence

#### Inputs

- Topic, stable sender id, pluggable ephemeral message transport, state value,
  optional TTL, and optional clock.

#### Transformations

- Publish records the local sender value and broadcasts JSON.
- Receive ignores malformed JSON, other topics, and self echoes.
- Peer values are timestamped with the receiving device's clock.
- `list()` lazily removes the effect of entries older than the TTL.

#### Outputs

- A live last-value-per-sender list and change notifications.
- Same-origin presence through the supplied `BroadcastChannel` adapter, or
  cross-device presence through a host-provided transport.

#### Failure/retry boundary

- Presence is never persisted, encrypted by this helper, put in the outbox, or
  recovered after disconnect.
- The host must heartbeat roughly every `ttlMs / 2`.
- TTL expiration itself does not schedule a subscriber notification; expiration
  becomes visible on the next `list()`/render or transport event.

#### Source anchors

- [presence model and channel](../../packages/simplysync-engine/src/presence.ts#L1-L128)
- [memory and BroadcastChannel transports](../../packages/simplysync-engine/src/presence.ts#L130-L180)

### B. Conflict-free counter modeling

#### Inputs

- Counter key and signed increment amount.

#### Transformations

- Every increment inserts a distinct immutable delta row through the normal
  engine mutation pipeline.
- A reactive query computes `coalesce(sum(delta), 0)` for one key.

#### Outputs

- A convergent total in which concurrent devices do not overwrite one shared
  integer row.

#### Failure/retry boundary

- This is a data-model pattern, not special CRDT merge code.
- Delta rows grow with the number of increments. Only author-local compaction is
  safe without a wider coordination protocol.

#### Source anchors

- [delta-row model and helpers](../../packages/simplysync-engine/src/counter.ts#L1-L99)

### C. Fractional ordering

#### Inputs

- Optional lower/upper neighboring keys, or a count for initial spreading.

#### Transformations

- `keyBetween` validates base-62 fractional keys and finds a lexicographic
  midpoint.
- `keysBetween` recursively bisects an interval to keep initial keys short.
- `compareOrderKeys` compares the fractional key and then id.

#### Outputs

- A new key that changes only the moved/inserted row, avoiding list-wide
  renumbering under LWW.

#### Failure/retry boundary

- Invalid or reversed bounds throw.
- Concurrent inserts into the same slot can mint equal keys; every query/sort
  must use stable `id` as the secondary key.
- Repeated insertion into narrow intervals can lengthen keys; no automatic
  rebalance runs.

#### Source anchors

- [fractional key algorithm](../../packages/simplysync-engine/src/order.ts#L1-L156)

### D. Portable text search

#### Inputs

- Developer-selected column names and raw user search text.

#### Transformations

- The input is trimmed, lowercased, and split on whitespace.
- `%`, `_`, and `\` are escaped for literal SQLite `LIKE` matching.
- Terms are ANDed; selected columns are ORed for each term.
- Values remain bound parameters while column identifiers come from the host
  query definition.

#### Outputs

- A composable Kysely predicate that keeps the host query's result type,
  ordering, pagination, and tombstone policy.

#### Failure/retry boundary

- Empty search text or an empty column list matches all rows.
- This uses portable `LIKE`, not FTS; it scans and has no ranking.
- SQLite `lower()` is ASCII-oriented unless the platform SQLite build includes
  ICU.

#### Source anchors

- [search semantics and predicate builder](../../packages/simplysync-engine/src/search.ts#L1-L74)

---

## Load-bearing invariants

The pipelines above depend on a small set of rules that should be treated as
protocol or data migrations rather than ordinary refactors:

1. A normal local row and its durable replication intent commit atomically when
   its HLC/event id is unique; callers supplying `updatedAt` must preserve that
   uniqueness.
2. Plaintext payloads never cross the device/relay boundary.
3. `updatedAt`, payload `hlc`, and envelope `eventId` identify the same version.
4. HLC wire shape remains fixed-width and lexicographically sortable.
5. Remote row application is whole-row LWW; stale and equal versions do not win.
6. Delete is a replicated tombstone, not an ordinary hard delete.
7. A pull cursor is persisted only after its page has been durably processed.
8. Future/unknown authenticated events are retained for later replay.
9. Every current relay needs an exact event acknowledgement before outbox prune.
10. The relay remains payload-blind: only clients validate, decrypt, and apply
    application data.

These invariants are exercised by the engine and protocol test suites, including
[write atomicity](../../packages/simplysync-engine/test/write-atomicity.test.ts),
[pull batching](../../packages/simplysync-engine/test/pull-batching.test.ts),
[relay apply](../../packages/simplysync-engine/test/relay-apply.test.ts),
[multi-relay delivery](../../packages/simplysync-engine/test/multi-relay.test.ts),
[tab coordination](../../packages/simplysync-engine/test/tab-sync.test.ts), and
[blob cryptography](../../packages/simplysync-protocol/test/blob.test.ts).
