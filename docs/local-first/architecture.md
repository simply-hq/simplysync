# SimplySync — Architecture & Contributor Guide

Technical reference for people working *on* SimplySync (not just with it). It
documents the crypto, the wire format, the sync protocol, the relay's storage
and threat model, and how to build/test/extend the codebase. For app-developer
usage see [`guide.md`](./guide.md).

## Design goals & non-goals

**Goals**

- **App-owned, no lock-in.** A few hundred lines of readable TypeScript. No SaaS
  dependency; the relay runs anywhere Bun runs and stores a plain SQLite file.
- **E2E encrypted by default.** The relay only ever holds ciphertext + an owner
  id + an auth hash.
- **Offline-first.** Local SQLite is the source of truth; sync is opportunistic.
- **Scales to large datasets.** Bounded, keyset-paginated, resumable sync — no
  loading whole histories into memory.
- **First-class binary media.** Images/blobs sync as small manifests with lazily
  fetched, encrypted, content-addressed chunks — so ≥1 GB of media stays
  workable on a phone.
- **Portable recovery phrases.** Standard BIP39 mnemonics are accepted as
  recovery phrases, with no proprietary credential format.

**Non-goals (today)**

- Not a CRDT for arbitrary nested structures — conflict resolution is
  row-level last-writer-wins via HLC.
- No partial/selective sync, no multi-owner sharing, no server-side queries.
- The relay does not authenticate *who* you are beyond holding the owner's
  relay-auth token (a capability, see threat model).

## Repository layout

| Path | Role | Depends on |
| --- | --- | --- |
| `packages/simplysync-protocol` | Framework-agnostic primitives: identity, key derivation, AES-GCM envelopes, HLC, encoding. | WebCrypto, `@scure/bip39` |
| `apps/simplysync-relay` | Self-hostable Bun + SQLite relay (opaque event store). | core |
| `apps/simplysync-example` | Node/Bun CLI reference client + one-shot two-client demo. | core |
| `apps/simplysync-expo` | Native Expo demo (`expo-sqlite`, `expo-secure-store`). | core |

The core is the only published surface. The relay and clients are reference
implementations of the protocol; an app embeds its *own* client (the example is
meant to be read and copied, not imported).

## Cryptographic design

All crypto goes through WebCrypto (`crypto.subtle`). No native crypto code lives
in the core; HMAC/AES/SHA are all standard subtle primitives. `@scure/bip39` is
used only for mnemonic ↔ entropy conversion.

### Secret → identity

A "recovery secret" is **32 bytes of entropy**. It has two encodings:

- **Native `sf1_` key:** `sf1_` + base64url(32 random bytes).
- **BIP39 mnemonic:** 24 words ⇄ the same 32 bytes via `@scure/bip39`
  (`mnemonicToEntropy` / `entropyToMnemonic`). 12-word (16-byte) phrases are
  also accepted.

From the secret the core derives three values. **Crucially, the two encodings
use two different derivation schemes** — a native `sf1_` key uses HKDF, while a
BIP39 mnemonic uses SLIP-21:

#### Native key → HKDF-SHA256

`deriveBytes(secret, label, len)` is HKDF (RFC 5869) over SHA-256:

```
PRK     = HMAC-SHA256(salt = protocol-v1 fixed bytes, IKM = secret)
OKM     = HKDF-Expand(PRK, info = label, len)
ownerId   = base64url(deriveBytes(secret, "owner-id",   16))
dataKey   =            deriveBytes(secret, "data-key",   32)  → AES-GCM key
relayAuth = base64url(deriveBytes(secret, "relay-auth",  32))
```

#### Mnemonic → SLIP-21

`deriveIdentityFromMnemonic` derives the owner from the mnemonic's BIP39
entropy via SLIP-21 with SimplySync's own fixed labels:

