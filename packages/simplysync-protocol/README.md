# @simplysync/protocol

Framework-neutral identity, encryption, ordering, blob, and wire-format
primitives for SimplySync. Most applications use `@simplysync/engine`; use this
package directly when implementing another client or relay-compatible port.

## Use from source

Run `bun run clone core ../my-sync-core` from a full checkout, or use any client
preset; each includes this protocol source automatically. In the selected clone,
run `bun install --no-save && bun run build`.

The runtime needs Web Crypto. It is available in modern browsers, Node 20+, and
Bun; React Native must install its crypto and base64 polyfills before importing
the package.

## Identity

```ts
import {
  createMnemonic,
  createRecoveryKey,
  deriveIdentity,
} from "@simplysync/protocol";

const phrase = createMnemonic(); // portable 24-word BIP39 phrase
const identity = await deriveIdentity(phrase);

// Native SimplySync recovery keys are supported too.
const recoveryKey = await createRecoveryKey(); // sf1_...
const sameShape = await deriveIdentity(recoveryKey);
```

Never upload or log the recovery credential. It deterministically derives the
owner ID, data-encryption key, relay-auth capability, and stream key.

## Wire primitives

The public API includes:

- AES-256-GCM envelope sealing/decryption with authenticated metadata;
- hybrid logical clock creation and comparison;
- stable pseudonymous stream IDs;
- encrypted, chunked binary-blob manifests;
- encrypted database-snapshot helpers; and
- canonical shared TypeScript types and `SYNC_SCHEMA_VERSION` for relay events
  and payloads.

The derivation labels, canonical JSON, envelope fields, and HLC encoding are
protocol commitments. Change them only with cross-language conformance vectors
and coordinated TypeScript, Swift, and Kotlin migrations.

See the [client guide](../../docs/local-first/guide.md),
[wire protocol](../../docs/local-first/sync.md), and
[security model](../../SECURITY.md).
