# SimplySync — User Guide

A guide for building apps on SimplySync (the `@simplysync/protocol` package):
an app-owned, end-to-end-encrypted local-first stack. Users own their
data, the app works offline-first, and sync runs through a relay you can
self-host. For how the internals work and how to contribute, see
[`architecture.md`](./architecture.md).

## Mental model

```
   your app                              relay (dumb, opaque store)
┌────────────┐   encrypted envelopes    ┌──────────────────────────┐
│ local      │  ───── push ──────────▶  │ events keyed by           │
│ SQLite     │  ◀──── pull (cursor) ──   │ (ownerId, eventId)        │
│ (source of │                          │ stores ciphertext only    │
│  truth)    │                          └──────────────────────────┘
└────────────┘
```

- **The local database is the source of truth.** Every write lands in local
  SQLite first and the UI reads from it. The app is fully usable offline.
- **Every write also produces an encrypted sync event** ("envelope"). Envelopes
  are queued in a local outbox and pushed when a relay is reachable.
- **The relay never sees your data.** It stores opaque ciphertext plus an owner
  id and an auth hash. It cannot read table names, row values, notes, or
  amounts.
- **Conflicts resolve last-writer-wins** by a Hybrid Logical Clock (HLC), so two
  devices editing offline converge deterministically once they sync.

The core library gives you the cryptographic and protocol primitives. *You*
own the local schema, the outbox, and the apply loop — there's no hidden ORM.
`apps/simplysync-example` is a ~500-line reference client you can copy.

## Install

The core is a workspace package (`@simplysync/protocol`). In this monorepo,
depend on it with the workspace protocol:

```jsonc
// package.json
{
  "dependencies": {
    "@simplysync/protocol": "workspace:*"
  }
}
```

```sh
bun install
```

**Runtime requirements:** the core needs WebCrypto (`globalThis.crypto.subtle`)
and `btoa`/`atob`. These exist in modern browsers, Node 20+, and Bun. In React
Native they do not exist by default — install `react-native-quick-crypto` and a
base64 polyfill and load them before the library (see
`apps/simplysync-expo/crypto-setup.js` for a working setup).

## 1. Identity & recovery keys

A user's entire account is derived from a single secret. The library supports
two interchangeable credential formats and auto-detects which one it's given.

### Native recovery key (`sf1_…`)

```ts
import { createRecoveryKey, deriveIdentity } from "@simplysync/protocol";

const recoveryKey = await createRecoveryKey(); // "sf1_…" — 32 bytes of entropy
const identity = await deriveIdentity(recoveryKey);

identity.ownerId;   // public id used for routing on the relay
identity.relayAuth; // bearer token presented to the relay
identity.dataKey;   // AES-GCM CryptoKey (never leaves the device)
identity.source;    // "recoveryKey"
```

### BIP39 mnemonic

`createMnemonic()` mints a standard 24-word BIP39 phrase. A mnemonic
deterministically derives the same owner identity (owner id, encryption key, and
write key) every time, so a user who saved their recovery phrase can restore
their identity on any device with no re-onboarding.

```ts
import { createMnemonic, deriveIdentity, isRecoveryMnemonic } from "@simplysync/protocol";

const phrase = createMnemonic(); // "<generated 24-word recovery phrase>"

isRecoveryMnemonic(phrase);                 // true
const identity = await deriveIdentity(phrase);
identity.source;   // "mnemonic"
identity.mnemonic; // the normalized phrase (lowercased, single-spaced)
```

`deriveIdentity()` accepts either format, so a single "paste your recovery key
or phrase" input works for both. Mnemonic detection is whitespace- and
case-tolerant.

### Storing the secret

The recovery key/phrase is the only thing that can decrypt the user's data —
**store it in the platform secret store, never in app state or plain SQLite.**

- React Native: `expo-secure-store`
- Web: a password-derived key or platform credential store; never `localStorage`
- The CLI example stores it in SQLite only because it's a local demo

If the user loses it, their encrypted data is unrecoverable by design. Surface
it during onboarding and let them re-enter it to restore on a new device.

## 2. Devices & the Hybrid Logical Clock

Each install is a "device" with its own id. Writes are stamped with an HLC so
edits from different devices order deterministically.