```
entropy = mnemonicToEntropy(mnemonic)                       // 32 bytes
node0   = HMAC-SHA512("Symmetric key seed", entropy)        // SLIP-21 master
node(label) = HMAC-SHA512(parent[0:32], 0x00 || label)      // per path element
slip21(path) = node(...path)[32:64]                         // lower 32 bytes

ownerId   = base64url( slip21(["SimplySync","OwnerIdBytes"])[0:16] )
dataKey   =            slip21(["SimplySync","OwnerEncryptionKey"])     → AES-GCM key
relayAuth = base64url( slip21(["SimplySync","OwnerWriteKey"])[0:16] )
```

`createSlip21` is implemented in the core over WebCrypto `HMAC-SHA512` — no
extra crypto dependency. The owner-id byte→string step is plain base64url of
16 bytes.

> **Stability invariant.** The SLIP-21 labels are part of the derivation, so a
> given recovery phrase must always derive the same owner id and relay auth. A
> locked vector in `packages/simplysync-protocol/test/identity.test.ts` pins this:
> if you change mnemonic derivation and that test fails, you've broken every
> existing user's identity — don't. Add a new vector rather than editing the
> existing one.

### Payload encryption (the envelope)

`encryptPayload` produces a `SyncEnvelope`:

```jsonc
{
  "version": 1,
  "ownerId": "…",      // public; used for routing + AEAD additional data
  "eventId": "…",      // unique per owner (the client uses the HLC)
  "deviceId": "…",     // which device produced it
  "createdAt": "ISO",  // wall clock, advisory only
  "nonce": "base64url(12 bytes)",
  "ciphertext": "base64url(AES-GCM output)"
}
```

- Cipher: **AES-256-GCM**, 12-byte random nonce per event.
- Plaintext: the `SyncPayload` serialized with **canonical JSON** (keys sorted
  recursively) so encryption is deterministic w.r.t. object shape.
- **Additional authenticated data (AAD):** the canonical JSON of the envelope
  header `{version, ownerId, eventId, deviceId, createdAt}`. So the header is
  tamper-evident: a relay can't move a ciphertext to a different `eventId`/owner
  without GCM verification failing on decrypt.
- `decryptEnvelope` rejects envelopes whose `ownerId` ≠ the identity's owner id
  before attempting decryption.

### Binary blobs (images)

Large binaries are kept out of the JSON log and synced lazily, the iCloud way:
small **manifests** travel through the normal event log; the chunk **bytes** are
stored as binary BLOBs and fetched on demand.

`encryptBlob(identity, data, { mimeType, chunkSize? })`:

- Splits `data` into `chunkSize` plaintext chunks (default 256 KiB).
- Encrypts each chunk with the data key (AES-256-GCM, fresh 12-byte nonce). The
  AAD is `canonicalJson({ v: 1, ownerId, blobId, index })`, binding every chunk
  to its owner, blob, and position — a relay can't swap chunks between blobs or
  reorder them without GCM failing.
- The stored object is `nonce ‖ ciphertext`, **content-addressed** by its
  SHA-256 (base64url). That hash is the relay key and the integrity check, and
  gives free dedup of identical encrypted bytes.
- Returns a `BlobManifest` `{ version, ownerId, blobId, mimeType, byteSize,
  chunkSize, chunks: [{ hash, size, plaintextSize }], sha256, createdAt }` plus
  the encrypted chunks to upload. The manifest is tiny (a few hundred bytes) and
  is emitted as an ordinary `SyncPayload` with `table: "blob"`.

Reads use `decryptBlobChunk` (one chunk, hash-verified before decrypt — good for
streaming) or `decryptBlob` (reassembles all chunks and verifies the whole-blob
`sha256`). Neither base64 nor whole-file buffering is required on the relay, and
devices only download chunks they actually open.

### Hybrid Logical Clock

`createHlc(deviceId, now, counter)` →
`base36(now,10) - base36(counter,4) - deviceId`. Lexicographic string compare
orders events by physical time, then counter, then device id (a stable
tiebreaker). `compareHlc(null, x)` returns `-1` so "no value" always loses.

