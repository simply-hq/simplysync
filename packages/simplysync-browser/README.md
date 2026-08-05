# @simplysync/browser

Browser platform adapters for SimplySync: a synchronous sql.js driver backed by
IndexedDB snapshots, encrypted recovery-key storage using a non-extractable Web
Crypto key, persistent-storage requests, and an enforced single-writer lock.

## Use from source

Use the `web` selective clone preset. It includes this workspace, the browser
TodoList, React bindings, engine, and protocol; run
`bun install --no-save && bun run build` in the resulting clone.

## Quick start

```ts
import {
  createEncryptedSecureStorage,
  createIndexedDbSnapshotStore,
  createSqlJsDriverFactory,
  createBrowserOwnerStore,
  deriveBrowserAppOwner,
} from "@simplysync/browser";

const secureStorage = createEncryptedSecureStorage({
  databaseName: "simplysync-todos",
});
const snapshots = createIndexedDbSnapshotStore({
  databaseName: "simplysync-todos",
});
const createSqliteDriver = createSqlJsDriverFactory({
  store: snapshots,
  locateFile: () => "/sql-wasm.wasm",
});
const ownerStore = createBrowserOwnerStore(secureStorage);
const owner = await deriveBrowserAppOwner(
  await ownerStore.loadOrCreateRecoveryKey(),
);
```

New browser owners use portable `sf1_` recovery keys. Restore accepts either an
`sf1_` key or a legacy BIP39 phrase, and invalid stored credentials are never
silently replaced with a different owner.

The driver snapshots the whole sql.js database after writes. Keep the default
required writer lock enabled so a second tab cannot overwrite a newer snapshot.
An async OPFS driver should replace this model only after measured database size
or write latency justifies an engine-wide asynchronous storage API.

`locateFile` must resolve sql.js' `sql-wasm.wasm` in your bundler or public
assets. Call `closeSqlJsDatabases()` during an intentional app shutdown so the
latest snapshot is persisted and the writer lock is released.
