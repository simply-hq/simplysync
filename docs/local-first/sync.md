# Sync & the relay

This is the networked half of [How it works](./architecture.md): how the engine
turns local writes into encrypted events, ships them through a relay, and applies
what comes back — plus the relay's wire protocol, storage, and threat model.

Everything here is built on one guarantee: **the relay only ever sees ciphertext.**
All encryption and decryption happen in the engine, on the device.

## The sync loop

`engine.sync()` (and the background poller) first repairs local state, then runs
push and pull for every configured relay. Every stage is idempotent and safe to
repeat:

**Seal.** A normal mutation has already committed its row and a plaintext-pending
outbox intent in one SQLite transaction. Before any network request,
`sealPendingOutbox()` encrypts each intent and fills its `envelope_json`. Push
explicitly ignores unsealed rows, so `payload_json` never crosses the device
boundary. Re-running the seal is harmless; already sealed rows are skipped.
With browser tab coordination, only the elected leader seals. A follower's own
pending local copy can remain unsealed until promotion, while the leader stages
and seals its separate copy for relay delivery.

**Push.** For each relay, select up to 1000 sealed outbox events that do not yet
have an exact `(eventId, relay)` acknowledgement, `POST /v1/events`, record the
acknowledgements in one transaction, and drain until no full batch remains.
`pushed_at` means "reached at least one relay"; the engine keeps an event until
every currently configured relay has acknowledged it. A newly added relay gets a
current-row backfill even if the original bounded outbox was already pruned.
Re-pushing is harmless because relays deduplicate `(ownerId, eventId)`.

**Pull & apply.** Read the opaque per-relay cursor from `_sync_meta`
(`cursor:<url>`), `GET /v1/events?after=<cursor>`, then:

- skip envelopes whose `eventId` is already in `_sync_seen`;
- decrypt and authenticate the envelope on-device;
- classify schema version, table, and HLC before interpreting the row;
- defer authenticated future-version, unknown-table, or temporarily future-HLC
  events in `_sync_deferred`;
- apply a supported row only when its HLC is **strictly newer** than the local
  row's `updatedAt`, then record the event in `_sync_seen`.

The page's applies/deferred writes and seen markers commit together. Only after
that commit does the engine persist the relay's `nextCursor`, so a crash re-pulls
and safely replays the page. Current relays issue a monotonic server `seq` cursor;
the engine deliberately treats it as opaque. The seen-set is capped at 50k by
retaining the lexicographically greatest event IDs; LWW application remains
idempotent if an event is ever replayed.

**Poll cadence & backoff.** The relay is plain HTTP with no server push, so the
engine polls (`syncIntervalMs`, default 5s) and also syncs on local writes and on
web focus/online. After a *terminal* failure (400/401/403/413) it backs the
poller off to 5 minutes so it doesn't hammer a relay that's rejecting the batch —
while still retrying immediately on focus/online/write. A `429` also uses the
five-minute backoff but remains nonterminal; network and 5xx failures retry at
the normal cadence.

## Restore on a new device

Restore is just "boot with the user's recovery phrase, then sync from an empty
cursor": derive the identity, pull everything, apply. Because events are
uniquely keyed and deduplicated by `(ownerId, eventId)` and applies are
idempotent under LWW,
the device rebuilds identical state regardless of pull order.

## The encrypted envelope (crypto)

All crypto goes through WebCrypto (`crypto.subtle`). No native crypto lives in the
core; HMAC/AES/SHA are standard subtle primitives. `@scure/bip39` is used only for
mnemonic ↔ entropy conversion.

### Secret → identity

A recovery credential has two supported forms:

- **Native `sf1_` key:** `sf1_` + base64url(32 random bytes).
- **BIP39 mnemonic:** normally 24 words / 32 bytes of entropy via
  `@scure/bip39`; valid 12-word phrases are also accepted.

The two forms use different frozen derivation schemes. They are interchangeable
as accepted API inputs, but an `sf1_` key and a mnemonic made from the same raw
entropy do **not** identify the same owner.

**Native key → HKDF-SHA256** (RFC 5869):

```
PRK     = HMAC-SHA256(salt = "sbt-local-first-v1", IKM = secret)
ownerId   = base64url(HKDF-Expand(PRK, "owner-id",   16))
dataKey   =            HKDF-Expand(PRK, "data-key",   32)   → AES-GCM key
relayAuth = base64url(HKDF-Expand(PRK, "relay-auth",  32))
streamKey =           HKDF-Expand(PRK, "stream-key",  32)
```

