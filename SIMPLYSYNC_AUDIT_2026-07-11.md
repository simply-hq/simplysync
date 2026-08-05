# SimplySync engine audit — 2026-07-11

Scope: the TypeScript protocol and engine, the Go/Cloudflare relay implementations, native protocol parity, and the engine-to-app drift guard. Audited at `affe183` with a pre-existing local modification to `scripts/native-app-port-manifest.json`.

## Executive summary

The cryptographic boundary, atomic local-write/outbox path, cross-relay conformance suite, and native wire vectors are in good shape. Fresh validation is green. The main remaining risk is lifecycle correctness around evolution and garbage collection: the engine can permanently discard future-schema events, cannot backfill a relay added after outbox pruning, accepts far-future HLC rows despite the clock clamp, and can resurrect data after tombstone compaction when a long-offline peer returns.

## Findings

### P1 — Unknown-table events are permanently discarded by older clients

`pullAndApply` applies a decrypted event only when `payload.table in schema`, but inserts every event into `_sync_seen` and advances the relay cursor afterward (`packages/simplysync-engine/src/engine/relay.ts:397-427`). An older app receiving an event for a table introduced by a newer app therefore records it as consumed without storing it. After the older app upgrades and gains that table, the event is neither pulled nor applied again.

This conflicts with the engine's supported additive migration model, which explicitly supports adding new tables (`packages/simplysync-engine/test/migration.test.ts`). Existing forward-compatibility coverage tests unknown columns, not unknown tables.

Recommendation: durably stage authenticated events for unknown tables (payload or encrypted envelope plus relay/event identity) and replay them after schema initialization/upgrades. Do not rely on leaving the event unseen while advancing the cursor; that still loses it. Add an old-schema -> pull -> upgrade -> replay test.

### P1 — A relay added after normal pruning cannot receive existing history

Outbox rows are deleted once all *currently configured* relays have acknowledged them (`packages/simplysync-engine/src/engine/store.ts:412-439`). When a new relay is added later, its push cursor correctly starts empty, but `pushOutbox` can only send rows still present in `_sync_outbox` (`packages/simplysync-engine/src/engine/relay.ts:153-201`). In the normal steady state that table is empty, so the new relay receives no historical rows. Pulled events are also not re-enqueued for propagation to another relay.

The current test proves only that a newly added relay prevents pruning of rows that still exist; another test explicitly proves that a completed sync empties the outbox (`packages/simplysync-engine/test/prune-outbox.test.ts:82-95,98-144`). It does not cover adding relay B after relay A has already drained the queue.

Recommendation: make relay onboarding an explicit backfill operation. Options include generating one current-state envelope per live row/tombstone, copying from an existing relay, or retaining a compacted local sync journal. Do not present a newly added relay as redundant until backfill completes. Add a relay-A-only history -> prune -> add relay B -> restore-from-B test.

### P1 — Tombstone compaction permits resurrection from long-offline peers

After the retention window, the engine hard-deletes the local tombstone and asks every currently configured relay to delete the entire row stream (`packages/simplysync-engine/src/engine/store.ts:270-320`; `packages/simplysync-engine/src/engine/relay.ts:227-287`). No per-device acknowledgement or durable per-row deletion watermark remains.

A peer offline longer than the retention window can later return with an old live value. Since both the receiving client and relay may have forgotten the tombstone, the old event is accepted as a row with no local competitor. The same problem occurs when a relay containing historical rows is removed during purge and re-added later. The current purge tests cover relay acknowledgements, not an offline peer returning after compaction.

Recommendation: keep a compact deletion watermark/graveyard keyed by stream or `(table,rowId)` after removing row payloads, and reject events at or below that HLC. Define a safe expiry policy based on device membership/acknowledgements; otherwise document that peers offline beyond retention are unsupported and require reset. Add a three-device test where one device misses the delete and returns after compaction.

### P1 — The HLC drift clamp does not stop far-future rows from poisoning LWW

`observeHlc` refuses to raise the local clock for timestamps more than five minutes ahead (`packages/simplysync-engine/src/engine/store.ts:666-688`), but `applyRemoteRow` still compares and writes the same far-future `payload.hlc` without validating its shape or drift (`packages/simplysync-engine/src/engine/relay.ts:289-315`). The row then wins LWW against legitimate edits until wall time catches up. Different devices can make local lower-HLC edits, but peers holding the poisoned row reject them, producing persistent divergence.

Current tests assert only that the in-memory clock is not raised; they never pass a far-future event through pull/apply.

Recommendation: centralize strict HLC parsing/validation in the protocol package and apply the same admissibility rule before both clock observation and row application. Decide whether excessive future drift should quarantine the event, clamp it (usually unsafe for signatures/order), or surface a terminal sync error. Add end-to-end convergence tests for malformed and far-future authenticated events across TypeScript, Swift, and Kotlin.

## Validation performed

- `bunx turbo run test --force` — pass after Bun relay removal, uncached: protocol 43, engine 112, Go relay conformance 21, docs 2.
- `bunx turbo run typecheck --force` — pass for configured workspace tasks.
- `cd apps/relay-go && go test ./... && go vet ./...` — pass (no Go unit test files; behavior is covered by relay conformance).
- `cd apps/todolist/kotlin && ./gradlew test` — pass.
- `bun run app-port:check` — pass.
- `bun audit` — 11 advisories (4 high, 4 moderate, 3 low), all currently through Wrangler/Expo/React Native tooling paths rather than the core engine runtime.

## Recommended order

1. Fix unknown-table durability and relay onboarding/backfill before treating schema evolution and multi-relay redundancy as production-safe.
2. Redesign tombstone GC around durable deletion watermarks/device acknowledgement before relying on permanent relay compaction.
3. Enforce HLC admissibility at the apply boundary across every native implementation.