The clock's monotonicity is the *client's* responsibility: persist the last
`(time, counter)` and, within the same millisecond, increment the counter (see
the reference client's `nextHlc()`).

## Sync protocol (wire spec)

The relay exposes a tiny HTTP API. All responses are JSON with permissive CORS.
Auth is a bearer token equal to `identity.relayAuth`.

### `POST /v1/events` — push

```
Authorization: Bearer <relayAuth>
Body: { "ownerId": string, "events": SyncEnvelope[] }
→ 200 { "accepted": number, "duplicate": number }
```

- First push for an unknown `ownerId` **registers** the owner, storing
  `sha256Base64Url(relayAuth)` (trust-on-first-use). Later requests must present
  a token whose hash matches, else `401`.
- Each envelope is validated (`version === 1`, owner match, required string
  fields). Insert is `INSERT OR IGNORE` on `(owner_id, event_id)` → re-pushing
  is idempotent and counts as `duplicate`.
- Limits: `> MAX_EVENTS_PER_PUSH` → `413`; an envelope over `MAX_EVENT_BYTES` →
  `413`; exceeding `MAX_OWNER_BYTES` → `413`. The whole push is one SQLite
  transaction; any limit error rolls it back.

### `GET /v1/events` — pull

```
?ownerId=<id>&after=<cursor>&limit=<n>
Authorization: Bearer <relayAuth>
→ 200 { "events": SyncEnvelope[], "nextCursor": string }
```

- Keyset pagination: `WHERE owner_id = ? AND event_id > ? ORDER BY event_id ASC
  LIMIT ?`. `after=""` starts from the beginning. `nextCursor` is the last
  `eventId` returned (or `after` if empty) — store it and pass it back next time.
- `limit` is clamped to `[1, MAX_EVENTS_PER_PULL]`, defaulting to
  `DEFAULT_EVENTS_PER_PULL`.
- Pull requires an *existing* owner (`404` if unknown) and a matching auth hash.

### `GET /v1/usage` — quota check

```
?ownerId=<id>  (Bearer auth)
→ 200 { "ownerId": string, "storedBytes": number }
```

### `PUT /v1/blobs/:hash` — upload a blob chunk

```
?ownerId=<id>   (Bearer auth)
Body: raw encrypted chunk bytes (application/octet-stream)
→ 200 { "stored": boolean, "duplicate": boolean }
```

- `:hash` must equal `sha256Base64Url(body)` — the server recomputes it and
  rejects a mismatch (`400`), so clients can't choose arbitrary keys.
- Existing hashes short-circuit *before* the body is read (dedupe). Insert is
  `INSERT OR IGNORE`. A chunk over `MAX_BLOB_BYTES` → `413`; exceeding
  `MAX_OWNER_BYTES` → `413`. First upload registers the owner (TOFU), like push.
- Stored bytes count toward the same per-owner quota as events.

### `GET /v1/blobs/:hash` — download a blob chunk

```
?ownerId=<id>   (Bearer auth)
→ 200 application/octet-stream (raw encrypted bytes), 404 if unknown
```

Served with `Cache-Control: immutable` — safe because the body is encrypted and
content-addressed. `HEAD /v1/blobs/:hash` returns `200`/`404` so a client can
skip re-uploading a chunk the relay already has.

### `GET /health`

```
→ 200 { "ok": true, "service": "simplysync-relay" }
```

### Ordering note

`eventId` is the pagination key, and clients set `eventId = hlc`. Because HLCs
are monotonic *per device*, the relay's `event_id` ordering approximates global
causal order well enough for LWW, but the relay makes **no** global-ordering
guarantee — correctness comes from clients applying `compareHlc` on the payload,
not from pull order.

## Relay storage model

SQLite (`data/relay.db`, WAL mode):

```sql
owners(owner_id PK, relay_auth_hash, stored_bytes, created_at)
events(owner_id, event_id, device_id, envelope_json, stored_bytes, created_at,
       stream_id, PRIMARY KEY (owner_id, event_id))
index events_owner_event_id ON events(owner_id, event_id)
index events_owner_stream   ON events(owner_id, stream_id, event_id)  -- compaction
blobs(owner_id, hash, bytes BLOB, size, created_at,
      PRIMARY KEY (owner_id, hash))
```

The relay stores `envelope_json` verbatim (ciphertext + header) and blob chunks
as raw encrypted `BLOB`s keyed by content hash. `stored_bytes` accumulates both
event and blob bytes per owner for one shared quota. Nothing in the schema
reveals application semantics — table names, row values, mime types, and image
contents are all inside the ciphertext.

### Log compaction

The event log is append-only, so a row edited *N* times leaves *N* events even
though only the last matters. Compaction reclaims that space — and it's only
safe because of one property: **`eventId === hlc`**, and an HLC is a fixed-width
lexicographically-sortable string, so the relay's `event_id` ordering is exactly
the client's `compareHlc` (last-writer-wins) ordering.

So the rule is: for each `(owner_id, stream_id)`, keep the row with the **maximum
`event_id`** and delete the rest. The survivor is precisely the value a client's
apply loop would converge to, so a device pulling only survivors reconstructs
identical state — regardless of where its pull cursor sits (it either already
passed the deleted losers, or skips straight to the winner). Events with a NULL
`stream_id` (legacy/untagged writers) are never touched.

`stream_id` comes from the envelope header: `HMAC(streamKey, table‖rowId)`
truncated to 16 bytes, base64url. The relay groups by it but can't reverse it to
a table/row. The Bun relay runs compaction on a timer (`COMPACTION_INTERVAL_MS`,
default 6h) or on demand via the admin `POST <path>/compact`; the Cloudflare
relay runs it from a Cron-triggered Worker. After compaction the per-owner
`stored_bytes` is decremented by the reclaimed bytes, so the quota reflects
*current* footprint rather than lifetime writes.

> Blob *chunk* GC is separate and not yet automated: a superseded manifest may
> leave orphaned chunks, since only the client knows which chunks a manifest
> references. Compaction reclaims event-log space, which is the dominant growth.

### Serverless deployment (Cloudflare)

`apps/relay-cloudflare` is a wire-compatible deployment on Cloudflare Workers
that swaps the substrate without touching the protocol:

- **Events + owner metadata → D1.** Same small, keyset-paginated rows; D1 stays
  tiny because the bulk media never lands here.
- **Blob chunks → R2** (keyed `<ownerId>/<hash>`). R2 has cheap storage and
  **free egress**, and content-addressed + encrypted chunks are safe to serve
  from cache, so repeat reads cost neither an R2 op nor Worker compute.

Because Workers/D1/R2 are billed per use and Cloudflare has no hard spend cap,
the deployment is hardened against **wallet-DDoS** with a cheapest-first defense
stack: Cloudflare managed DDoS (free) → zone WAF rate-limit rule (sheds load
*before* the Worker is billed) → in-Worker rate-limit bindings (per-IP, per-
owner, per-IP owner-creation) → cheap-path rejection (`/health`, bad method,
missing token, oversized `Content-Length` cost zero D1/R2) → hard quotas
(`MAX_OWNER_BYTES`, global `MAX_OWNERS` counter, per-request bounds) and a
`RELAY_DISABLED` kill switch. The anti-row-spam gate (per-IP creation limit +
global owner cap) bounds the one thing TOFU leaves open — minting new owners —
without adding any account-registration step. Full deploy + dashboard config is
in [`apps/relay-cloudflare/README.md`](../../apps/relay-cloudflare/README.md).

## Threat model

What an honest-but-curious or actively malicious relay **cannot** do:

- Read payloads — they're AES-256-GCM encrypted with a key derived from the
  user's secret, which never leaves the device.
- Forge or alter accepted payloads — GCM tags fail and clients reject them. The
  envelope header is AAD, so it can't be rebound either.
- Tamper with, swap, or reorder blob chunks — each is content-hash-verified
  before decryption and AEAD-bound to its owner/blob/index.
- Learn the data key or recovery secret from `relayAuth` — they're independent
  HKDF/SLIP-21 outputs.

What it **can** do (accepted limitations):

- **Availability/integrity of the log:** withhold, delay, reorder, or delete
  events (deny service, serve stale state). It can also drop a push.
- **Metadata:** observe owner ids, device ids, event counts, sizes, and
  timestamps (`createdAt`). Owner ids are pseudonymous but stable. With
  compaction enabled it also sees `stream_id` — a stable pseudonymous key per
  logical row — so it can count an owner's distinct rows and how often each
  changes. It cannot reverse a `stream_id` to its table/row (it's an HMAC under
  a key the relay never holds), and the id is AAD-bound so it can't be forged.
- **Capability model, not identity:** anyone holding an owner's `relayAuth` can
  push/pull for that owner. `relayAuth` is a bearer capability derived from the
  secret; treat it as sensitive. There is no account/login layer.

Mitigations live at the edges: clients dedupe and apply idempotently (so replays
are harmless), use soft deletes (so withheld deletes self-heal on next sync),
and the relay enforces per-owner quotas (so one owner can't exhaust storage).

## Client responsibilities (what the core does *not* do)

The core is intentionally unopinionated about persistence. A conforming client
must provide:

1. **Local schema** — domain tables in SQLite (source of truth).
2. **Outbox** — durable queue of unpushed envelopes; mark pushed after a `200`.
3. **Seen set** — dedupe pulled events by `eventId`.
4. **Cursor** — persisted per relay URL for resumable pulls.
5. **HLC state** — persisted `(time, counter)` for monotonic clocks.
6. **Apply loop** — decrypt, then `compareHlc`-gated upsert/soft-delete.

`apps/simplysync-example/src/client.ts` is the canonical reference — including
`putBlob`/`getBlob`, which upload chunk bytes, sync the manifest as a `"blob"`
event, and lazily fetch + cache chunks on read. `apps/simplysync-expo` shows the
same contract with keyset-paginated reads and `FlatList` for large ledgers.

## Building, testing, running

```sh
bun install

# Core
bun --cwd packages/simplysync-protocol run typecheck   # tsc --noEmit
bun --cwd packages/simplysync-protocol test            # bun test (identity vectors)

# End-to-end
bun run simplysync:demo            # relay + two clients + sync, one shot
bun run simplysync:relay           # standalone relay on :4100
bun run simplysync:clean           # wipe demo + relay SQLite files
```

The core's tests run under Bun's native test runner (`bun test`) because the
package is pure TS with no React Native flow files — the repo-wide jest/RN
caveats (see project memory) don't apply here. `bun run simplysync:blob-demo`
exercises the full encrypted-image path across two devices.

## Extending the protocol — guidelines

- **Versioning:** `SyncEnvelope.version` and `SyncPayload.schemaVersion` are
  both `1`. Bump and branch on them rather than mutating field meaning;
  old envelopes live forever in the log.
- **Backwards-compat tests are load-bearing.** Any change near key derivation
  must keep `identity.test.ts` green (the locked identity vector). Add a new
  vector rather than editing the existing one.
- **Keep the relay dumb.** Resist adding server-side filtering/queries that
  would require it to understand payloads — that breaks the privacy model.
- **Canonical JSON is part of the contract.** `encryptPayload` sorts keys before
  encrypting and authenticates the header as AAD; changing serialization changes
  ciphertext/AAD and breaks decryption of existing data.
- **New crypto stays in the core, on WebCrypto.** Don't pull native crypto into
  the core; that's what keeps it portable across Node/Bun/web/RN.

## Known limitations / roadmap hooks

- Row-level LWW only; no field-level merge or richer CRDTs.
- Single `AppOwner`-style owner per client; no `ShardOwner`/sharing yet.
- No transport compression or batching backpressure beyond the push/pull caps.
- Blob chunks are never auto-deleted: a soft-deleted manifest stops referencing
  its chunks, but reclaiming the bytes needs an offline relay GC pass
  (mark-and-sweep over manifest references). Out of scope for v1.
- Importing data from a legacy SQLite database is row-level only — historical
  ciphertext from other systems is not importable (different envelope format).
  Importing existing rows means reading them locally and re-emitting them as
  envelopes.
- Relay auth is a bearer capability; rotating the write key is not implemented.
