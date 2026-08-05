# TodoList

The repository's only product example. Every client below implements the same
`todo(id, title, done)` contract, joins the same owner, and syncs through the
same relay and wire protocol.

| Client | Directory | Integration exercised |
| --- | --- | --- |
| Bun CLI | [`cli/`](./cli) | `@simplysync/engine` + Bun SQLite |
| Browser / React | [`web/`](./web) | `@simplysync/react` + `@simplysync/browser` |
| React Native / Expo | [`expo/`](./expo) | `@simplysync/react-native` |
| SwiftUI | [`swift/`](./swift) | `SimplySync` Swift package |
| Kotlin / Android-facing | [`kotlin/`](./kotlin) | Source module + `StateFlow` engine |
| Cross-platform E2E | [`e2e/`](./e2e) | Web ↔ Swift ↔ Kotlin convergence |

The low-level envelope diagnostic is deliberately outside the app tree at
[`tools/protocol-demo`](../../tools/protocol-demo).

## Run the app

One command, from a fresh clone — starts the relay, mints an owner, and proves
two devices converge through it:

```sh
bun install
bun run todo:dev
```

It stays up afterwards so you can drive the same account from other terminals:

```sh
bun run todo list --device phone
bun run todo add "From a third device" --device tablet
bun run todo toggle <id> --device laptop
```

Every `--device` name is a separate local database and outbox. The development
runner writes one ignored owner file so other TodoList clients can join that
same account.

The schema is declared identically in:

- [`cli/src/schema.ts`](./cli/src/schema.ts)
- [`web/schema.ts`](./web/schema.ts)
- [`expo/lib/todo-engine.ts`](./expo/lib/todo-engine.ts)
- [`swift/SimplySyncDemo/AppSchema.swift`](./swift/SimplySyncDemo/AppSchema.swift)
- [`kotlin/src/test/kotlin/com/simplysync/kotlin/EngineTest.kt`](./kotlin/src/test/kotlin/com/simplysync/kotlin/EngineTest.kt)

To check the three compiler-friendly implementations actually agree — one
relay, one owner, rows written by TypeScript, Swift, and Kotlin and read back:

```sh
bun run todo:interop
```

It runs TypeScript always, Kotlin when a JDK is present, and Swift when `swiftc`
is available. A missing toolchain is reported as **SKIPPED**, never as a pass.
A compiler or test failure exits non-zero.

Run the full scenario matrix against the local web, Swift, and Kotlin clients:

```sh
bun run todo:e2e
```

Run the browser face:

```sh
bun run relay:go
bun run docs:dev
```

Then open <http://localhost:4200/demo.html>.

Run the Expo face:

```sh
bun run relay:go
bun run todo:expo
```

## Development security

The CLI's ignored JSON secret files are development-only stand-ins for an OS
secret store. Production clients use Keychain, Android Keystore-backed storage,
Expo SecureStore, or another host-encrypted credential store. Never log or
persist a recovery key as ordinary application data.
