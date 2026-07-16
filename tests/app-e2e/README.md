# app-e2e — cross-platform sync harness

Headless, engine-level end-to-end tests that prove the **real** iOS (Swift) and
Android (Kotlin) Simply Finance sync engines converge through a **real** Go relay.

It drives the production `SyncEngine` on each platform — not a reimplementation —
so a green run means an iOS device and an Android device actually agree after
sync, including last-writer-wins conflict resolution, tombstones, the synced
PIN-hash, and relay failure handling.

## How it works

```
                 ┌─────────────── orchestrator (this app, Bun/TS) ───────────────┐
                 │  reads scenarios/*.json, launches Go relay(s), diffs state     │
                 └───────────────┬───────────────────────────┬───────────────────┘
                    file mailbox  │                           │  file mailbox
                                  ▼                           ▼
                    sf-e2e-runner (Swift exe)    E2eRunnerHost (Gradle JUnit)
                    real SimplyFinanceCore        real app SyncEngine
                    SyncEngine over GRDB          over JDBC SQLite
                                  │                           │
                                  └──────────► Go relay ◄──────┘
                                        (relays/go)
```

Each platform has one long-lived **runner host** serving many devices. The
orchestrator talks to it over a file mailbox (`cmd-NNN.json` → `res-NNN.json`),
sequences turn-taking, and compares each device's dumped rows.

Runners live in the app repos and are gated so a normal build ignores them:
- iOS: `sf-e2e-runner` executable target in `SimplyFinanceCore` (spawned directly).
- Android: `E2eRunnerHost` JUnit class, gated on `-DsfE2eMailbox`; a plain
  `./gradlew test` skips it via `Assume`.

## Prerequisites

- **Go** on `PATH` (the relay).
- The app repos checked out next to `simplysync` (`../ios-simplyfinance`,
  `../android-simplyfinance`), or `SIMPLYFINANCE_IOS_ROOT` /
  `SIMPLYFINANCE_ANDROID_ROOT` pointing at them.
- iOS pairings need macOS + a Swift toolchain; Android pairings need a JDK 17.

## Running

```sh
# From the simplysync root:
SF_APP_E2E=1 bun run app-e2e -- --matrix android-android            # Linux-friendly
SF_APP_E2E=1 bun run app-e2e                                        # full matrix (needs a Mac)
SF_APP_E2E=1 bun run app-e2e -- --matrix ios-android --scenario basic-convergence
SF_APP_E2E=1 bun run app-e2e -- --matrix ios-android --keep-artifacts   # keep runner logs + DBs
```

- `--matrix` — comma-separated pairings of `ios`/`android` (default: all three).
  Each scenario runs once per pairing; `$P1`/`$P2` in a scenario bind to the pair.
- `--scenario <substr>` — only scenarios whose name contains the substring.
- `--keep-artifacts` — keep the temp work dir (device DBs, relay data, runner logs).

`turbo run test` runs this app's `test` script, which **no-ops unless
`SF_APP_E2E=1`** (it needs Go + the app repos), keeping the default CI test job green.

## Writing scenarios

A scenario is one JSON file in `scenarios/`. Steps are either a `do` (an action
routed to a device's runner) or an `assert` (checked by the orchestrator).

```jsonc
{
  "name": "basic-convergence",
  "devices": { "A": { "platform": "$P1" }, "B": { "platform": "$P2" } },
  "relays": [{ "id": "r1", "env": { "DEFAULT_EVENTS_PER_PULL": "25" } }],
  "steps": [
    { "do": "mutate", "device": "A", "table": "account", "rowId": "acct-1", "values": { "name": "Checking" } },
    { "do": "sync", "device": "A", "relay": "r1", "capture": "aPush" },
    { "do": "sync", "device": "B", "relay": "r1" },
    { "assert": "statesEqual", "devices": ["A", "B"] },
    { "assert": "atLeast", "actual": "$aPush.pushed", "expected": 1 }
  ]
}
```

**`do` verbs:** `init` (implicit, per device), `mutate`, `mutateMany`, `sync`,
`syncExpectError`, `rawPush`, `pruneOutbox`, `purgeRows`, `purgeDeleted`,
`drainPurgeQueue`, `pinMakeHash`, `pinVerify`, `idFromString`, `readRow`.
Add `"capture": "name"` to store a verb's result for later `"$name.field"` refs.

**`assert` types:** `statesEqual` (all synced tables/rows match — cross-platform
comparisons intersect columns, since e.g. iOS `account.excludeFromTotal` has no
Android counterpart), `row`, `noRow`, `outboxCount`, `meta`, `equals`, `atLeast`,
`matches`.

**Relay refs:** `"relay": "r1"` (single) / `"relays": ["r1", "r2"]` resolve to the
launched relay base URLs. Each scenario gets a fresh relay (fresh owner).
