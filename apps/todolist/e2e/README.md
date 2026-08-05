# TodoList E2E

Headless cross-platform scenarios proving that the repository's
[web](../web), [Swift](../swift), and [Kotlin](../kotlin) TodoList clients
converge through the real [Go relay](../../relay-go).

The harness uses each client's production `SyncEngine`, SQLite adapter,
encryption code, and shared `todo(id, title, done)` schema. All runner sources
live in this repository; no private app checkout or repository secret is
required.

## Run

From the repository root:

```sh
bun run todo:e2e
```

The default matrix runs:

```text
swift ↔ kotlin
kotlin ↔ kotlin
swift ↔ swift
web ↔ swift
web ↔ kotlin
```

Use `--matrix` or `--scenario` for a focused run:

```sh
bun run todo:e2e -- --matrix web-kotlin,kotlin-kotlin
bun run todo:e2e -- --matrix swift-kotlin --scenario basic-convergence
bun run todo:e2e -- --matrix web-web --scenario tombstone
```

Swift pairings require macOS with `swiftc`. Kotlin pairings require JDK 17.
Every pairing requires Go and Bun.

The workspace's normal `test` script remains opt-in because native compilers
make this suite substantially slower than unit tests:

```sh
SIMPLYSYNC_TODO_E2E=1 bun run --cwd apps/todolist/e2e test
```

## How it works

```text
                         TodoList E2E orchestrator
                    scenarios + assertions + Go relay
                         /          |          \
                        /           |           \
              web/sql.js      Swift/SQLite3    Kotlin/JDBC
                  |                 |                 |
                  +-----------------+-----------------+
                                    |
                             ciphertext relay
```

One long-lived runner process serves multiple isolated devices for each
platform. The orchestrator communicates through an atomic file mailbox, starts
a fresh relay for every scenario, and compares exported SQLite rows. Devices are
disposed with their scenario, so a long matrix doesn't accumulate open databases.

Scenarios cover:

- bidirectional convergence;
- HLC last-write-wins conflicts;
- rejected auth, with the outbox left intact;
- offline outbox recovery;
- recovery-key restore and add-a-device identity adoption across every pairing;
- large payload and quota failures;
- new-relay state backfill;
- pull pagination and push batching;
- replicated soft-delete tombstones, including the durable relay-history guard
  that prevents compaction after transports are detached.

Scenario steps support `mutate`, `mutateRange`, `sync`, `syncExpectError`,
`owner`, `restoreOwner`, and `purge`. Assertions support `statesEqual`, `row`,
`noRow`, `rowCount`, `outboxCount`, `equals`, `notEquals`, and `atLeast`.

A relay entry declared as `{ "id": "…", "rejectStatus": 401 }` is a stub that
answers everything with that status, which is how a client's failure mapping is
checked without a second relay build. The relay's own auth gating belongs to
[relay-conformance](../../relay-conformance).

`purge` asserts the safety contract shared by all three ports: never-synced
databases can reclaim local tombstones, while any database with relay history
retains them until the protocol gains a cross-device deletion watermark.
Relay-side stream compaction (`_sync_purge` → `POST /v1/streams/compact`) is
TypeScript-only legacy cleanup, so it is not asserted here.
