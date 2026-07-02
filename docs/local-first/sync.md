# Sync & the relay

This is the networked half of [How it works](./architecture.md): how the engine
turns local writes into encrypted events, ships them through a relay, and applies
what comes back — plus the relay's wire protocol, storage, and threat model.

Everything here is built on one guarantee: **the relay only ever sees ciphertext.**
All encryption and decryption happen in the engine, on the device.

## The sync loop

`engine.sync()` (and the background poller) runs two phases per relay, both
idempotent and safe to repeat:

**Push.** Select up to 1000 outbox rows where `pushed_at IS NULL`, `POST` them to
`/v1/events`, and on success stamp `pushed_at`. Re-pushing is harmless — the
relay ignores duplicates.

**Pull & apply.** Read the per-relay cursor from `_sync_meta` (`cursor:<url>`),
`GET /v1/events?after=<cursor>`, then for each returned envelope:

- skip it if its `eventId` is already in `_sync_seen` (dedupe);
- `decryptEnvelope` it (which also verifies it belongs to this owner);
- apply **last-writer-wins** — only overwrite the local row if the incoming `hlc`
  is `>=` the existing row's `updatedAt`;
- record the `eventId` in `_sync_seen`.

Finally persist `nextCursor`. The cursor is keyset-based (`eventId`), so pulls are
bounded and resumable even across hundreds of thousands of events. The seen-set
is capped (50k) and pruned oldest-first — safe, because the cursor only advances
and applies are idempotent.

**Poll cadence & backoff.** The relay is plain HTTP with no server push, so the
engine polls (`syncIntervalMs`, default 5s) and also syncs on local writes and on
web focus/online. After a *terminal* failure (400/401/403/413) it backs the
poller off to 5 minutes so it doesn't hammer a relay that's rejecting the batch —
while still retrying immediately on focus/online/write. Network and 5xx/429
errors retry at the normal cadence.

## Restore on a new device

Restore is just "boot with the user's recovery phrase, then sync from an empty
cursor": derive the identity, pull everything, apply. Because events are
content-addressed by `(ownerId, eventId)` and applies are idempotent under LWW,
the device rebuilds identical state regardless of pull order.

## The encrypted envelope (crypto)

All crypto goes through WebCrypto (`crypto.subtle`). No native crypto lives in the
core; HMAC/AES/SHA are standard subtle primitives. `@scure/bip39` is used only for
mnemonic ↔ entropy conversion.

### Secret → identity

A "recovery secret" is **32 bytes of entropy** with two interchangeable encodings:

- **Native `sf1_` key:** `sf1_` + base64url(32 random bytes).
- **BIP39 mnemonic:** 24 words ⇄ the same 32 bytes via `@scure/bip39`. 12-word
  (16-byte) phrases are also accepted.

From the secret the core derives three values — and the two encodings use two
different derivation schemes:

**Native key → HKDF-SHA256** (RFC 5869):

```
PRK     = HMAC-SHA256(salt = protocol-v1 fixed bytes, IKM = secret)
ownerId   = base64url(HKDF-Expand(PRK, "owner-id",   16))
dataKey   =            HKDF-Expand(PRK, "data-key",   32)   → AES-GCM key
relayAuth = base64url(HKDF-Expand(PRK, "relay-auth",  32))
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
  "nonce": "base64url(12 bytes)",
  "ciphertext": "base64url(AES-256-GCM output)"
}
```

- Cipher: **AES-256-GCM**, fresh 12-byte random nonce per event.
- Plaintext: the `SyncPayload` serialized as **canonical JSON** (keys sorted
  recursively) so encryption is deterministic w.r.t. object shape.
- **AAD:** the canonical JSON of the envelope header `{version, ownerId, eventId,
  deviceId, createdAt}`. So a relay can't move a ciphertext to a different
  `eventId`/owner without GCM verification failing on decrypt.
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