```ts
import { createDeviceId, createHlc, compareHlc } from "@simplysync/protocol";

const deviceId = await createDeviceId(); // persist this per install

// Generate a monotonic HLC per write. Track the last (time, counter) yourself
// (see the reference client's nextHlc()) so repeated writes in the same ms
// still increase.
const hlc = createHlc(deviceId, Date.now(), counter);

compareHlc(a, b); // <0, 0, or >0 — use for last-writer-wins
```

## 3. Writing data (local-first + outbox)

A write does two things atomically-ish: update the local row, and enqueue an
encrypted envelope. `encryptPayload` turns a domain change into a `SyncEnvelope`.

```ts
import { encryptPayload, type SyncPayload } from "@simplysync/protocol";

const payload: SyncPayload = {
  schemaVersion: 1,
  table: "ledger",
  op: "upsert",          // or "delete"
  rowId: id,
  hlc,
  value: row,            // your row object; encrypted, relay never sees it
};

const envelope = await encryptPayload(
  identity,
  { eventId: hlc, deviceId },  // eventId is typically the HLC
  payload,
);

// 1) upsert the row in local SQLite
// 2) insert JSON.stringify(envelope) into your local `sync_outbox` table
```

**Deletes are soft.** In a distributed system you can't delete an individual
change — you mark the row deleted (e.g. set a `deletedAtHlc`) and emit a
`"delete"` envelope. Whole-owner deletion is a separate, real-delete concern
handled at the relay.

## 4. Syncing

Sync is two phases — push the outbox, then pull and apply — both safe to call
repeatedly (e.g. on app focus, on an interval, after each write when online).

**Push:** `POST {relayUrl}/v1/events` with the unpushed envelopes, then mark
them pushed locally.

```ts
await fetch(`${relayUrl}/v1/events`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${identity.relayAuth}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ ownerId: identity.ownerId, events: envelopes }),
});
// → { accepted, duplicate }
```

**Pull & apply:** `GET {relayUrl}/v1/events?ownerId=…&after=<cursor>`, decrypt
each envelope, apply with last-writer-wins, then persist `nextCursor`.

```ts
const url = new URL(`${relayUrl}/v1/events`);
url.searchParams.set("ownerId", identity.ownerId);
url.searchParams.set("after", cursor); // "" on first sync
const { events, nextCursor } = await (
  await fetch(url, { headers: { Authorization: `Bearer ${identity.relayAuth}` } })
).json();

for (const envelope of events) {
  if (seen(envelope.eventId)) continue;       // idempotent: dedupe by eventId
  const payload = await decryptEnvelope(identity, envelope);
  applyLastWriterWins(payload);               // compareHlc(existing, payload.hlc)
  markSeen(envelope.eventId);
}
persistCursor(nextCursor);
```

Applying with last-writer-wins:

```ts
const existing = getRow(payload.rowId);
if (existing && compareHlc(existing.updatedAtHlc, payload.hlc) >= 0) return; // ours is newer
upsertRow(payload.value);
```

The cursor is keyset-based (`eventId`), so pulls are bounded and resumable even
with hundreds of thousands of events. Keep a local `sync_seen` set so re-pulled
events are no-ops.

### Restore on a new device

Restore is just "boot with the user's recovery key/phrase, then sync from an
empty cursor": derive the identity, pull everything, apply. Because envelopes
are content-addressed by `(ownerId, eventId)` and applies are idempotent, the
device rebuilds the full state.

## 5. Images & binary blobs

Photos and other binaries don't belong inside JSON sync payloads (base64 inflates
them ~33% and bloats the log). Instead the library stores them as **encrypted,
content-addressed chunks** and syncs them lazily — the iCloud model:

1. **`encryptBlob`** splits the bytes into chunks, encrypts each with the data
   key, and returns a small **manifest** (id, mime, size, per-chunk hashes) plus
   the encrypted chunk bytes.
2. **Upload the chunk bytes** to the relay by hash (`PUT /v1/blobs/:hash`),
   skipping any it already has (`HEAD`).
3. **Sync the manifest as a normal event** (a `SyncPayload` with `table: "blob"`)
   so every device learns the image exists — without downloading a single pixel.
4. **On read, fetch chunks on demand** (`GET /v1/blobs/:hash`), verify each hash,
   decrypt, and cache locally.

