# AGENTS.md

Instructions for coding agents working **on this repository**. `CLAUDE.md`
imports this file, so every agent reads the same rules. If you are instead
building an app that *uses* SimplySync, read
[`docs/local-first/agents.md`](docs/local-first/agents.md) — that's the
consumer-facing contract.

SimplySync is an app-owned, end-to-end-encrypted, local-first sync engine:
apps write to a local SQLite database first and sync opportunistically through
a relay that only ever sees ciphertext (nonce + ciphertext + routing
metadata). The protocol core is implemented four times — TypeScript, Go,
Kotlin, and Swift — and all four must stay wire-compatible.

## Commands

| Purpose | Command | Notes |
| --- | --- | --- |
| Install | `bun install` | Bun `1.3.9`-pinned by the root `packageManager` field; workspace monorepo, turbo-orchestrated |
| Test | `bun run test` | `turbo run test`: protocol + engine + Go relay conformance + TodoList web/CLI suites |
| Typecheck | `bun run typecheck` | `tsc --noEmit` across all TypeScript workspaces |
| Kotlin tests | `bun run kotlin:test` | Gradle JUnit suite, pure JVM, no Android SDK needed |
| Swift package | `bun run swift:test` | Builds the root SwiftPM library product and tests its public API; macOS required |
| App sync-port drift | `bun run app-port:check` | Fails when upstream sync/protocol code or the iOS/Android app ports changed without an intentional baseline refresh |
| Explain that drift | `bun run sync:diff` | Read-only. Shows the actual divergent lines, ignoring the mechanical Swift/Kotlin rewrites — run this before refreshing any baseline |
| Conformance corpus | `bun run vectors:check` / `vectors:gen` | The corpus has three checked-in copies (TS, Swift, Kotlin); `gen` writes all three, `check` fails if they drift apart |
| Go relay build/vet | `cd apps/relay-go && go build ./... && go vet ./...` | Go 1.25 toolchain (auto-fetched via `GOTOOLCHAIN=auto`), cgo-free |
| Dev: canonical relay | `bun run relay:go` | Go relay, ciphertext-only store |
| Dev: canonical app | `bun run todo:dev` | relay + two devices converging; stays up for `bun run todo …` |
| TodoList E2E | `bun run todo:e2e` | scenario matrix across local web, Swift, and Kotlin clients |
| Protocol diagnostic | `bun run protocol:demo` | spins up a relay and exposes the raw envelope flow |
| Dev: native todo | `bun run todo:expo` | Expo TodoList: expo-sqlite + expo-secure-store |
| Dev: docs site | `bun run docs:dev` | static docs site + TodoList web client |

CI lives in `.github/workflows/ci.yml`: Bun typecheck+tests, the Go relay, the
Kotlin port, and the local TodoList cross-platform sync e2e
(`todo-e2e-linux` per-PR on Linux; `todo-e2e-cross` on macOS,
main+nightly only). The e2e harness builds the TodoList web, Swift, and Kotlin
clients directly from this repository and does not require private app repos.

## Map

- `packages/simplysync-protocol` — protocol core: identity, key derivation, AES-GCM envelopes, HLC, encoding. Pinned.
- `packages/simplysync-engine` — schema + Kysely query layer + sync engine (where payloads get encrypted/decrypted). `engine/admission.ts` is the single ladder deciding what happens to an arriving event — apply, defer, or reject — shared by the relay pull and the deferred replay; change it there, not per path.
- `packages/simplysync-react` — React hooks for binding the engine into a UI.
- `packages/simplysync-react-native` — React Native bindings plus Expo SQLite, SecureStore, SQLCipher, and lifecycle adapters.
- `packages/simplysync-node` — `node:sqlite` lifecycle adapters for Node, Raycast, and CLI clients.
- `apps/relay-go` — canonical self-hostable relay: Go + SQLite, stores only ciphertext.
- `apps/relay-conformance` — black-box HTTP contract tests for the canonical Go relay.
- `apps/relay-cloudflare` — serverless relay on Cloudflare Workers + D1 + R2.
- `apps/todolist` — the only product example, grouping the CLI, browser,
  React Native/Expo, SwiftUI, and Kotlin clients around one schema and owner.