The relay exposes a tiny HTTP API. All responses are JSON with permissive CORS.
Auth is a bearer token equal to `identity.relayAuth` (the owner's `writeKey`).

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
  `413`; exceeding `MAX_OWNER_BYTES` → `413`. The whole push is one SQLite
  transaction; any limit error rolls it back.

### `GET /v1/events` — pull

```
?ownerId=<id>&after=<cursor>&limit=<n>   (Bearer auth)
→ 200 { "events": SyncEnvelope[], "nextCursor": string }
```

- Keyset pagination: `WHERE owner_id = ? AND event_id > ? ORDER BY event_id ASC
  LIMIT ?`. `after=""` starts from the beginning. `nextCursor` is the last
  `eventId` returned — store it and pass it back next time.
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

### Ordering note

`eventId` is the pagination key and the engine sets `eventId = hlc`. HLCs are
monotonic per device, so the relay's `event_id` ordering approximates causal order
well enough — but the relay makes **no** global-ordering guarantee. Correctness
comes from clients applying `compareHlc` on the payload, not from pull order.

## Relay configuration

All limits are environment variables on the relay process. The defaults below are
the ones that define the **per-owner storage ceiling** and what gets rejected at
the edge:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4100` | Listen port. |
| `RELAY_DATA_DIR` | `data` | Where `relay.db` lives. Back this dir up to back up all owners. |
| `MAX_OWNER_BYTES` | `1073741824` (1 GiB) | **Per-owner storage quota**, shared across the event log *and* blob chunks. Exceeding it → `413`. |
| `MAX_EVENT_BYTES` | `262144` (256 KiB) | Max size of one envelope. Over → `413`. |
| `MAX_BLOB_BYTES` | `8388608` (8 MiB) | Max size of one uploaded blob chunk. Over → `413`. |
| `MAX_EVENTS_PER_PUSH` | `1000` | Max envelopes per push request. Over → `413`. |
| `MAX_EVENTS_PER_PULL` | `5000` | Hard cap on pull page size. |
| `DEFAULT_EVENTS_PER_PULL` | `1000` | Pull page size when the client omits `limit`. |
| `COMPACTION_INTERVAL_MS` | `21600000` (6h) | How often the Bun relay compacts the log (see below). |

**Reaching the quota.** When an owner crosses `MAX_OWNER_BYTES`, the relay returns
`413` on the next push or blob upload, and the engine surfaces a *terminal*
`SyncStateIsNotSynced` (status `413`) and backs the poller off. To recover, in
order of preference:

1. **Run compaction** — it reclaims the dominant growth (the append-only log) and
   decrements `stored_bytes`, so a stuck owner can drop back under the cap without
   losing any current data. See [log compaction](#log-compaction).
2. **Raise `MAX_OWNER_BYTES`** on your own relay — you self-host, so the only hard
   ceiling is disk.
3. **Watch usage before it's a problem** — `engine.getRelayStatuses()` (or a
   direct `GET /v1/status`) reports `usedBytes` vs `quotaBytes` per relay, so
   the app can warn the user or trigger compaction *before* writes start
   failing.

Because chunks are stored as raw binary (not base64), 1 GiB of quota holds ≈1 GiB
of real data. Blob-*chunk* GC is not automated, so heavy media use can leave
orphaned chunks — see the note under [log compaction](#log-compaction).

## Storage model

SQLite (`data/relay.db`, WAL mode):

```sql
owners(owner_id PK, relay_auth_hash, stored_bytes, created_at)
events(owner_id, event_id, device_id, envelope_json, stored_bytes, created_at,
       stream_id, PRIMARY KEY (owner_id, event_id))
blobs(owner_id, hash, bytes BLOB, size, created_at, PRIMARY KEY (owner_id, hash))
```

The relay stores `envelope_json` verbatim (ciphertext + header) and blob chunks
as raw encrypted `BLOB`s keyed by content hash. `stored_bytes` accumulates both
per owner for one shared quota. Nothing in the schema reveals application
semantics — table names, row values, mime types, and image contents are all
inside the ciphertext.

## Log compaction

The event log is append-only, so a row edited *N* times leaves *N* events though
only the last matters. Compaction reclaims that space, and it's only safe because
of one property: **`eventId === hlc`**, a fixed-width lexicographically-sortable
string, so the relay's `event_id` ordering is exactly the client's `compareHlc`
(LWW) ordering.

The rule: for each `(owner_id, stream_id)`, keep the row with the **maximum
`event_id`** and delete the rest. The survivor is precisely what a client's apply
loop would converge to, so a device pulling only survivors reconstructs identical
state regardless of where its cursor sits.

`stream_id` comes from the envelope header: `HMAC(streamKey, table‖rowId)`
truncated to 16 bytes, base64url. The relay groups by it but can't reverse it to a
table/row. The Bun relay runs compaction on a timer (`COMPACTION_INTERVAL_MS`,
default 6h) or on demand; the Cloudflare relay runs it from a Cron-triggered
Worker. After compaction, per-owner `stored_bytes` is decremented so the quota
reflects *current* footprint, not lifetime writes.

> Blob *chunk* GC is separate and not yet automated: a superseded manifest may
> leave orphaned chunks, since only the client knows which chunks a manifest
> references. Compaction reclaims event-log space, which is the dominant growth.

## Serverless deployment (Cloudflare)

`apps/relay-cloudflare` is a wire-compatible deployment that swaps the substrate
without touching the protocol: **events + owner metadata → D1**, **blob chunks →
R2** (cheap storage, free egress, safe to serve from cache because chunks are
encrypted and content-addressed). Because Workers/D1/R2 bill per use with no hard
spend cap, it's hardened against **wallet-DDoS** with a cheapest-first defense
stack: Cloudflare managed DDoS → zone WAF rate-limit → in-Worker rate-limit
bindings → cheap-path rejection → hard quotas (`MAX_OWNER_BYTES`, a global
`MAX_OWNERS` counter) and a `RELAY_DISABLED` kill switch. Full config is in
[`apps/relay-cloudflare/README.md`](../../apps/relay-cloudflare/README.md).

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

- **Versioning:** `SyncEnvelope.version` and `SyncPayload.schemaVersion` are both
  `1`. Bump and branch rather than mutating field meaning — old envelopes live
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

## Known limitations / roadmap hooks

- Row-level LWW only; no field-level merge or richer CRDTs.
- Single owner per client; no sharing/multi-owner yet.
- No transport compression or batching backpressure beyond the push/pull caps.
- Blob chunks are never auto-deleted: reclaiming bytes from a soft-deleted
  manifest needs an offline relay GC pass. Out of scope for v1.
- Relay auth is a bearer capability; rotating the write key is not implemented.
- Legacy import is row-level only — historical ciphertext from other systems
  isn't importable (different envelope format); rows are re-emitted as envelopes.