```ts
import { encryptBlob, decryptBlob } from "@simplysync/protocol";

// Upload
const { manifest, chunks } = await encryptBlob(identity, bytes, {
  mimeType: "image/jpeg",
});
for (const chunk of chunks) {
  // PUT chunk.bytes to /v1/blobs/${chunk.hash} (skip if HEAD says it exists)
}
// then enqueue `manifest` as a normal SyncPayload (table: "blob")

// Read (on any device, after the manifest has synced)
const orderedChunkBytes = await Promise.all(
  manifest.chunks.map((c) => fetchChunkBytes(c.hash)), // from cache or relay
);
const data = await decryptBlob(identity, manifest, orderedChunkBytes);
```

The reference client wraps this as `putBlob(bytes, mimeType)` / `getBlob(blobId)`
(see `apps/simplysync-example/src/client.ts`), and
`bun run simplysync:blob-demo` shows a full cross-device round-trip.

**Why this scales to 1GB on a phone:** devices sync kilobytes of manifests, not
gigabytes of pixels. Image bytes are fetched only when actually viewed, stored as
binary BLOBs (no base64 overhead), content-addressed for dedup, and cached
locally. Use `decryptBlobChunk` for streaming if you don't want to hold a whole
blob in memory. Each chunk is bound by AEAD to its owner + blob + index, and its
hash is verified before decryption, so the relay cannot swap or forge bytes.

## 6. Running a relay

The relay (`@simplysync/relay`) is a single Bun + SQLite file. It's the
piece you self-host (or run in the cloud). It is deliberately dumb: opaque
storage, per-owner quotas, no plaintext.

```sh
bun run simplysync:relay            # http://localhost:4100
```

For Android emulators point the client at `http://10.0.2.2:4100`; iOS simulators
use `http://localhost:4100`.

**Configuration (env vars):**

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4100` | Listen port |
| `MAX_EVENT_BYTES` | `262144` (256 KiB) | Max size of one envelope |
| `MAX_OWNER_BYTES` | `1073741824` (1 GiB) | Per-owner storage quota |
| `MAX_EVENTS_PER_PUSH` | `1000` | Max envelopes per push request |
| `MAX_EVENTS_PER_PULL` | `5000` | Hard cap on pull page size |
| `DEFAULT_EVENTS_PER_PULL` | `1000` | Pull page size when client omits `limit` |
| `MAX_BLOB_BYTES` | `8388608` (8 MiB) | Max size of one uploaded blob chunk |

The per-owner quota (`MAX_OWNER_BYTES`) counts blob chunk bytes too, so 1 GiB is
shared across structured events and image chunks. Because chunks are stored as
binary BLOBs (not base64), 1 GiB of quota holds ≈1 GiB of real data.

Sizing for a large (≈500k-record) profile:

```sh
MAX_OWNER_BYTES=1073741824 \
MAX_EVENTS_PER_PUSH=1000 \
MAX_EVENTS_PER_PULL=5000 \
DEFAULT_EVENTS_PER_PULL=1000 \
bun run simplysync:relay
```

The relay stores data in `apps/simplysync-relay/data/relay.db`. Back that file
up to back up all owners. There's no vendor lock-in — any host that runs Bun (or
a port of the ~300-line server) works.

## 7. Try it end to end

```sh
# One-shot: starts a relay, runs two clients (Alice, Bob), syncs them, exits
bun run simplysync:demo

# Lazy encrypted image sync across two devices (upload, manifest-only sync, lazy read)
bun run simplysync:blob-demo

# Or run the pieces manually
bun run simplysync:relay         # terminal 1
bun run simplysync:client-demo   # terminal 2

