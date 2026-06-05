# Local First Expo Demo

This is the native Expo demo for the minimal local-first stack in this repo.

- Local data lives in `expo-sqlite`.
- Recovery/device/database keys live in `expo-secure-store`.
- Sync envelopes are encrypted with the recovery-derived data key before they are sent to the relay.
- The relay only stores owner ids, auth hashes, and encrypted envelopes.
- Local writes are saved first, then synced to the relay opportunistically when it is reachable.
- Restore uses the recovery key: paste an `sf1_...` key in the app, then tap `Restore & Sync`.
- The app is shaped for large ledgers: entry reads use keyset pagination, the UI uses `FlatList`, and sync pushes/pulls bounded batches instead of loading the whole owner history into memory.

The relay defaults are sized for a 500k-record demo profile:

```sh
MAX_OWNER_BYTES=1073741824 \
MAX_EVENTS_PER_PUSH=1000 \
MAX_EVENTS_PER_PULL=5000 \
DEFAULT_EVENTS_PER_PULL=1000 \
bun run simplysync:relay
```

Run it with a local relay:

```sh
bun run simplysync:relay
```

Then in another terminal:

```sh
bun run simplysync:expo:ios
# or
bun run simplysync:expo:android
```

Android emulators use `http://10.0.2.2:4100` by default. iOS simulators use `http://localhost:4100`.
