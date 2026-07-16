# CLAUDE.md

SimplySync is an app-owned, end-to-end-encrypted, local-first sync engine:
apps write to a local SQLite database first and sync opportunistically through
a relay that only ever sees ciphertext (nonce + ciphertext + routing
metadata). The protocol core is implemented four times — TypeScript, Go,
Kotlin, and Swift — and all four must stay wire-compatible.

## Commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `bun install` | Bun `1.3.9`-pinned (`packageManager` in `package.json`) workspace monorepo, turbo-orchestrated |
| Test | `bun run test` | `turbo run test`: protocol + engine + Go relay conformance + docs playground suites |
| Typecheck | `bun run typecheck` | `tsc --noEmit` in 9 typed workspaces |
| Kotlin tests | `bun run kotlin:test` | Gradle JUnit suite, pure JVM, no Android SDK needed |
| App sync-port drift | `bun run app-port:check` | Fails when upstream sync/protocol code or the iOS/Android app ports changed without an intentional baseline refresh |
| Go relay build/vet | `cd relays/go && go build ./... && go vet ./...` | Go 1.25 toolchain (auto-fetched via `GOTOOLCHAIN=auto`), cgo-free |
| Dev: canonical relay | `bun run relay:go` | Go relay, ciphertext-only store |
| Dev: CLI demo | `bun run demo` | spins up a relay and syncs two clients |
| Dev: native demo | `bun run expo` | Expo demo: expo-sqlite + expo-secure-store |
| Dev: docs site | `bun run docs:dev` | static docs site + playground |

CI lives in `.github/workflows/ci.yml` and validates Bun typechecking/tests, the
Go relay, and the Kotlin port on pushes and pull requests.

## Map

### Core engine

- `packages/simplysync-protocol` — protocol core: identity, key derivation, AES-GCM envelopes, HLC, encoding. Pinned.
- `packages/simplysync-engine` — schema + Kysely query layer + sync engine (where payloads get encrypted/decrypted).
- `packages/simplysync-react` — React hooks for binding the engine into a UI.

### Native ports

- `ports/swift` — native Swift port of the protocol and engine.
- `ports/kotlin` — native Kotlin/JVM port of the protocol and engine, wire-compatible and unit-tested.

### Relays

- `relays/go` — canonical self-hostable relay: Go + SQLite, stores only ciphertext.
- `relays/cloudflare` — serverless relay on Cloudflare Workers + D1 + R2.

### Examples

- `examples/cli` — CLI reference client + one-shot two-client sync demo.
- `examples/expo` — native Expo demo.
- `examples/ai-chat` — local-first AI chat example built on `@simplysync/engine`.

### Verification and documentation

- `tests/relay-conformance` — black-box HTTP contract tests for the canonical Go relay.
- `tests/app-e2e` — cross-platform native convergence harness.
- `docs/local-first` — guides, architecture, security, and self-hosting documentation.
- `docs/site` — static docs site + browser playground tests.

## Frozen invariants — do not casually touch these

1. the fixed protocol-v1 `DERIVATION_SALT` byte sequence (`packages/simplysync-protocol/src/crypto.ts:7`) is a wire-protocol constant. Renaming or changing it remaps every existing user's recovery phrase to a different identity and key set — effectively a permanent lockout from their own data.
2. The protocol core is **pinned** (`README.md`, "What's in the box": "Treat as pinned — update wholesale, don't fork."). Any change to the HLC format, envelope format, canonical JSON, or key derivation must be mirrored across the Kotlin port (`ports/kotlin`), the Swift port (`ports/swift`), and relay implementations (`relays/go`, `relays/cloudflare`) — otherwise clients stop being able to sync with each other.
3. Product app ports are app-owned copies, not symlinks. Maintainers with those sibling repositories available should run `bun run app-port:check` after changing protocol, engine, or native-port code and intentionally refresh the checked-in baseline only after reviewing the ported changes.
4. Conflict resolution is **last-write-wins by HLC**, not CRDT merging — `compareHlc` is the sole tiebreaker (`packages/simplysync-engine/src/engine/relay.ts:160`).
5. Deletes are **soft tombstones** that must replicate (`packages/simplysync-engine/src/engine/mutations-lifecycle.ts:114-118`); a hard delete resurrects rows from peers on the next pull.
6. Relays must stay **ciphertext-only** — never add a field that exposes payload contents. See `SECURITY.md` for the threat model and the exact source files that enforce it.

## Conventions

- Dependencies are exact-pinned (no `^`/`~`). The one exception is `@anthropic-ai/sdk: ^0.70.0` in `examples/ai-chat/package.json` — a known deviation, not the convention to imitate.
- Commits are conventional-commit style with a workspace scope, e.g. `feat(engine): …`, `perf(relay): …`, `feat(ios): …`, `docs: …`, `chore: …` (see `git log --oneline`).
- No linter or formatter is configured yet — match the surrounding file's style by hand.
- Comments explain constraints and intent, not mechanics — see the top-of-file doc comment in `packages/simplysync-engine/src/engine/query-cache.ts` for the model to follow.
