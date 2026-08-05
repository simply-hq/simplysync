---
name: clone-simplysync
description: Create and verify a dependency-closed SimplySync clone containing only one requested client, relay, or the TypeScript core, and optionally scaffold a personal app from its canonical TodoList client. Use when a user asks to clone, extract, download, scaffold, or start from only the React Native/Expo, web, CLI, Node/Raycast, Swift/SwiftUI, Kotlin/Android, Go relay, Cloudflare relay, or core SimplySync source instead of the full monorepo.
---

# Clone SimplySync

Give the user one normal Git checkout containing the platform they asked for,
its source dependencies, and no unrelated client source. Use the repository's
`clone-simplysync.sh`; do not recreate its path lists or copy files by hand.

## Choose the preset

Map the user's words to one preset:

| User intent | Preset |
| --- | --- |
| React Native, Expo, JavaScript mobile | `react-native` |
| Browser, web React | `web` |
| Bun terminal app, command line | `cli` |
| Node.js or Raycast adapters | `node` |
| Native iOS, Swift, SwiftUI | `swift` |
| Native Android, Kotlin, JVM | `kotlin` |
| Go relay, local relay server | `relay-go` |
| Cloudflare Worker relay, D1/R2 | `relay-cloudflare` |
| Protocol and engine without an example | `core` |
| Every port or the complete monorepo | `all` |

Treat “iOS” as `react-native` when Expo or React Native is present, and as
`swift` when native or SwiftUI is present. Ask only when those signals genuinely
conflict.

Add `--with-relay` only when the user also asks for a self-contained synced
demo, two-device run, or local relay. If the user says “only,” keep the exact
client preset.

## Run the clone

1. Find `clone-simplysync.sh` in the current SimplySync repository. If the
   current directory is not the repository, resolve this skill's real directory
   and walk three parents up.
2. Run `sh <script> --dry-run <preset> <destination>` and inspect the selection.
3. If the destination already exists, do not overwrite or empty it. Choose a
   clearly new sibling name when the user's intended location is obvious;
   otherwise ask for a destination.
4. Run:

   ```sh
   sh <script> [--repo <fork-or-local-path>] [--ref <branch-or-tag>] \
     [--with-relay] <preset> <destination>
   ```

Use the current repository's `origin` only when the user is working from a fork
or explicitly wants local repository history. Otherwise let the script use the
official repository. Never claim uncommitted work was cloned; Git clones commits.

## Verify before handoff

The script verifies required paths and rejects leaked source from unrelated
clients. If working on the SimplySync repository itself, run
`bun run clone:check <preset>` to perform the matching cold-clone check. The
underlying checks are:

| Preset | Verification |
| --- | --- |
| `react-native` | `bun install --no-save && bun run build && bun run --cwd apps/todolist/expo typecheck` |
| `web` | `bun install --no-save && bun run build && bun run --cwd apps/todolist/web typecheck` |
| `cli` | `bun install --no-save && bun run build && bun run --cwd apps/todolist/cli typecheck` |
| `node` | `bun install --no-save && bun run build && bun run --cwd packages/simplysync-node test` |
| `swift` | `swift test` |
| `kotlin` | `cd apps/todolist/kotlin && ./gradlew test` |
| `relay-go` | `cd apps/relay-go && go test ./... && go build ./...` |
| `relay-cloudflare` | `bun install --no-save && bun run --cwd apps/relay-cloudflare typecheck && bun run --cwd apps/relay-cloudflare test` |
| `core` | `bun install --no-save && bun run build` |
| `all` | `bun install --frozen-lockfile && bun run typecheck` |

For selective Bun clones, use `--no-save`: the checked-in lock covers the full
monorepo, while the sparse checkout intentionally omits other workspaces.
Confirm `git status --short` is still clean after verification.

Report the destination, chosen preset, whether the Go relay was included, the
verification result, and the next command printed by the clone script.

## Scaffold an app when requested

Keep an “example only” request as the exact selective clone above. If the user
asks for their own starter app or names an app they want to build, run the
repo-owned scaffold after cloning:

```sh
cd <clone-destination>
sh scaffold-simplysync.sh <preset> <app-slug>
```

Derive a short lowercase hyphenated slug from a clear app name; ask only when
the name is genuinely missing or ambiguous. The scaffold refuses overwrites,
copies tracked files from the selected TodoList client, uses the SimplySync
source already in the clone, and starts with no relay configured.

Runnable scaffolds currently exist for `react-native`, `web`, `cli`, and
`swift`. Do not improvise an insecure credential store for the adapter-only
`node` preset or source-module `kotlin` preset. For those requests, hand off the
verified source clone and its printed next command.

After scaffolding, run the exact verification command it prints. Report the app
path, local-first start command, and the printed one-step route for adding sync.