# Native Expo demo (needs a relay running)
bun run simplysync:expo:ios
```

Restore a second client from a recovery phrase to watch sync rebuild state:

```sh
bun run --cwd apps/simplysync-example start init  --client bob --recovery-key "<sf1_… or 24-word phrase>"
bun run --cwd apps/simplysync-example start sync  --client bob
bun run --cwd apps/simplysync-example start list  --client bob
```

## API reference (core)

### Identity

| Export | Signature | Notes |
| --- | --- | --- |
| `createRecoveryKey` | `() => Promise<string>` | New native `sf1_` key (32 bytes). |
| `createMnemonic` | `() => string` | New 24-word BIP39 phrase. |
| `deriveIdentity` | `(recoveryKey: string) => Promise<LocalFirstIdentity>` | Accepts `sf1_` key **or** mnemonic (auto-detected). |
| `deriveIdentityFromMnemonic` | `(mnemonic: string) => Promise<LocalFirstIdentity>` | Forces SLIP-21 derivation from a BIP39 mnemonic. Throws on invalid phrase. |
| `isRecoveryMnemonic` | `(value: string) => boolean` | True for a valid BIP39 phrase. |
| `normalizeMnemonic` | `(mnemonic: string) => string` | Trim, lowercase, collapse whitespace. |
| `normalizeRecoveryKey` | `(recoveryKey: string) => string` | Trim an `sf1_` key. |

### Devices & clocks

| Export | Signature | Notes |
| --- | --- | --- |
| `createDeviceId` | `() => Promise<string>` | Random per-install id. Persist it. |
| `createHlc` | `(deviceId, now?, counter?) => string` | Build an HLC string. |
| `compareHlc` | `(left: string \| null, right: string) => number` | Order two HLCs. |

### Crypto envelope

| Export | Signature | Notes |
| --- | --- | --- |
| `encryptPayload` | `(identity, { eventId, deviceId, createdAt? }, payload) => Promise<SyncEnvelope>` | AES-GCM encrypt; envelope header is authenticated. |
| `decryptEnvelope` | `(identity, envelope) => Promise<SyncPayload<T>>` | Verifies the envelope belongs to this owner. |
| `sha256Base64Url` | `(value: string) => Promise<string>` | Used by the relay to hash the auth token. |
| `sha256Base64UrlBytes` | `(bytes: Uint8Array) => Promise<string>` | Content hash of raw bytes. |
| `base64UrlEncode` / `base64UrlDecode` | `(bytes) ↔ (string)` | URL-safe, unpadded. |

### Binary blobs

| Export | Signature | Notes |
| --- | --- | --- |
| `encryptBlob` | `(identity, data: Uint8Array, { mimeType, chunkSize?, blobId? }) => Promise<EncryptedBlob>` | Chunk + encrypt; returns manifest + uploadable chunks. |
| `decryptBlob` | `(identity, manifest, storedChunks: Uint8Array[]) => Promise<Uint8Array>` | Reassemble; verifies every chunk hash and the whole-blob hash. |
| `decryptBlobChunk` | `(identity, manifest, index, storedBytes) => Promise<Uint8Array>` | Single chunk (streaming/lazy); verifies hash first. |
| `createBlobId` | `() => Promise<string>` | Random blob id. |
| `DEFAULT_BLOB_CHUNK_BYTES` | `number` | 256 KiB plaintext per chunk. |

### Types

| Type | Shape |
| --- | --- |
| `LocalFirstIdentity` | `{ recoveryKey, ownerId, relayAuth, dataKey, source, mnemonic? }` |
| `IdentitySource` | `"recoveryKey" \| "mnemonic"` |
| `SyncEnvelope` | `{ version, ownerId, eventId, deviceId, nonce, ciphertext, createdAt }` |
| `SyncPayload<T>` | `{ schemaVersion, table, op: "upsert" \| "delete", rowId, hlc, value: T }` |
| `BlobManifest` | `{ version, ownerId, blobId, mimeType, byteSize, chunkSize, chunks, sha256, createdAt }` |
| `BlobChunkRef` | `{ hash, size, plaintextSize }` |
| `EncryptedBlob` | `{ manifest, chunks: EncryptedBlobChunk[] }` |
| `EncryptedBlobChunk` | `{ hash, bytes: Uint8Array }` |

## Common pitfalls

- **Calling crypto before polyfills load (RN).** Import your crypto setup first
  (`index.js` → `crypto-setup.js`) or `deriveIdentity` throws "WebCrypto is
  required".
- **Not deduping on pull.** Without a `sync_seen` set you'll re-apply events;
  applies are idempotent under LWW but you waste work. Always dedupe by
  `eventId`.
- **Non-monotonic HLCs.** Persist the last `(time, counter)` and bump the
  counter within the same millisecond, or concurrent writes can tie.
- **Hard-deleting rows.** Use soft deletes (a `deletedAtHlc`) so a delete can
  lose to a later edit and so other devices learn about the deletion.
- **Trusting the relay.** It can withhold or reorder events (availability), but
  cannot read or forge payloads. Design for "eventually consistent", not
  "transactional".
