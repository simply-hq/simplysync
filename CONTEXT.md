# SimplySync

An app-owned, end-to-end-encrypted, local-first sync engine. One person's
devices converge on one dataset through a relay that only ever holds ciphertext.
This is the shared vocabulary for the sync platform itself; an app built on
SimplySync has its own domain language on top.

## Language

### Identity

**Owner**:
The single identity that a dataset belongs to, derived from a recovery key. One
owner, many devices, no sharing between owners.
_Avoid_: account, user, tenant, workspace

**Device**:
One installation of an app holding a full local copy of an owner's data. Its
engine mints a fresh device id on every boot, never persisted, so a backup
restored onto a second phone cannot share one. The device id is only the final
tiebreaker between two edits made in the same millisecond; it identifies a
session, not a device.
_Avoid_: client, instance, node, peer

**Recovery Key**:
The root secret every other key derives from, and the only thing a user must
back up. Losing it is permanent: nothing on a relay is readable without it.
_Avoid_: seed, master key, password, credential

**Recovery Phrase**:
A recovery key expressed as a 24-word BIP39 phrase, so a user can write it down
and type it back. Interchangeable with a native recovery key everywhere.
_Avoid_: mnemonic, seed phrase, backup phrase

**Write Key**:
The bearer token a device presents to a relay, derived from the recovery key.
It proves the right to read and write an owner's stream; it cannot decrypt
anything.
_Avoid_: relay auth, token, API key, password

### The change log

**Mutation**:
A caller's write against the local database — insert, update, upsert, delete,
or a batch of them. What the app calls; not what crosses the wire.
_Avoid_: command, operation, transaction

**Event**:
One committed change to one row, the atomic unit of replication. Every event
carries the full new value of the row, never a diff.
_Avoid_: change, delta, patch, record

**Event Id**:
An event's HLC. Ordering events, deduplicating them, and resolving conflicts
are all the same comparison because the identity and the timestamp are one
value.

**HLC**:
Hybrid logical clock — the fixed-width, lexicographically sortable stamp on
every write: physical time, then a counter, then the device id. Monotonic per
device, so a backward wall clock cannot mint a stamp that sorts below existing
rows.
_Avoid_: timestamp, version, clock, vector clock

**Last-Writer-Wins**:
The one conflict rule: the event with the higher HLC wins the row, whole. There
is no field-level merging and no CRDT convergence.
_Avoid_: merge, resolve, reconcile

**Payload**:
The plaintext description of an event — table, row id, operation, HLC, and the
new value. What gets sealed; never what a relay sees.
_Avoid_: body, message, data

**Envelope**:
A sealed payload plus the routing metadata a relay is allowed to see: owner id,
event id, device id, nonce, ciphertext, timestamp, stream id. The only shape
that crosses the wire.
_Avoid_: message, packet, request

**Tombstone**:
A row marked deleted rather than removed, so the deletion itself replicates. A
row that is merely gone locally comes back from a peer.
_Avoid_: soft delete, deleted flag, archive

**Purge**:
Hard-removing a tombstone's storage on a device. Distinct from deleting: only
safe once no peer can still resurrect the row.
_Avoid_: hard delete, cleanup, vacuum

**Outbox**:
The device-local queue of events not yet acknowledged by every configured
relay. It is per-relay: an event leaves only when the last relay has it.
_Avoid_: queue, buffer, pending

**Deferred Event**:
A pulled event that decrypted and authenticated correctly but describes
something this app version does not understand yet. Retained verbatim and
replayed after an upgrade, rather than dropped or guessed at.
_Avoid_: unknown event, skipped event, quarantine

**Stream**:
All events for one logical row, grouped by a pseudonymous stream id. It lets a
relay keep only the winning event per row without learning which table or row
that is.
_Avoid_: partition, topic, channel, group

**Compaction**:
Discarding every event in a stream but the highest — the relay-side echo of
last-writer-wins. Reduces stored bytes, never changes what a device converges on.
_Avoid_: pruning, garbage collection, truncation

### Sync

**Relay**:
The optional server that stores and forwards envelopes for an owner. It is
ciphertext-only by construction: it can count, bill, and order events but never
read one.
_Avoid_: server, backend, sync service, host, broker

**Transport**:
Anywhere an owner's envelope log is parked and read back in order: a relay, or
the user's iCloud private database on Apple platforms. The engine pushes to and
pulls from every configured transport, each with its own cursor.
_Avoid_: backend, provider, storage adapter

**Ciphertext-Only**:
The relay's defining constraint: every field it stores is either opaque bytes
or routing metadata that reveals nothing about contents. Any new field must
satisfy this.

**Leader**:
When several instances share one local database — browser tabs — the single
instance that talks to relays and persists snapshots. The others apply events
through the same last-writer-wins path and mirror its sync state.
_Avoid_: primary, master, coordinator

**Ephemeral State**:
Presence, typing indicators, live cursors — real-time signals that are
worthless seconds later, deliberately kept out of the durable log. Never
persisted, never enters the outbox, never reaches a relay's storage.
_Avoid_: presence data, transient state, realtime data

### Binary data

**Blob**:
A binary attachment too large for the change log, encrypted in chunks and
fetched by hash on demand. Its existence replicates immediately; its bytes do not.
_Avoid_: attachment, file, asset, media

**Blob Manifest**:
The small syncable record describing a blob — mime type, sizes, and the ordered
chunk hashes that rebuild it. It travels the normal change log so every device
learns the blob exists before any byte is fetched.

**Database Snapshot**:
A portable, encrypted copy of an entire local database plus the recovery
credential needed to read it — the file a user carries to a new device without
a relay.
_Avoid_: backup, export, dump, archive

### This repository

**Port**:
A reimplementation of the protocol core in another language, wire-compatible by
obligation. Kotlin, Swift, and Go ports must move in lockstep with the
TypeScript one.
_Avoid_: SDK, client library, binding, implementation

**Source-Owned**:
The distribution model: an app clones and owns the exact source it ships rather
than depending on a published package. Consequences travel by copy, so a change
here is not a change there until it is ported.
_Avoid_: vendored, forked, embedded
