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

## Run the browser demo

From a fresh clone:

```sh
bun install
bun run docs:dev
```

Open <http://localhost:4200/demo.html>. Alice and Bob are separate local
databases and work without a network. To sync them, paste the URL from the
[Cloudflare self-hosting guide](../../docs/local-first/self-hosting.md) into the
demo's **Relay URL** field.

The schema is declared identically in:

- [`cli/src/schema.ts`](./cli/src/schema.ts)
- [`web/schema.ts`](./web/schema.ts)
- [`expo/lib/todo-engine.ts`](./expo/lib/todo-engine.ts)
- [`swift/SimplySyncDemo/AppSchema.swift`](./swift/SimplySyncDemo/AppSchema.swift)
- [`kotlin/src/test/kotlin/com/simplysync/kotlin/EngineTest.kt`](./kotlin/src/test/kotlin/com/simplysync/kotlin/EngineTest.kt)

Run the Expo client:

```sh
bun run --cwd apps/todolist/expo ios
# or: bun run --cwd apps/todolist/expo android
```

The [Expo](./expo), [Swift](./swift), and [Kotlin](./kotlin) READMEs cover their
platform-specific build commands. Use the same Cloudflare relay URL and recovery
key when you want the clients to converge as one owner.

## Development security

The CLI's ignored JSON secret files are development-only stand-ins for an OS
secret store. Production clients use Keychain, Android Keystore-backed storage,
Expo SecureStore, or another host-encrypted credential store. Never log or
persist a recovery key as ordinary application data.