**Mnemonic → SLIP-21** with SimplySync's fixed labels:

```
entropy   = mnemonicToEntropy(mnemonic)                    // 32 bytes
node0     = HMAC-SHA512("Symmetric key seed", entropy)     // SLIP-21 master
node(lbl) = HMAC-SHA512(parent[0:32], 0x00 || lbl)         // per path element
slip21(p) = node(...p)[32:64]

ownerId   = base64url( slip21(["SimplySync","OwnerIdBytes"])[0:16] )
dataKey   =            slip21(["SimplySync","OwnerEncryptionKey"])  → AES-GCM key
relayAuth = base64url( slip21(["SimplySync","OwnerWriteKey"])[0:16] )
streamKey = deriveBytes(encryptionKeyBytes, "stream-key", 32)
```

> **Stability invariant.** The labels are part of the derivation: a given phrase
> must always derive the same owner id and relay auth. A locked vector in
> `packages/simplysync-protocol/test/identity.test.ts` pins this — if you change
> mnemonic derivation and that test fails, you've broken every existing user's
> identity. Add a new vector rather than editing the existing one.

### The envelope

`encryptPayload` produces a `SyncEnvelope`:

```jsonc
{
  "version": 1,
  "ownerId": "…",      // public; routing + AEAD additional data
  "eventId": "…",      // unique per owner (the engine uses the HLC)
  "deviceId": "…",     // which device produced it
  "createdAt": "ISO",  // wall clock, advisory only
  "streamId": "…",     // optional pseudonymous row grouping key
  "nonce": "base64url(12 bytes)",
  "ciphertext": "base64url(AES-256-GCM output)"
}
```

- Cipher: **AES-256-GCM**, fresh 12-byte random nonce per event.
- Plaintext: the `SyncPayload` serialized as **canonical JSON** (keys sorted
  recursively) so encryption is deterministic w.r.t. object shape.
- **AAD:** the canonical JSON of the envelope header `{version, ownerId, eventId,
  deviceId, createdAt, streamId?}`. So a relay can't change routing metadata or
  rebind ciphertext to a different event/stream without GCM verification
  failing on decrypt.
- `decryptEnvelope` rejects envelopes whose `ownerId` ≠ the identity's before
  attempting decryption.

### Binary blobs (images)

Large binaries are kept out of the JSON log and synced lazily, the iCloud way:
small **manifests** travel through the normal event log; the chunk **bytes** are
stored as binary BLOBs and fetched on demand.

`encryptBlob(identity, data, { mimeType, chunkSize? })`:

- Splits `data` into `chunkSize` plaintext chunks (default 256 KiB).
- Encrypts each chunk with the data key (AES-256-GCM, fresh nonce). The AAD is
  `canonicalJson({ v: 1, ownerId, blobId, index })`, binding every chunk to its
  owner, blob, and position — a relay can't swap or reorder chunks without GCM
  failing.
- Stores each as `nonce ‖ ciphertext`, **content-addressed** by its SHA-256
  (base64url). That hash is the relay key, the integrity check, and free dedup.
- Returns a `BlobManifest` (`{ version, ownerId, blobId, mimeType, byteSize,
  chunkSize, chunks: [{ hash, size, plaintextSize }], sha256, createdAt }`) plus
  the encrypted chunks. The manifest is tiny and is emitted as an ordinary
  `SyncPayload` with `table: "blob"`.

Reads use `decryptBlobChunk` (one chunk, hash-verified before decrypt — good for
streaming) or `decryptBlob` (reassembles and verifies the whole-blob `sha256`).
Devices only download chunks they actually open, so gigabytes of media stay
workable on a phone.

## The relay wire protocol

