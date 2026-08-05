# `@simplysync/node`

Node.js 22.13+ adapters for `@simplysync/engine`. The package uses the built-in
[`node:sqlite`](https://nodejs.org/api/sqlite.html) module, so CLI and Raycast
clients do not need a native npm dependency.

```sh
bun run clone node ../my-node-sync
cd ../my-node-sync
bun install --no-save
bun run build
```

```ts
import { createSync } from "@simplysync/engine";
import { createNodeSyncDeps } from "@simplysync/node";

const deps = createNodeSyncDeps({
  directory: "/absolute/app-support/path",
  secureStorage, // an OS- or host-encrypted SecureStorage implementation
});
const engine = createSync(deps)(schema, {
  name: "todos",
  transports: [{ type: "Http", url: "https://relay.example.com" }],
});

await engine.ready;
// Call this when a short-lived command exits.
deps.close();
```

The adapter enables WAL, enforces foreign keys, uses a write-lock timeout, and
supports nested transactions. Engine names are restricted before being turned
into filenames.

## Raycast

Raycast stores extension
[`LocalStorage`](https://developers.raycast.com/api-reference/storage) in its
encrypted local database. Adapt that API structurally and keep the SQLite file
in the extension support path:

```ts
import { environment, LocalStorage } from "@raycast/api";
import {
  createKeyValueSecureStorage,
  createNodeSyncDeps,
} from "@simplysync/node";

const secureStorage = createKeyValueSecureStorage({
  getItem: (key) => LocalStorage.getItem<string>(key),
  setItem: (key, value) => LocalStorage.setItem(key, value),
  removeItem: (key) => LocalStorage.removeItem(key),
});

export const syncDeps = createNodeSyncDeps({
  directory: environment.supportPath,
  secureStorage,
});
```

Raycast manages its Node runtime. This adapter requires a runtime where
`node:sqlite` is available without a flag (Node 22.13 or newer); fail extension
startup with a clear upgrade message if an older managed runtime is encountered.
Do not put recovery keys in a plain JSON file for a production CLI.
