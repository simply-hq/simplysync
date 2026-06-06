# Security & Threat Model

> **The short version:** the relay is a dumb, opaque event store. It holds
> nonce-and-ciphertext and a little routing metadata. It never sees your data,
> your encryption key, or your recovery phrase — and you can verify every claim
> on this page by reading the source files it links to.

This document exists so you don't have to *take our word* for "local-first" and
"end-to-end encrypted." Every claim below points at the exact code that enforces
it. If a claim and the code ever disagree, the code wins — please open an issue.

The strongest guarantee of all isn't on this page: **you can run your own
relay** (see [`docs/local-first/self-hosting.md`](docs/local-first/self-hosting.md)).
If you don't trust ours, don't use ours. The protocol is identical either way.

---

## Where the secrets live

Everything derives from a single secret the user holds — a recovery key
(`sf1_…`) or a BIP39 mnemonic. From it the client derives, **on the device**:

| Derived value | What it's for | Ever sent to a relay? |
| --- | --- | --- |
| `ownerId` | Pseudonymous account id (routing) | Yes — pseudonymous, stable |
| `dataKey` (AES-GCM `CryptoKey`) | Encrypts/decrypts payloads | **Never** |
| `relayAuth` | Bearer capability to push/pull | Only its SHA-256 **hash** is stored |
| `streamKey` (HMAC key) | Derives per-row `streamId` for compaction | **Never** |

Derivation is SLIP-21 over the mnemonic's BIP39 entropy, using SimplySync's own
fixed labels so a given recovery phrase always resolves to the same identity.

**Verify:** [`packages/simplysync-protocol/src/index.ts`](packages/simplysync-protocol/src/index.ts)
— `deriveIdentity`, `deriveIdentityFromMnemonic`. The `dataKey` is imported as an
`AES-GCM` key with `["encrypt","decrypt"]` usages and is **never serialized or
transmitted** — grep the package for the symbol and confirm it never reaches the
network layer.

---

## What a relay stores (and that's all it stores)

Every event the relay persists is a `SyncEnvelope`:

```
version, ownerId, eventId, deviceId, nonce, ciphertext, createdAt, streamId?
```

The payload — table name, column values, amounts, notes, everything that is
*your data* — lives **only** inside `ciphertext`, AES-256-GCM sealed under
`dataKey`. The relay receives it as opaque bytes and writes it to a `text`
column without ever parsing it.

**Verify (storage):**
[`apps/relay-go/store.go`](apps/relay-go/store.go) — the `events` table
stores `envelope_json` as opaque text; the relay only ever reads the routing
columns (`owner_id`, `event_id`, `device_id`, `stream_id`, `seq`). There is no
code path that decrypts, inspects, or transforms `ciphertext`.

**Verify (envelope shape & encryption):**
[`apps/relay-go/handlers.go`](apps/relay-go/handlers.go) — `SyncEnvelope`
is documented as *"the opaque, end-to-end-encrypted event the relay stores"*;
the encrypt/decrypt happens client-side in
[`packages/simplysync-engine/src/engine.ts`](packages/simplysync-engine/src/engine.ts)
(`encryptPayload` / `decryptEnvelope`, imported from `@simplysync/protocol`). The
exact call binds the envelope header as AES-GCM **additional authenticated
data** — see `encryptPayload` in
[`packages/simplysync-protocol/src/index.ts`](packages/simplysync-protocol/src/index.ts).

---

## What a malicious or compromised relay **cannot** do

- **Read your data.** Payloads are AES-256-GCM encrypted with `dataKey`, which
  never leaves the device. No key on the server → no plaintext on the server.
- **Forge or tamper with accepted data.** The GCM authentication tag fails on
  any modification and the client rejects it. The envelope header is bound as
  AAD, so the ciphertext can't be re-bound to a different owner/event either.
- **Tamper with, swap, or reorder blob chunks.** Each chunk is
  content-hash-verified before decryption and AEAD-bound to its owner/blob/index.
- **Recover your key or phrase from `relayAuth`.** `relayAuth` and `dataKey` are
  independent derivation outputs; one does not reveal the other. The relay only
  ever stores the **SHA-256 hash** of `relayAuth`, never the value itself.

**Verify (auth):** [`apps/relay-go/store.go`](apps/relay-go/store.go) —
`ensureOwnerAuth` hashes the presented token with SHA-256 (`sha256B64`, defined
in [`apps/relay-go/main.go`](apps/relay-go/main.go)) and compares against the
stored hash (trust-on-first-use). The raw bearer token is never persisted.

---

## What a relay **can** do (honest limitations)

We'd rather you trust us *less* and understand the system *more*. A relay is not
omniscient, but it is not blind either:

- **Availability & ordering.** It can withhold, delay, reorder, or delete events
  — i.e. deny service or serve stale state. It cannot make you accept forged
  data, only fail to give you real data.
- **Metadata.** It observes `ownerId`, `deviceId`, event counts, **sizes**, and
  **timestamps** (`createdAt`/HLC). Owner ids are pseudonymous but stable. With
  compaction enabled it also sees `streamId` — a stable pseudonymous key per
  logical row — so it can count an owner's distinct rows and how often each
  changes. It **cannot** reverse a `streamId` to a table/row: it's
  `HMAC(streamKey, table‖rowId)` under a key the relay never holds.
- **Network-level.** Like any server, it sees connecting IP addresses and timing
  unless you front it with Tor/VPN. This is outside the protocol's scope.
- **Capability, not identity.** Anyone holding an owner's `relayAuth` can
  push/pull for that owner — it's a bearer capability, not a login. Treat it as
  sensitive. There is no account/password layer to phish, by design.

**Mitigations live at the client edges:** clients dedupe and apply idempotently
(replays are harmless), use soft deletes (a withheld delete self-heals on the
next sync), and the relay enforces per-owner quotas (one owner can't exhaust
another's storage). See
[`apps/relay-go/store.go`](apps/relay-go/store.go) `pushEvents` for quota
enforcement.

---

## Audit this in ten minutes

1. **Confirm the key never leaves the device.** Open
   `packages/simplysync-protocol/src/index.ts`, find `dataKey`, and trace it — it's
   only ever used in local `crypto.subtle.encrypt/decrypt`. It is never put on
   the wire.
2. **Confirm the relay can't read payloads.** Open `apps/relay-go/store.go` and
   search for `ciphertext` — it never appears, because the relay only handles
   `envelope_json` as an opaque string.
3. **Confirm what the relay *does* see.** Read the `events`/`owners` table DDL in
   `store.go` `migrate()`. Those columns are the *entire* footprint.
4. **Run your own.** Follow
   [`docs/local-first/self-hosting.md`](docs/local-first/self-hosting.md), point a
   client at `http://localhost:…`, and watch two devices converge through a
   relay you control and can `sqlite3`-inspect yourself. You'll see ciphertext.

---

## Reporting a vulnerability

Found something? Please open a private security advisory (or email the
maintainers) rather than a public issue, and give us a reasonable window to
ship a fix before disclosure. Specific, reproducible reports against the files
above are the most useful.

---

## Cross-references

- Full cryptographic design & wire spec:
  [`docs/local-first/architecture.md`](docs/local-first/architecture.md)
- Running your own relay:
  [`docs/local-first/self-hosting.md`](docs/local-first/self-hosting.md)
- User-facing guide: [`docs/local-first/guide.md`](docs/local-first/guide.md)
