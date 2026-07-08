# CLAUDE.md

SimplySync is an app-owned, end-to-end-encrypted, local-first sync engine:
apps write to a local SQLite database first and sync opportunistically through
a relay that only ever sees ciphertext (nonce + ciphertext + routing
metadata). The protocol core is implemented four times — TypeScript, Go,
Kotlin, and Swift — and all four must stay wire-compatible.

## Commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `bun install` | Bun `1.3.9`-pinned (`package.json:12`) workspace monorepo, turbo-orchestrated |
| Test | `bun run test` | `turbo run test`: protocol + engine (84 tests) + docs playground suites |
| Typecheck | `bun run typecheck` | `tsc --noEmit` across 7 workspaces |
| Kotlin tests | `bun run kotlin:test` | Gradle JUnit suite, pure JVM, no Android SDK needed |
| App sync-port drift | `bun run app-port:check` | Fails when upstream sync/protocol code or the iOS/Android app ports changed without an intentional baseline refresh |
| Go relay build/vet | `cd apps/relay-go && go build ./... && go vet ./...` | Go 1.25 toolchain (auto-fetched via `GOTOOLCHAIN=auto`), cgo-free |
| Dev: canonical relay | `bun run relay:go` | Go relay, ciphertext-only store |
| Dev: reference relay | `bun run relay:bun` | Bun relay, wire-identical to the Go relay |
| Dev: CLI demo | `bun run demo` | spins up a relay and syncs two clients |
| Dev: native demo | `bun run expo` | Expo demo: expo-sqlite + expo-secure-store |
| Dev: docs site | `bun run docs:dev` | static docs site + playground |

There is no CI workflow in this tree yet (`.github/workflows/ci.yml` does not
exist) — plan `plans/011` is introducing one; don't assume these suites are
gated in CI until that lands.

## Map

- `packages/simplysync-protocol` — protocol core: identity, key derivation, AES-GCM envelopes, HLC, encoding. Pinned.
- `packages/simplysync-engine` — schema + Kysely query layer + sync engine (where payloads get encrypted/decrypted).
- `packages/simplysync-react` — React hooks for binding the engine into a UI.
- `apps/relay-go` — canonical self-hostable relay: Go + SQLite, stores only ciphertext.
- `apps/simplysync-relay` — Bun + SQLite relay, reference implementation, wire-identical to the Go relay.
- `apps/relay-cloudflare` — serverless relay on Cloudflare Workers + D1 + R2.
- `apps/simplysync-example` — CLI reference client + one-shot two-client sync demo.
- `apps/simplysync-expo` — native Expo demo.
- `apps/simplysync-ios-swift` — native Swift port of the protocol core.
- `apps/simplysync-android-kotlin` — native Kotlin/Android port of the protocol core, wire-compatible, pure-JVM, unit-tested.
- `apps/simplysync-docs` — docs site + playground tests.
- `apps/simplysync-ai-chat` — local-first AI chat example built on `@simplysync/engine`.

## Frozen invariants — do not casually touch these

1. the fixed protocol-v1 `DERIVATION_SALT` byte sequence (`packages/simplysync-protocol/src/crypto.ts:7`) is a wire-protocol constant. Renaming or changing it remaps every existing user's recovery phrase to a different identity and key set — effectively a permanent lockout from their own data.
2. The protocol core is **pinned** (`README.md`, "What's in the box": "Treat as pinned — update wholesale, don't fork."). Any change to the HLC format, envelope format, canonical JSON, or key derivation must be mirrored across the Kotlin port (`apps/simplysync-android-kotlin`), the Swift port (`apps/simplysync-ios-swift`), and both relays (`apps/relay-go`, `apps/simplysync-relay`) — otherwise clients stop being able to sync with each other.
3. The Simply Finance app ports are app-owned copies, not symlinks. After changing protocol/engine/native-port code, run `bun run app-port:check` from this repo. If it fails, review and port the change into `../simplyfinance` and `../android-simplyfinance`, then refresh the checked-in baseline with `bun run app-port:update`.
4. Conflict resolution is **last-write-wins by HLC**, not CRDT merging — `compareHlc` is the sole tiebreaker (`packages/simplysync-engine/src/engine/relay.ts:160`).
5. Deletes are **soft tombstones** that must replicate (`packages/simplysync-engine/src/engine/mutations-lifecycle.ts:114-118`); a hard delete resurrects rows from peers on the next pull.
6. Relays must stay **ciphertext-only** — never add a field that exposes payload contents. See `SECURITY.md` for the threat model and the exact source files that enforce it.

## Conventions

- Dependencies are exact-pinned (no `^`/`~`). The one exception is `@anthropic-ai/sdk: ^0.70.0` in `apps/simplysync-ai-chat/package.json` — a known deviation, not the convention to imitate.
- Commits are conventional-commit style with a workspace scope, e.g. `feat(engine): …`, `perf(relay): …`, `feat(ios): …`, `docs: …`, `chore: …` (see `git log --oneline`).
- No linter or formatter is configured yet — match the surrounding file's style by hand.
- Comments explain constraints and intent, not mechanics — see the top-of-file doc comment in `packages/simplysync-engine/src/engine/query-cache.ts` for the model to follow.

## Plans

`plans/README.md` indexes every implementation plan (execution order,
dependencies, status). If you were handed a plan from `plans/`: read it in
full before starting, honor every STOP condition instead of improvising
around it, and update your row in that index when you finish.
