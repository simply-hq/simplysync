# @simplysync/protocol

A small, app-owned local-first platform for building apps where users own their
data, with no vendor lock-in and no data hostage situations.

> 📚 Full docs: **[User Guide](../../docs/local-first/guide.md)** ·
> **[Architecture & Contributor Guide](../../docs/local-first/architecture.md)**

- **Offline-first.** Apps write to a local SQLite database first; sync happens
  opportunistically whenever a relay is reachable.
- **End-to-end encrypted by default.** A single recovery key derives the owner
  id, data-encryption key, and relay auth key. Payloads are encrypted with
  AES-GCM locally before they ever leave the device.
- **Portable BIP39 recovery phrases.** A standard BIP39 mnemonic
  deterministically derives the same owner identity (owner id, encryption key,
  and write key, via SLIP-21) on any device, so users keep their phrase with no
  re-onboarding.
- **Sync via self-hostable or cloud relays.** The relay is a dumb, opaque event
  store. It sees owner ids, auth hashes, and ciphertext — never table names, row
  values, or amounts.
- **Built on SQLite with a scalable sync protocol.** Reads use keyset
  pagination and sync pushes/pulls bounded batches, so it holds up on large
  datasets instead of loading whole histories into memory.
- **First-class images & binary blobs.** Binaries are encrypted, chunked, and
  content-addressed; a tiny manifest syncs through the log while the chunk bytes
  are stored as binary BLOBs and fetched lazily on view — so ≥1 GB of media
  stays workable on a phone (the iCloud model).

## What's in this repo

| Path | What it is |
| --- | --- |
| `packages/simplysync-protocol` | The framework-agnostic core: recovery keys, key derivation (HKDF + SLIP-21), AES-GCM encrypt/decrypt, HLC ordering, sync envelopes. Depends only on WebCrypto and `@scure/bip39` (for BIP39 mnemonics). |
| `relays/go` | The canonical self-hostable relay that stores opaque encrypted envelopes. |
| `examples/cli` | A Node/Bun CLI proof-of-concept that runs two local clients and syncs them through the relay. |
| `examples/expo` | A native Expo demo using `expo-sqlite` for local data and `expo-secure-store` for the recovery key. |

## Recovery credentials

`deriveIdentity()` accepts either credential and auto-detects which one it got:

- A native recovery key (`sf1_...`, 32 bytes) → owner id / data key / relay auth
  via HKDF-SHA256.
- A BIP39 mnemonic (12 or 24 words) → owner id, encryption key, and write key
  via SLIP-21, deterministically the same on every device. `createMnemonic()`
  mints a fresh 24-word phrase if you want users on portable BIP39 phrases from
  day one.

## Security shape

- The recovery key (`sf1_...`) derives an owner id, a data-encryption key, and a
  relay auth key via HKDF.
- Payloads are encrypted locally with AES-GCM before sync. Envelope metadata is
  authenticated as AES-GCM additional data.
- The relay stores a hash of the relay auth key and opaque ciphertext.
- A malicious relay can deny service, delete events, or serve stale events. It
  cannot read or alter accepted payloads without clients rejecting them.

## Quick start

```sh
# Run the one-shot CLI demo (starts a relay, syncs two clients, shuts down)
bun run simplysync:demo

# Or run the pieces manually
bun run relay:go                # terminal 1
bun run simplysync:client-demo  # terminal 2

# Native Expo demo (needs a relay running)
bun run simplysync:expo:ios
```

See the per-app READMEs in `examples/cli` and `examples/expo`
for the full command surface.
