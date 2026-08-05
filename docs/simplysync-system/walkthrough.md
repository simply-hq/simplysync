# One row through SimplySync

This walkthrough follows one `todo` row from Device A to Device B. Both devices
use the same recovery credential and relay, but each has its own local SQLite
database and device identifier. The example uses the TypeScript engine; the
brief [native note](#native-and-platform-scope) explains where the Swift and
Kotlin write path differs.

The central invariant is:

> **The network is not on the local-write critical path.** A normal mutation
> succeeds or fails on its local SQLite transaction. Sealing, pushing, pulling,
> and convergence happen afterward.

Assume both devices declare a `todo` table and Device A calls:

```ts
engine.insert("todo", { title: "Buy milk", done: 0 });
```

`update`, `upsert`, and `delete` enter the same pipeline. A delete changes the
row into a soft-delete tombstone; it does not hard-delete the SQLite row.

## The main path

### 1. Boot two devices into one owner

**Input:** The same `sf1_` recovery key or BIP39 phrase on both devices, the
same schema and relay URL, separate secure storage, and separate SQLite
databases.

**Transformation:** Each device deterministically derives the same `ownerId`,
AES-GCM data key, relay bearer capability, and stream key from the credential.
Each also loads or creates its own random `deviceId`. Boot opens SQLite, creates
or migrates application and `_sync_*` tables, replays any now-supported deferred
events, restores the HLC high-water mark, hydrates queries, starts the tab bridge,
and starts opportunistic relay polling when transports exist.

**Output:** Device A and Device B have independent local sources of truth, but
they can authenticate and decrypt the same owner's envelopes. Their distinct
device identifiers keep independently minted HLC event IDs distinct.

The derivation is deterministic across devices
([protocol identity](../../packages/simplysync-protocol/src/index.ts#L88-L181));
device identity and boot sequencing live in
[the lifecycle](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L340-L470).
A fresh owner may receive `404 Unknown owner` on pull until its first push
establishes the relay's trust-on-first-use capability
([client handling](../../packages/simplysync-engine/src/engine/relay.ts#L381-L408),
[relay auth](../../apps/relay-go/store.go#L108-L181)).

### 2. Turn the call into a prepared row and event intent

**Input:** The table name `todo` and values `{ title: "Buy milk", done: 0 }`.

**Transformation:** The mutation path checks that the database and table exist,
creates an ID, coerces supplied values through the declared schema, and merges
them with any existing row. It assigns `createdAt`, defaults `isDeleted` to `0`,
and mints a new HLC for `updatedAt`. A caller-supplied `updatedAt` is accepted
only if it is a valid, non-future SimplySync HLC.

It also builds a plaintext sync intent with this logical shape:

```text
schemaVersion, table, op="upsert", rowId, hlc, value=<complete merged row>
```

Even a delete uses the upsert-shaped event; `value.isDeleted = 1` carries the
tombstone.

**Output:** A validated `PreparedRow` and its JSON event intent. No row has been
committed yet, so validation failure returns without partial state.

See
[prepareRow and buildOutboxPayload](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L62-L156)
and
[HLC construction](../../packages/simplysync-engine/src/engine/store.ts#L836-L890).

### 3. Commit the row and its durable pending intent together

**Input:** The prepared row, HLC event ID, and plaintext event JSON.

**Transformation:** One synchronous SQLite transaction performs both writes:

1. Upsert the complete row into `todo`.
2. Insert `_sync_outbox(event_id, payload_json, envelope_json, pushed_at)` with
   the plaintext intent in `payload_json`, `envelope_json = ''`, and
   `pushed_at = NULL`.

The empty envelope is an explicit **plaintext-pending** state: durable enough to
survive a crash, but not eligible for transport. `payload_json` has the same
local trust level as the plaintext application row. If either SQLite write
fails, the transaction rolls back both.

**Output:** Device A now durably owns the new row and an exact replication
intent. There has been no encryption await and no network request inside this
transaction.

This boundary is implemented in
[the mutation transaction](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L169-L217)
and
[the pending-outbox insert](../../packages/simplysync-engine/src/engine/store.ts#L600-L618).
The rollback and immediate pending-state behavior are asserted in
[write-atomicity tests](../../packages/simplysync-engine/test/write-atomicity.test.ts#L108-L166).

This example lets the engine mint its HLC, so `event_id` is unique. If an import
caller supplies `updatedAt`, that value becomes the outbox primary key and must
not be reused for a different emitted event; the outbox insert is
`INSERT OR IGNORE`, so a collision can discard the later intent without rolling
back its row.

### 4. Publish Device A's local result immediately

**Input:** The committed `todo` table change.

**Transformation:** The engine starts replication as fire-and-forget work,
publishes the committed event to any sibling browser tabs, and reruns cached
queries that depend on `todo`. Query listeners fire only if the structural row
set actually changed.

**Output:** `insert` returns synchronously with the row ID, and Device A's query
can show “Buy milk” immediately. Offline, slow, rejecting, or absent relays do
not undo this result.

See
[post-commit publication](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L158-L167),
[mutation completion](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L204-L216),
and
[reactive query refresh](../../packages/simplysync-engine/src/engine/query-cache.ts#L14-L20).

### 5. Seal the pending intent asynchronously

**Input:** An outbox row whose `envelope_json` is empty and whose
`payload_json` contains the local event intent.

**Transformation:** At the beginning of `sync()`, the relay loop parses the
intent and encrypts canonical payload JSON with the owner's AES-GCM data key and
a fresh random nonce. The authenticated envelope header contains `version`,
`ownerId`, `eventId`, `deviceId`, `createdAt`, and a pseudonymous per-row
`streamId`; that header is AES-GCM additional authenticated data. The resulting
envelope is written back only while `envelope_json` is still empty, making the
seal idempotent.

**Output:** Device A has a transportable opaque envelope. A relay can receive
only non-empty `envelope_json`; it never receives `payload_json`. The local
plaintext intent may remain beside the sealed envelope until the outbox row is
pruned.

A crash after Step 3 but before this step is recoverable: the first later
`sync()` seals the still-pending intent before attempting any push. A corrupt
pending intent raises a seal error and is skipped rather than leaking or
blocking unrelated events.

See
[sealPendingOutbox](../../packages/simplysync-engine/src/engine/relay.ts#L134-L169),
[AES-GCM sealing](../../packages/simplysync-protocol/src/index.ts#L289-L357),
and the
[boot-reconciliation test](../../packages/simplysync-engine/test/write-atomicity.test.ts#L228-L297).

### 6. Push with exact per-relay delivery tracking

**Input:** The sealed envelope and the current set of relay base URLs.

**Transformation:** For each relay independently, the engine selects at most
1,000 sealed outbox rows that do **not** have an exact
`_sync_outbox_relay(event_id, relay)` acknowledgement. It sends those envelopes
in `POST /v1/events`, with `ownerId` in the body and `relayAuth` as a bearer
capability.

The local `push:<relay>` event-ID high-water mark is useful metadata, but it is
not accepted as delivery proof. Exact per-event, per-relay acknowledgement is
necessary because a cross-tab or offline event can arrive later with an HLC that
sorts below that high-water mark.

**Output:** Each configured relay is targeted independently. Delivery is
at-least-once across an ambiguous network failure; the relay's event-ID dedupe
makes a retry harmless. A failure at relay R2 does not erase R1's success and
remains retryable.

See
[per-relay selection and POST](../../packages/simplysync-engine/src/engine/relay.ts#L171-L225)
and
[the exact acknowledgement table](../../packages/simplysync-engine/src/engine/store.ts#L162-L170).

### 7. Let the relay validate, deduplicate, and assign server `seq`

**Input:** The bearer token, body owner ID, and sealed envelope. The relay sees
the envelope header and ciphertext, not the decrypted payload.

**Transformation:** The Go relay bounds and parses the request, checks envelope
shape and HLC admissibility, authenticates the owner capability, applies rate
and quota limits, and runs one serialized SQLite transaction. Its primary key
deduplicates `(owner_id, event_id)`. Every genuinely new event consumes the next
global monotonic integer `seq`; a duplicate consumes no new sequence.

`eventId` and relay `seq` serve different purposes:

- `eventId` is the device-created HLC used for row conflict resolution.
- `seq` is relay insertion order used only as a skip-proof pull cursor across
  independently clocked devices.

**Output:** Push returns `{ accepted, duplicate }`. The assigned `seq` is stored
with the opaque envelope; it is not returned by the push response. It becomes
visible to clients indirectly as the next pull cursor.

See
[push validation](../../apps/relay-go/handlers.go#L78-L142),
[atomic insert and sequence allocation](../../apps/relay-go/store.go#L253-L330),
and
[the sequence invariant](../../apps/relay-go/store.go#L82-L96).

### 8. Record Device A's relay acknowledgement

**Input:** A successful relay push response.

**Transformation:** In one local transaction, Device A sets `pushed_at` if this
is the event's first successful relay and inserts the exact
`(event_id, relay)` delivery acknowledgement. It advances `push:<relay>` only
monotonically.

After a sync pass, an outbox event is pruned only when every currently
configured relay has an exact acknowledgement. Thus `pushed_at` means “reached
at least one relay,” not “reached every relay.”

**Output:** Device A has durable evidence of which relay accepted the event and
can retry only the missing copies.

See
[acknowledgement updates](../../packages/simplysync-engine/src/engine/relay.ts#L207-L225)
and
[all-relay pruning](../../packages/simplysync-engine/src/engine/store.ts#L502-L538).

### 9. Pull the relay page on Device B

**Input:** Device B's `cursor:<relay>` value, or an empty cursor on first pull,
plus the same owner ID and bearer capability.

**Transformation:** Device B requests `GET /v1/events?ownerId=...&after=...`.
The relay selects that owner's envelopes where `seq > after`, orders them by
ascending `seq`, applies the page limit, and returns the raw envelopes plus the
last sequence as `nextCursor`.

**Output:** Device B receives the sealed “Buy milk” envelope and a skip-proof
server cursor. Relay compaction may remove older envelopes, but sequence values
are never reused.

See
[client pull construction](../../packages/simplysync-engine/src/engine/relay.ts#L381-L413)
and
[relay sequence query](../../apps/relay-go/store.go#L332-L362).

### 10. Decrypt, authenticate, and classify before opening a transaction

**Input:** The pulled envelope page and Device B's locally derived identity.

**Transformation:** Device B skips already-seen event IDs, then asynchronously
AES-GCM-decrypts each remaining envelope outside SQLite transactions. The
authenticated header prevents ciphertext from being rebound to another owner,
event, device, time, or stream. The engine then classifies the plaintext as
supported, future-version, or invalid; checks both envelope and payload HLCs;
requires `payload.hlc === envelope.eventId`; and observes admissible supported
HLCs so Device B's next local write sorts above what it has observed.

**Output:** An in-memory page of authenticated, classified candidates. There is
still no partially applied remote row.

See
[decryption and classification](../../packages/simplysync-engine/src/engine/relay.ts#L415-L483),
[payload-version classification](../../packages/simplysync-engine/src/engine/schema-version.ts#L8-L52),
and
[envelope authentication](../../packages/simplysync-protocol/src/index.ts#L359-L389).

### 11. Apply the page through HLC last-writer-wins

**Input:** Device B's classified candidates and its current local rows.

**Transformation:** One synchronous SQLite transaction rechecks deduplication
and handles every candidate:

- Invalid or inconsistent events are terminal failures.
- Future schema/HLC or unknown-table events are retained in `_sync_deferred`.
- A supported event for a known table is projected onto Device B's known schema.
- The row is written only when its incoming HLC is greater than the local
  `updatedAt`; a newer-or-equal local row wins unchanged.
- The event ID is inserted into `_sync_seen` in the same page transaction.

Only after that transaction commits does Device B advance `cursor:<relay>` to
`nextCursor`. A crash before cursor advancement safely re-pulls an idempotent
page rather than skipping it.

**Output:** Device B's `todo` row now contains “Buy milk” unless it already had a
strictly newer version. The seen set and pull cursor make retries safe.

See
[transactional pull application](../../packages/simplysync-engine/src/engine/relay.ts#L485-L564)
and
[row-level LWW](../../packages/simplysync-engine/src/engine/store.ts#L698-L725).

### 12. Publish Device B's new query output

**Input:** The set of tables changed by successful remote application.

**Transformation:** After relay processing completes, the engine reruns only
queries that overlap changed tables and notifies their subscribers when rows
actually differ. In a coordinated browser profile, the leader also broadcasts
the applied event to follower tabs with `outbox: false`, because it already came
from the relay.

**Output:** Device B's reactive query now renders “Buy milk.” The final output is
again a local SQLite/query result; applications do not read their working data
from the relay.

See
[query refresh after sync](../../packages/simplysync-engine/src/engine/relay.ts#L726-L729),
[stable query outputs](../../packages/simplysync-engine/src/engine/query-cache.ts#L142-L186),
and
[relay-to-tab publication](../../packages/simplysync-engine/src/engine/relay.ts#L551-L553).

## Bounded browser branch: leader and followers

This branch exists only when multiple tabs coordinate the same browser database
name; it does not add another network protocol.

1. **Input:** A committed local or pulled event in any tab.
2. **Transformation:** The tab broadcasts the plaintext event within the same
   browser origin. Every other tab applies it through the same HLC/LWW path.
   For a replicated local write, recipients also stage their own pending outbox
   marker, so leadership can move without losing the fleet's backlog. A
   relay-pulled event uses `outbox: false` and is not re-enqueued.
3. **Output:** Every tab's in-memory SQLite/query view converges immediately.
   Exactly one Web-Lock leader persists sql.js snapshots, seals outbox rows, and
   talks to relays. Followers return early from relay sync and mirror the
   leader's sync state. A follower's own plaintext-pending outbox copy remains
   only in memory while it is a follower. Promotion first persists that complete
   in-memory database and then starts leader sealing; the previous leader has
   already staged and sealed its separate copy for relay delivery.
4. **Failover:** When the leader closes, the promoted follower first persists
   its in-memory copy—including received broadcasts—then starts relay work. Each
   tab has a suffix on its HLC device ID, preventing same-millisecond event-ID
   collisions.

The engine-side bridge is
[tab-sync.ts](../../packages/simplysync-engine/src/engine/tab-sync.ts#L14-L107);
leader election, snapshot healing, and promotion are in
[the browser coordinator](../../packages/simplysync-browser/src/tab-coordinator.ts#L4-L11)
and
[its Web-Lock flow](../../packages/simplysync-browser/src/tab-coordinator.ts#L80-L145).
The leader-only relay guard is explicit in
[runSyncPass](../../packages/simplysync-engine/src/engine/relay.ts#L582-L585).

## What stays on devices and what the relay sees

| Device-only data | Relay-visible data |
| --- | --- |
| Recovery key or phrase, AES-GCM `dataKey`, secret `streamKey` | Presented `relayAuth` bearer capability while handling a request; only its SHA-256 hash is persisted |
| Plaintext application tables, columns, row IDs, values, and tombstone flag | Stable pseudonymous `ownerId` and `deviceId` |
| Plaintext `_sync_outbox.payload_json` and decrypted `_sync_deferred` payloads | `eventId`/HLC, `createdAt`, nonce, ciphertext, envelope size, event count, and timing |
| Actual `(table, rowId)` behind a stream | Stable pseudonymous `streamId`, allowing per-row linkage and compaction but not reversal without `streamKey` |
| Schema meanings and query results | Relay-assigned `seq`, quotas/accounting, and connecting IP address |

The exact outer envelope and inner payload shapes are separate in
[protocol types](../../packages/simplysync-protocol/src/types.ts#L28-L59).
The security boundary and honest metadata limitations are documented in
[SECURITY.md](../../SECURITY.md#what-a-relay-can-do-honest-limitations).

## Short variations

### Offline

Steps 1–4 still complete. The row and pending outbox intent are durable, and the
local query updates. A background sync can seal even when no transport is
configured; network push simply waits. When connectivity returns, focus/online
hooks, polling, or an explicit `await engine.sync()` retry the same sealed event.
The network remains outside the local-write critical path
([replication kick](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L158-L167)).

### Concurrent conflict

If A and B edit the same row while disconnected, each commits locally with a
different HLC. Relay `seq` may deliver them in either insertion order, but it
does not choose the winner. Every device compares the row's HLC event IDs; the
greater HLC wins, so both converge after seeing both events
([HLC comparison](../../packages/simplysync-protocol/src/index.ts#L260-L268),
[LWW apply](../../packages/simplysync-engine/src/engine/store.ts#L698-L725)).

### Future schema or future HLC

An authenticated event above the app's declared schema version remains opaque
and is stored in `_sync_deferred`; an unknown table is deferred as well. A
structurally valid HLC outside the current admissible window is quarantined
rather than allowed to poison LWW ordering. Later sync passes or boot replay
retry deferred events when the app/schema or wall-clock window can accept them
([defer decisions](../../packages/simplysync-engine/src/engine/relay.ts#L512-L548),
[replay](../../packages/simplysync-engine/src/engine/relay.ts#L313-L370)).

### Local-only mutation

With `{ local: true }`, the engine writes and publishes the local row but creates
no outbox intent and starts no relay work. Browser tabs still receive the change
with `outbox: false`. A later normal mutation of that row replicates its complete
merged state
([local-only branch](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L182-L214),
[test](../../packages/simplysync-engine/test/write-atomicity.test.ts#L299-L319)).

### Multiple relays

Each relay receives the same sealed event and gets its own exact delivery row,
push metadata, pull cursor, and independent failure history. The outbox is
pruned only after every currently configured relay acknowledges the event. If a
relay is added after old outbox rows were pruned, the engine stages one current
upsert per local row for that new relay
([new-relay backfill](../../packages/simplysync-engine/src/engine/store.ts#L540-L598)).

### Tombstone

`delete("todo", id)` writes a normal LWW row with `isDeleted = 1`, then follows
the same pending-intent, seal, push, pull, and apply pipeline. Default application
queries should filter tombstones. Hard purge is separate and guards against
resurrection: the public engine permits it only for a database that has never
had relay history, even if transports are later detached. Without a durable
cross-device delete watermark, automatic sync does not hard-delete tombstones
([soft-delete preparation](../../packages/simplysync-engine/src/engine/mutations-lifecycle.ts#L100-L105),
[public purge guard](../../packages/simplysync-engine/src/engine.ts#L301-L323),
[automatic-sync policy](../../packages/simplysync-engine/src/engine/relay.ts#L728-L734)).

## Native and platform scope

The exact plaintext-pending then asynchronous-seal sequence above describes the
TypeScript engine. Swift and Kotlin preserve the same owner, envelope, HLC/LWW,
outbox, and relay wire semantics, but their native crypto paths seal first and
then commit the local row plus sealed outbox envelope together
([Swift write boundary](../../Sources/SimplySync/Engine/SyncEngine.swift#L438-L462),
[Kotlin preparation](../../apps/todolist/kotlin/src/main/kotlin/com/simplysync/kotlin/SyncEngine.kt#L510-L534)).

Browser, Node, and React Native adapters replace storage, credential, lifecycle,
and persistence plumbing; they do not change the envelope or relay protocol.