- `Sources/SimplySync` — root `SimplySync` SwiftPM library sources; the native
  SwiftUI client in `apps/todolist/swift` compiles the same tree.
- `apps/todolist/kotlin` — source-owned Kotlin/JVM protocol + engine module;
  wire-compatible, pure-JVM, and unit-tested.
- `apps/todolist/e2e` — cross-platform TodoList convergence scenarios for the
  local web, Swift, and Kotlin clients.
- `apps/docs` — documentation site; bundles `apps/todolist/web`.
- `tools/protocol-demo` — low-level envelope/HLC diagnostic for port authors.

## Frozen invariants — do not casually touch these

1. `DERIVATION_SALT = "sbt-local-first-v1"` (`packages/simplysync-protocol/src/crypto.ts:7`) is a wire-protocol constant. Renaming or changing it remaps every existing user's recovery phrase to a different identity and key set — effectively a permanent lockout from their own data.
2. The protocol core is **pinned** (`README.md`, "What's in the box": "Treat as pinned — update wholesale, don't fork."). Any change to the HLC format, envelope format, canonical JSON, or key derivation must be mirrored across the Kotlin port (`apps/todolist/kotlin`), the Swift port (`Sources/SimplySync`), and relay implementations (`apps/relay-go`, `apps/relay-cloudflare`) — otherwise clients stop being able to sync with each other.
3. The Simply Finance app ports are app-owned copies, not symlinks. After changing protocol/engine/native-port code, run `bun run app-port:check` from this repo. If it fails, run `bun run sync:diff` to see what actually diverged — the check only knows a tree's hash moved, not which file or in which direction. Then review and port the change into `../ios-simplyfinance` and `../android-simplyfinance`, and only once the ports agree, refresh the checked-in baseline with `bun run app-port:update`. Refreshing first is how an unported change gets waved through. Note the check hashes whole trees, so a pure TypeScript restructuring with no behaviour change also trips it: engine *internal* structure is explicitly not required to match across ports (see `docs/simplysync-system/matrix.md`), only wire behaviour is.
4. Conflict resolution is **last-write-wins by HLC**, not CRDT merging — `compareHlc` is the sole tiebreaker (`packages/simplysync-engine/src/engine/relay.ts:160`).
5. Deletes are **soft tombstones** that must replicate (`packages/simplysync-engine/src/engine/mutations-lifecycle.ts:114-118`); a hard delete resurrects rows from peers on the next pull.
6. Relays must stay **ciphertext-only** — never add a field that exposes payload contents. See `SECURITY.md` for the threat model and the exact source files that enforce it.

## Gotchas that cost real debugging time

- **Examples import built `dist/`, not `src/`.** `@simplysync/engine`'s
  `package.json` points at `./dist/index.js`, so editing engine source and then
  running an example (or the TodoList web client) silently executes the *previous*
  build. The engine's own tests import `../src/index` and do reflect your edit —
  so tests can pass while the demo runs stale code. The root `todo:*`,
  `protocol:demo`, and `docs:dev` scripts run `turbo run build` first; anything invoked
  directly with `bun run --cwd …` does not.
- **A relay 404 means "owner unknown", not "broken".** Both reference relays
  create an owner on PUSH only, so pull and status 404 until an account's first
  event lands.

## Conventions

- Dependencies are exact-pinned. Expo-managed dependencies keep Expo's
  compatibility `~` ranges, and peer dependencies use bounded ranges.
- Commits are conventional-commit style with a workspace scope, e.g. `feat(engine): …`, `perf(relay): …`, `feat(ios): …`, `docs: …`, `chore: …` (see `git log --oneline`).
- No linter or formatter is configured yet — match the surrounding file's style by hand.
- Comments explain constraints and intent, not mechanics — see the top-of-file doc comment in `packages/simplysync-engine/src/engine/query-cache.ts` for the model to follow.
