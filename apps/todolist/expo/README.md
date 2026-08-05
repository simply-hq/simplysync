# SimplySync Todos — React Native / Expo

The React Native UI for the repository's one canonical todo example. It uses
the source-module boundary:

- `@simplysync/engine` for schema, mutations, SQLite rows, encrypted outbox, and
  relay sync;
- `@simplysync/react-native` for Expo SQLite, SecureStore, native crypto, React
  hooks, and foreground lifecycle integration.

There is no app-specific sync implementation here. The `todo` table is the same
three-column schema used by the TypeScript CLI, Swift app, and Kotlin interop
test, so one recovery key and one relay represent one owner on every client.

## Run

This app uses native SQLite and crypto modules, so the first run builds a custom
Expo development client. From the repository root, choose one platform:

```sh
bun run --cwd apps/todolist/expo ios
# or
bun run --cwd apps/todolist/expo android
```

After that development client is installed, `bun run todo:expo` starts Metro
for later runs.

The first launch is local-only. To sync, open settings and enter a relay URL, or
set `EXPO_PUBLIC_SIMPLYSYNC_RELAY_URL` before starting Expo. An iOS Simulator
uses `http://localhost:4100`; an Android Emulator uses
`http://10.0.2.2:4100` for a relay running on the development machine.

To create an independently named app from this exact client source:

```sh
bun run scaffold react-native my-app
bun run --cwd apps/my-app ios
# or: bun run --cwd apps/my-app android
```

On first launch, save the displayed recovery key and confirm it. To add a
device, open settings, choose **Show add-device key**, then paste that key into
**Already have a key?** on the new device. If the key is lost, no one can
recover the synced data. Pull to refresh or use the Sync button; encrypted rows
converge through the same canonical Go relay.

The app config enables Expo SQLite's SQLCipher build, and the React Native
adapter generates a device-held database passphrase in SecureStore before
opening the engine. The relay remains ciphertext-only regardless of local
database configuration.