The relay exposes a tiny HTTP API with permissive CORS. Control and event
responses are JSON; blob downloads return encrypted binary bytes, and `HEAD`
returns no body. Auth is a bearer token equal to `identity.relayAuth` (the
owner's `writeKey`).

### `POST /v1/events` — push

```
Authorization: Bearer <relayAuth>
Body: { "ownerId": string, "events": SyncEnvelope[] }
→ 200 { "accepted": number, "duplicate": number }
```

- First push for an unknown `ownerId` **registers** the owner, storing
  `sha256Base64Url(relayAuth)` (trust-on-first-use). Later requests must present a
  token whose hash matches, else `401`.
- Each envelope is validated (`version === 1`, owner match, required fields).
  Insert is `INSERT OR IGNORE` on `(owner_id, event_id)` → re-pushing is
  idempotent and counts as `duplicate`.
- Limits: `> MAX_EVENTS_PER_PUSH` → `413`; an envelope over `MAX_EVENT_BYTES` →
  `413`; exceeding `MAX_OWNER_BYTES` → `413`. The Cloudflare relay validates
  the whole request before committing its D1 batch, so a limit error commits no
  events and adds no usage charge.

### `GET /v1/events` — pull

```
?ownerId=<id>&after=<cursor>&limit=<n>   (Bearer auth)
→ 200 { "events": SyncEnvelope[], "nextCursor": string }
```

- Keyset pagination: parse `after` as the relay-issued sequence, then
  `WHERE owner_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`. An empty or legacy
  nonnumeric cursor starts from zero. `nextCursor` is the last server `seq`
  returned — store it opaquely and pass it back next time.
- `limit` is clamped to `[1, MAX_EVENTS_PER_PULL]`, defaulting to
  `DEFAULT_EVENTS_PER_PULL`.
- Pull requires an *existing* owner (`404` if unknown) and a matching auth hash.

### `PUT` / `GET` / `HEAD /v1/blobs/:hash` — blob chunks

```
PUT  ?ownerId=<id>  body: raw encrypted chunk bytes → { stored, duplicate }
GET  ?ownerId=<id>  → 200 application/octet-stream (raw encrypted bytes), 404
HEAD ?ownerId=<id>  → 200 / 404   (skip re-uploading a chunk the relay has)
```

- `:hash` must equal `sha256Base64Url(body)` — the server recomputes it and
  rejects a mismatch (`400`), so clients can't choose arbitrary keys.
- Existing hashes short-circuit *before* the body is read (dedupe). A chunk over
  `MAX_BLOB_BYTES` → `413`. First upload registers the owner (TOFU), like push.
- `GET` is served `Cache-Control: immutable` — safe because the body is encrypted
  and content-addressed.

### `GET /v1/status`, `GET /v1/usage` & `GET /health`

```
GET /v1/status ?ownerId=<id> (Bearer) → { server, account }   (404 if owner unknown)
GET /v1/usage  ?ownerId=<id> (Bearer) → { ownerId, storedBytes }
GET /health                           → { ok: true, service: "…", version, serverTime }
```

`/v1/status` is the one-call health + storage surface the engine's
`getRelayStatuses()` consumes:

```jsonc
{
  "server":  { "version": "1.0.0", "serverTime": "…" },
  "account": {
    "ownerId":    "…",
    "quotaBytes": 1073741824,   // MAX_OWNER_BYTES on this relay
    "usedBytes":  52428800,     // this owner's stored_bytes (events + blobs)
    "usedPct":    4.88,
    "headSeq":    42,           // newest event seq for this owner (pull head)
    "streams":    7,            // distinct streams ≈ live rows
    "events":     21,           // raw stored events (shrinks on compaction)
    "createdAt":  "…"
  }
}
```

A `404` means the relay is up but has never seen this owner (nothing pushed
yet) — clients should read that as "healthy, empty account" and may confirm
liveness via `/health`.

### Two different orders

The relay's monotonic server `seq` is only a skip-proof pagination order. The
engine still sets `eventId = payload.hlc`, and that HLC is the conflict order.
Correctness comes from authenticated clients applying row-level LWW, not from
the order in which the relay returns events.

The monotonic cursor is a relay contract. The engine stores it opaquely and
checks only whether `nextCursor` differs from the previous string; it does not
prove numeric forward progress. A custom relay that regresses or oscillates its
cursor can cause replay or an indefinitely draining sync call.

## Cloudflare relay

The public relay deployment lives in `apps/relay-cloudflare`. Your app only
needs the HTTPS Worker URL printed by the [self-hosting setup](./self-hosting.md).
The same URL works in browsers, simulators, emulators, and physical devices.

Cloudflare stores event metadata and encrypted envelopes in D1. Encrypted,
content-addressed blob chunks live in R2. Table names, row values, MIME types,
and image contents remain inside ciphertext.

### Limits

The defaults in `apps/relay-cloudflare/wrangler.toml` bound storage and reject
oversized requests before they become expensive:

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_OWNER_BYTES` | `1073741824` (1 GiB) | Per-owner quota shared by events and blob chunks. |
| `MAX_EVENT_BYTES` | `262144` (256 KiB) | Maximum encrypted envelope size. |
| `MAX_BLOB_BYTES` | `8388608` (8 MiB) | Maximum encrypted blob-chunk size. |
| `MAX_EVENTS_PER_PUSH` | `1000` | Maximum envelopes in one push. |
| `MAX_EVENTS_PER_PULL` | `5000` | Hard cap for one pull page. |
| `DEFAULT_EVENTS_PER_PULL` | `1000` | Pull size when the client omits `limit`. |
| `MAX_OWNERS` | `100000` | Fleet-wide owner cap. |
| `RELAY_DISABLED` | `false` | Emergency switch that rejects writes when enabled. |

At the per-owner quota, the relay returns `413` and the engine reports a
terminal `SyncStateIsNotSynced`. Use `engine.getRelayStatuses()` to warn before
that point. Scheduled compaction reclaims superseded events every six hours;
you can also raise `MAX_OWNER_BYTES` in your deployment.

### Compaction

For each `(owner_id, stream_id)`, compaction keeps the event with the maximum
`event_id` and removes older versions. This is safe because `eventId === hlc`,
so the survivor is the same row state a fresh client would choose by LWW.
Cloudflare runs the pass from a Cron-triggered Worker and updates the owner's
stored-byte count afterward.

Blob-chunk garbage collection is separate and is not automated. A superseded
manifest may leave orphaned encrypted chunks because only the client knows
which chunks the manifest references.

Workers, D1, and R2 bill per use. The deployment therefore combines Cloudflare
DDoS protection, rate-limit bindings, cheap-path rejection, hard quotas, the
global owner cap, and the write kill switch. Full configuration lives in the
[`relay-cloudflare` README](../../apps/relay-cloudflare/README.md).

## Threat model

What an honest-but-curious or actively malicious relay **cannot** do:

- Read payloads — AES-256-GCM with a key derived from the user's secret, which
  never leaves the device.
- Forge or alter accepted payloads — GCM tags fail and clients reject them; the
  header is AAD, so it can't be rebound.
- Tamper with, swap, or reorder blob chunks — each is content-hash-verified
  before decryption and AEAD-bound to its owner/blob/index.
- Learn the data key or recovery secret from `relayAuth` — independent
  HKDF/SLIP-21 outputs.

What it **can** do (accepted limitations):

- **Availability/integrity of the log:** withhold, delay, reorder, or delete
  events (deny service, serve stale state).
- **Metadata:** observe owner ids, device ids, event counts, sizes, and
  timestamps. Owner ids are pseudonymous but stable. With compaction it also sees
  `stream_id` — a stable pseudonymous key per logical row — so it can count an
  owner's distinct rows and how often each changes. It cannot reverse a
  `stream_id` to its table/row (HMAC under a key it never holds) or forge it
  (AAD-bound).
- **Capability model, not identity:** anyone holding an owner's `relayAuth` can
  push/pull for that owner. Treat it as sensitive; there's no account/login layer.

Mitigations live at the edges: clients dedupe and apply idempotently (replays are
harmless), use soft deletes (withheld deletes self-heal on next sync), and the
relay enforces per-owner quotas. The fuller walkthrough with source citations is
in [SECURITY.md](../../SECURITY.md).

## Extending the protocol — guidelines

- **Versioning:** `SyncEnvelope.version` and `SyncPayload.schemaVersion` default
  to `1`. Additive tables/columns stay on version 1. If payload meaning changes,
  bump the engine config's `schemaVersion`; older clients durably defer the
  opaque payload, and an upgraded client replays it after declaring support.
  Bump and branch rather than mutating meaning in place — old envelopes live
  forever in the log.
- **Backwards-compat tests are load-bearing.** Any change near key derivation must
  keep `identity.test.ts` green. Add a new vector rather than editing the existing
  one.
- **Keep the relay dumb.** Resist server-side filtering/queries that would require
  it to understand payloads — that breaks the privacy model.
- **Canonical JSON is part of the contract.** `encryptPayload` sorts keys and
  authenticates the header as AAD; changing serialization breaks decryption of
  existing data.
- **New crypto stays in the core, on WebCrypto.** That's what keeps it portable
  across Node/Bun/web/RN.

## What happens if…

### …the relay's data is reset or lost?

**No user data is lost — every device still holds the whole database locally.**
The relay is a delivery buffer, not a backup. In most cases the fleet also
repairs itself automatically, because the engine detects a reset explicitly.

**The repair path.** A pull that 404s is normally "this owner hasn't pushed yet",
which is why a fresh install doesn't report an error. But a 404 on a relay this
device has *already pulled from* (a non-empty stored cursor) means the account is
gone, not merely absent. That triggers `handleWipedRelay`, which forgets the
relay entirely — the `(eventId, relay)` acknowledgements, the `cursor:`, `push:`,
and `backfill:` keys — and rebuilds the outbox with one canonical upsert per
current row. The device re-uploads its state, and `getRelayStatuses()` reports
`reseeding` so a UI can say "re-uploading" rather than "synced".

Note what the re-seed carries: **current rows, not history**. A relay holding
42 events over 2 rows comes back with 2. Older revisions are gone for good —
they were never a backup.

**The gap: a peer that never sees the 404.** Detection is per device, and it
needs that device to pull while the account is still missing. If another device
syncs first, its re-seed recreates the owner, and every peer that pulls
afterwards gets a normal `200` with an empty page — no 404, no repair. Those
peers keep a cursor from before the wipe, while the relay's `seq` counter
restarted from 0 and the re-seed only pushed it back up to the current-row count.
`where seq > cursor` matches nothing, so **the peer silently stops receiving —
reporting "synced" the whole time.** It resumes only once the relay has issued
more `seq` than it ever had before the wipe, and everything in the gap is lost to
that device. Its own writes still push normally, so the divergence is one-way:
the re-seeded device sees the stale one, not the reverse.

The `/v1/status` backstop doesn't cover this. It re-seeds on `headSeq` behind the
local cursor, but only when `account.events` is `0` — and a re-seeded relay has
events. (That guard is deliberate: stream compaction can legitimately lower
`headSeq`, and treating it as loss would re-seed healthy relays.) It is also
reached only through `getRelayStatuses()`, which is a UI call, not part of the
sync loop.

**Recovery for a stranded device: give the relay a new base URL** — a new
hostname, or just a path prefix like `https://relay.example.com/v2`. Every key
in `_sync_meta` is scoped by base URL, so a new one starts from an empty cursor
and re-seeds. Treat the URL as an opaque key: even a trailing-slash difference
counts as a different relay.

Two resets that are **safe**: deleting event rows while keeping `relay_meta`
(the `seq` counter keeps climbing, so no cursor can be stranded), and the relay's
own [compaction](#compaction), which never reuses a `seq`. Only discarding the
counter — a deleted database file, a fresh deploy, a restore from an older
backup — can strand a peer.

### …I lose my recovery phrase?

Every key derives deterministically from that phrase
(`packages/simplysync-protocol/src/crypto.ts`), so there is no reset and no
operator who can help — without it the relay's copy stays unreadable ciphertext
forever. It is not lost while you still have one working device, though: each
device keeps the phrase in platform secure storage and can display it again
(in the TodoList clients, **⋯ → Show recovery key**). Losing the phrase *and*
every device is the one unrecoverable case.

### …I lose every device, but the relay is intact?

Nothing is lost — that's [Restore on a new device](#restore-on-a-new-device).
Note the asymmetry with the case above: the relay alone can restore you, the
phrase alone can restore you, and losing both at once cannot be recovered from.

### …two devices edit the same row while offline?

Last write wins by HLC, and the unit is the **whole row**, not the field. If one
device edits a note's title and the other edits its body, the row with the
greater HLC replaces the other outright — the losing device's edit to the *other*
column is gone. `compareHlc` is the only tiebreaker; there is no merge.

### …a device's clock is wrong?

Each pull absorbs the physical time of the HLCs it sees, so a later local write
can never sort below an edit already applied. That absorption is bounded by
`HLC_MAX_FUTURE_DRIFT_MS` (5 minutes), which stops one device with a far-future
clock from dragging the whole fleet forward. Events stamped beyond the bound are
held in `_sync_deferred` with a retry time and applied once wall time catches
up — deferred, never dropped.

### …the relay operator turns hostile?

They cannot read anything ([threat model](#threat-model)). They *can* delete or
withhold — which lands you in the relay-reset case above, detected and re-seeded
but with blobs gone. Confidentiality is
what the design guarantees; availability is what self-hosting is for.

## Known limitations / roadmap hooks

- Row-level LWW only; no field-level merge or richer CRDTs.
- Single owner per client; no sharing/multi-owner yet.
- No transport compression or batching backpressure beyond the push/pull caps.
- Blob chunks are never auto-deleted: reclaiming bytes from a soft-deleted
  manifest needs an offline relay GC pass. Out of scope for v1.
- Relay auth is a bearer capability; rotating the write key is not implemented.
- Legacy import is row-level only — historical ciphertext from other systems
  isn't importable (different envelope format); rows are re-emitted as envelopes.
