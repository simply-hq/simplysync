# @simplysync/react-native

React Native bindings and Expo platform adapters for the canonical
`@simplysync/engine`. This package does not implement another sync protocol: it
connects the same engine used by React, browser, Raycast, and CLI clients to
Expo SQLite and SecureStore.

## Use from source

The React Native preset includes the Expo TodoList and every source dependency:

```sh
bun run clone react-native ../my-mobile-sync
cd ../my-mobile-sync
bun install --no-save
bun run build
```

The Expo example manifest already pins Expo SQLite, SecureStore, native crypto,
Nitro Modules, and base64 support.

Import the crypto bootstrap before the application entry:

```js
import "@simplysync/react-native/install";
import "expo-router/entry";
```

Wrap the Expo Metro config. This maps Node's `crypto` import to the native
implementation and excludes Kysely's Node-only filesystem migration provider
from the Hermes bundle (SimplySync uses its own schema migrations):

```js
const { getDefaultConfig } = require("expo/metro-config");
const {
  withSimplySyncMetroConfig,
} = require("@simplysync/react-native/metro");

module.exports = withSimplySyncMetroConfig(getDefaultConfig(__dirname));
```

## Create an engine

```tsx
import { createSync, id, NonEmptyString, SqliteBoolean } from "@simplysync/engine";
import {
  createExpoSyncDeps,
  ReactNativeSyncProvider,
  useQuery,
  useSyncState,
} from "@simplysync/react-native";

const schema = {
  todo: {
    id: id("todo"),
    title: NonEmptyString,
    done: SqliteBoolean,
  },
};

const engine = createSync(createExpoSyncDeps({
  // Optional local at-rest protection. Also enable useSQLCipher in app.json.
  sqlCipher: {},
}))(schema, {
  name: "todos",
  transports: [{ url: "https://relay.example.com" }],
});

const activeTodos = engine.createQuery((db) =>
  db
    .selectFrom("todo")
    .selectAll()
    .where("isDeleted", "=", 0)
    .orderBy("updatedAt", "desc"),
);

function TodoList() {
  const todos = useQuery(activeTodos);
  const syncState = useSyncState();
  return null; // render with normal React Native components
}

export function App() {
  return (
    <ReactNativeSyncProvider value={engine}>
      <TodoList />
    </ReactNativeSyncProvider>
  );
}
```

`ReactNativeSyncProvider` adds foreground-resume sync to the normal React
provider. For owner restore/reset, pass a production-safe `reloadApp` function
to `createExpoSyncDeps` (for example Expo Updates' `reloadAsync`).

For SQLCipher, add the Expo config plugin as well as `sqlCipher: {}`:

```json
["expo-sqlite", { "useSQLCipher": true }]
```

The adapter generates a random per-engine passphrase and stores it in
SecureStore. It applies and validates the key before the engine reads any
schema. Do not enable `sqlCipher` without the native config plugin: ordinary
SQLite ignores the key pragma and would not provide local database encryption.

The Expo SQLite adapter deliberately uses the synchronous API because engine
transactions must be atomic and return synchronously. Individual statements
are short; expensive encryption and relay I/O stay asynchronous.
