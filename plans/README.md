# Audit follow-up — status & remaining backlog

Written against commit `0a5aa5e` (branch `refactor/deepen-sync-seams`). This
tracks the audit-driven trust/credibility work: what landed this pass, and the
lower-leverage tail left to do. Prioritized by leverage.

## Implemented this pass (all validated)

Full validation: `bun run test` (16/16 turbo tasks), `bun run typecheck`
(20/20), `go build/vet/test -race`, `swift test` + the swiftc verify harness,
`./gradlew test`, `bun run docs:check-links`.

**Docs honesty**
- SECURITY.md dead pointer fixed (`engine.ts` → `engine/relay.ts`); added an
  "Assurance level" section (no third-party audit; platform primitives; nonce
  budget), a working security-reporting channel, and a blob TypeScript-only note.
- `scripts/check-markdown-links.ts` now also verifies that a code symbol named
  next to a SECURITY.md link actually exists in the target file (guards the
  trust page against future symbol drift).
- README now lists the canonical Go relay (table + clone preset).

**Relay security & robustness (Go + Cloudflare)**
- Empty/malformed `streamId` no longer stored: both relays now treat
  null/absent/"" as "no stream" and reject a present malformed id. Closes the
  Cloudflare compaction-cron data-loss path; the 3 pinned divergence tests were
  rewritten to assert parity.
- Constant-time auth-hash comparison on both relays.
- Go: trusted-proxy gating for the client IP (`TRUST_PROXY_HEADERS`, default
  off) so per-IP limiters + admin lockout can't be bypassed with a forged
  header; per-IP owner-creation limiter (`RATE_LIMIT_CREATE`, parity with CF);
  admin-fails map now swept. Caddyfile/systemd/README updated.
- Pull pages bounded by bytes (`MAX_PULL_BYTES`, 8 MiB) on both relays.
- `go test -race` in CI and the selective-clone check.

**Crypto correctness (protocol core + Kotlin/Swift ports)**
- `canonicalJson` rejects non-plain objects (Date/Map/Set) and non-finite
  numbers instead of silently emitting `{}`/`null`.
- `base64UrlDecode` rejects illegal lengths and non-canonical trailing bits
  (brings TS in line with the stricter platform decoders — recovery-key
  portability).
- Backup PBKDF2 iteration count clamped on decrypt (TS + Kotlin) — denial-of-
  restore defense.
- `sealPayload` → `unsafeSealPayloadWithNonce` (nonce-reuse footgun off the
  main API name).
- Deleted the unused, under-guarded Swift `HLCClock`.
- Mnemonic normalization widened to JS's exact `\s` set in Kotlin + Swift
  (a phrase with a non-breaking space now derives the same identity everywhere).
- Kotlin canonicalizer escapes unpaired surrogates (was silently → `?`).

**Sync engine**
- Decrypt failures are now surfaced on Kotlin + Swift (`setError`/`lastError`)
  instead of a silent drop (TS already logged them).
- HLC high-water mark seeded before deferred-replay at boot (was a clock-
  regression → lost-update risk).

**Durability (browser)**
- `sql-js-driver` persist debounce gained a max-wait ceiling (writes can't be
  starved out of durable storage) and a `visibilitychange`/`pagehide` flush.

**Tests**
- `packages/simplysync-engine/test/convergence.test.ts` — randomized N-device
  convergence property test (seeded, random op interleavings + partitions).
- Conformance corpus widened with escapes / emoji / CJK across all ports.
- New: `canonical-json.test.ts`, `CanonicalJsonTest.kt`, base64 + PBKDF2 cases.

## ⚠️ Required follow-up before release

**Native app-port drift.** The protocol/port changes above are wire-compatible
(they reject invalid input, widen accepted input, or add defense — no valid-data
break), but `bun run app-port:check` is red: the app-owned copies in
`../ios-simplyfinance` and `../android-simplyfinance` are behind. Run
`bun run sync:diff` to see exactly what, port the changes down into those repos,
and only then `bun run app-port:update`. Do **not** refresh the baseline before
porting (it would absorb a pre-existing backlog). Highest-value to port:
mnemonic-whitespace (Bip39), snapshot PBKDF2 clamp, canonicalizer surrogate
escaping — the ones that affect cross-device identity/backup portability.

## Second pass — the remaining backlog, now implemented (all validated)

- **RELAY-05** — both relays bound a `Content-Length`-less (chunked) body via a
  streaming counting read that aborts past the cap, not just the Content-Length
  pre-filter. Conformance test streams an oversized chunked push at both.
- **RELAY-11** — opt-in global storage ceiling (`MAX_TOTAL_BYTES`, default off)
  on both relays, checked inside the locked write txn on push and blob, returning
  `507`. Conformance test + Go README.
- **ENGINE-05** — the auditor's primary fix: reject an oversized event at *write
  time* (`maxEventBytes`, default 256 KiB) so the poison pill never forms, with a
  clear "too large — use the blob API" error. `event-size-guard.test.ts`. (The
  bisect-and-quarantine of an *already-poisoned* outbox — the `_sync_rejected`
  table — remains a follow-up; the write-time guard prevents new ones.)
- **CACHE-01/02/03** — re-subscribe after eviction re-resolves the live entry
  (no more silent stop-updating); a listener-count cap evicts only listener-less
  entries (bounded growth); a query with undetectable table deps now refreshes on
  any change (not never) with a one-time warning. `query-cache.test.ts` covers
  the re-subscribe case.
- **TEST-11** — `@simplysync/react` now has a test suite (context guard, provider
  wiring, `useQuery`/`useSyncState` snapshot rendering) via `react-dom/server`.
- **CRYPTO-13** — SECURITY.md now documents the mnemonic-path `streamKey` HKDF
  derivation and that the two derivation paths differ.

## Still open (single item, deliberately deferred)

- **ENGINE-05 (part 2)** — bisect a rejected push batch and move the offending
  event to a durable `_sync_rejected` table (retry/inspection), for an outbox
  that was poisoned before the write-time guard existed or by a relay stricter
  than the client's `maxEventBytes`. Needs an internal schema addition in the
  durability-critical seal/outbox path; scoped out of this pass to avoid that
  risk while the write-time guard covers the documented trigger.

Considered and **not** worth doing (recorded so they aren't re-audited):
`dataKey` rotation, changing the `streamId` HMAC separator, a shared
shortest-round-trip double formatter for the ports (payload canonical is not
re-canonicalized by the receiver, so float-formatting divergence is cosmetic,
not a correctness bug) — each is a wire-format change whose cost exceeds the
risk it retires.
