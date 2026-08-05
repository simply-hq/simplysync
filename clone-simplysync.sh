#!/bin/sh

set -eu

DEFAULT_REPOSITORY="https://github.com/simply-hq/simplysync.git"
DEFAULT_REF="main"

usage() {
    cat <<'EOF'
Clone only the SimplySync source needed for one platform.

Usage:
  sh clone-simplysync.sh [options] <preset> [destination]

Presets:
  react-native      Expo TodoList + React Native source dependencies
  web               Browser TodoList + its docs preview and source dependencies
  cli               TodoList CLI + its source dependencies
  node              Node/Raycast adapters + engine and protocol
  swift             SwiftUI TodoList + the SimplySync Swift package
  kotlin            Kotlin/JVM engine + TodoList fixtures and tests
  relay-go          Canonical Go + SQLite ciphertext relay
  relay-cloudflare  Cloudflare Worker + D1 + R2 ciphertext relay
  core              TypeScript protocol and engine only
  all               The complete repository

Options:
  --repo <url-or-path>  Clone a fork or local repository
  --ref <branch-or-tag> Clone a branch or tag (default: main)
  --with-relay          Add the canonical Go relay to a client preset
  --dry-run             Print the exact selection without cloning
  --list                List presets
  --list-apps           List presets with a runnable TodoList app scaffold
  --scaffold-source <preset>
                        Print that preset's canonical TodoList source directory
  -h, --help            Show this help

Examples:
  sh clone-simplysync.sh react-native my-todo
  sh clone-simplysync.sh --with-relay web my-web-todo
  sh clone-simplysync.sh --repo git@github.com:me/simplysync.git swift ios-sync

From an empty directory:
  curl -fsSL https://raw.githubusercontent.com/simply-hq/simplysync/main/clone-simplysync.sh |
    sh -s -- react-native my-todo
EOF
}

list_presets() {
    cat <<'EOF'
react-native	Expo TodoList + React Native source dependencies
web	Browser TodoList + docs preview + source dependencies
cli	TodoList CLI + source dependencies
node	Node/Raycast adapters + engine and protocol
swift	SwiftUI TodoList + SimplySync Swift package
kotlin	Kotlin/JVM engine + TodoList fixtures and tests
relay-go	Canonical Go + SQLite ciphertext relay
relay-cloudflare	Cloudflare Worker + D1 + R2 ciphertext relay
core	TypeScript protocol and engine only
all	Complete repository
EOF
}

list_scaffold_presets() {
    cat <<'EOF'
react-native	Expo / React Native app
web	Browser React app
cli	Bun command-line app
swift	Native SwiftUI app
EOF
}

scaffold_source() {
    case "$1" in
        react-native) printf '%s\n' "apps/todolist/expo" ;;
        web) printf '%s\n' "apps/todolist/web" ;;
        cli) printf '%s\n' "apps/todolist/cli" ;;
        swift) printf '%s\n' "apps/todolist/swift" ;;
        *) return 1 ;;
    esac
}

preset_paths() {
    case "$1" in
        react-native)
            cat <<'EOF'
apps/todolist/expo
packages/simplysync-protocol
packages/simplysync-engine
packages/simplysync-react
packages/simplysync-react-native
EOF
            ;;
        web)
            cat <<'EOF'
apps/docs
apps/todolist/web
docs/local-first
packages/simplysync-protocol
packages/simplysync-engine
packages/simplysync-react
packages/simplysync-browser
EOF
            ;;
        cli)
            cat <<'EOF'
apps/todolist/cli
packages/simplysync-protocol
packages/simplysync-engine
EOF
            ;;
        node)
            cat <<'EOF'
packages/simplysync-protocol
packages/simplysync-engine
packages/simplysync-node
EOF
            ;;
        swift)
            cat <<'EOF'
Sources/SimplySync
apps/todolist/swift
EOF
            ;;
        kotlin)
            cat <<'EOF'
apps/todolist/kotlin
EOF
            ;;
        relay-go)
            cat <<'EOF'
apps/relay-go
EOF
            ;;
        relay-cloudflare)
            cat <<'EOF'
apps/relay-cloudflare
EOF
            ;;
        core)
            cat <<'EOF'
packages/simplysync-protocol
packages/simplysync-engine
EOF
            ;;
        all)
            ;;
        *)
            return 1
            ;;
    esac
}

next_steps() {
    destination=$1
    preset=$2
    with_relay=$3

    printf '\n%s\n' "Next:"
    printf '  cd %s\n' "$destination"
    case "$preset" in
        react-native)
            printf '%s\n' \
                "  bun install --no-save" \
                "  bun run build" \
                "  bun run --cwd apps/todolist/expo ios  # first iOS build; use android for Android" \
                "  bun run todo:expo                     # later starts the installed dev client"
            ;;
        web)
            printf '%s\n' "  bun install --no-save" "  bun run build" "  bun run docs:dev"
            ;;
        cli)
            if [ "$with_relay" = yes ]; then
                printf '%s\n' "  bun install --no-save" "  bun run todo:dev"
            else
                printf '%s\n' "  bun install --no-save" "  bun run build" \
                    "  bun run todo add \"My first todo\" --relay off"
            fi
            ;;
        node)
            printf '%s\n' "  bun install --no-save" "  bun run build" \
                "  bun run --cwd packages/simplysync-node test"
            ;;
        swift)
            printf '%s\n' "  swift test" "  open apps/todolist/swift/SimplySyncDemo.xcodeproj"
            ;;
        kotlin)
            printf '%s\n' "  cd apps/todolist/kotlin" "  ./gradlew test"
            ;;
        relay-go)
            printf '%s\n' "  bun run relay:go"
            ;;
        relay-cloudflare)
            printf '%s\n' "  bun install --no-save" "  bun run relay:cloudflare:setup"
            ;;
        core)
            printf '%s\n' "  bun install --no-save" "  bun run build"
            ;;
        all)
            printf '%s\n' "  bun install --frozen-lockfile" "  bun run test"
            ;;
    esac

    case "$preset:$with_relay" in
        react-native:yes|web:yes|cli:yes|swift:yes|kotlin:yes)
            printf '%s\n' "  # In another terminal:" "  bun run relay:go"
            ;;
    esac

    case "$preset" in
        react-native|web|cli|swift)
            printf '\n%s\n' "Create your own local-first app from this client:"
            printf '  sh scaffold-simplysync.sh %s my-app\n' "$preset"
            ;;
    esac
}

verify_unrelated_sources_absent() {
    destination=$1
    preset=$2
    with_relay=$3

    markers='
react-native|apps/todolist/expo/app/index.tsx
web|apps/todolist/web/main.tsx
cli|apps/todolist/cli/src/cli.ts
node|packages/simplysync-node/src/index.ts
swift|apps/todolist/swift/SimplySyncDemo/SimplySyncDemoApp.swift
kotlin|apps/todolist/kotlin/src/main/kotlin/com/simplysync/kotlin/SyncEngine.kt
relay-go|apps/relay-go/main.go
relay-cloudflare|apps/relay-cloudflare/src/index.ts
'

    old_ifs=$IFS
    IFS='
'
    for entry in $markers; do
        marker_preset=${entry%%|*}
        marker_path=${entry#*|}
        if [ "$marker_preset" = "$preset" ]; then
            continue
        fi
        if [ "$with_relay" = yes ] && [ "$marker_preset" = relay-go ]; then
            continue
        fi
        if [ -e "$destination/$marker_path" ]; then
            printf 'Sparse clone unexpectedly contains %s source: %s\n' \
                "$marker_preset" "$marker_path" >&2
            IFS=$old_ifs
            return 1
        fi
    done
    IFS=$old_ifs
}

repository=$DEFAULT_REPOSITORY
ref=$DEFAULT_REF
with_relay=no
dry_run=no
preset=
destination=

while [ "$#" -gt 0 ]; do
    case "$1" in
        --repo)
            if [ "$#" -lt 2 ]; then
                printf '%s\n' "Missing value after --repo." >&2
                exit 2
            fi
            repository=$2
            shift 2
            ;;
        --ref)
            if [ "$#" -lt 2 ]; then
                printf '%s\n' "Missing value after --ref." >&2
                exit 2
            fi
            ref=$2
            shift 2
            ;;
        --with-relay)
            with_relay=yes
            shift
            ;;
        --dry-run)
            dry_run=yes
            shift
            ;;
        --list)
            list_presets
            exit 0
            ;;
        --list-apps)
            list_scaffold_presets
            exit 0
            ;;
        --scaffold-source)
            if [ "$#" -lt 2 ]; then
                printf '%s\n' "Missing preset after --scaffold-source." >&2
                exit 2
            fi
            if ! scaffold_source "$2"; then
                printf 'Preset %s has no runnable app scaffold.\n\nAvailable app presets:\n' "$2" >&2
                list_scaffold_presets >&2
                exit 2
            fi
            exit 0
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            printf 'Unknown option: %s\n\n' "$1" >&2
            usage >&2
            exit 2
            ;;
        *)
            if [ -z "$preset" ]; then
                preset=$1
            elif [ -z "$destination" ]; then
                destination=$1
            else
                printf 'Unexpected argument: %s\n\n' "$1" >&2
                usage >&2
                exit 2
            fi
            shift
            ;;
    esac
done

if [ -z "$preset" ]; then
    usage >&2
    exit 2
fi

if ! paths=$(preset_paths "$preset"); then
    printf 'Unknown preset: %s\n\nAvailable presets:\n' "$preset" >&2
    list_presets >&2
    exit 2
fi

case "$preset:$with_relay" in
    node:yes|relay-go:yes|relay-cloudflare:yes|core:yes|all:yes)
        printf '%s\n' "--with-relay only applies to client presets." >&2
        exit 2
        ;;
esac

if [ -z "$destination" ]; then
    destination="simplysync-$preset"
fi

if [ "$with_relay" = yes ]; then
    paths="${paths}${paths:+
}apps/relay-go"
fi

if [ "$dry_run" = yes ]; then
    printf '%s\n' "PRESET=$preset" "DESTINATION=$destination" \
        "REPOSITORY=$repository" "REF=$ref" "PATHS:"
    if [ "$preset" = all ]; then
        printf '%s\n' "(complete repository)"
    else
        printf '%s\n' "$paths"
    fi
    exit 0
fi

if ! command -v git >/dev/null 2>&1; then
    printf '%s\n' "Git is required to clone SimplySync." >&2
    exit 1
fi

if [ -e "$destination" ]; then
    printf 'Destination already exists; refusing to overwrite it: %s\n' "$destination" >&2
    exit 1
fi

printf 'Cloning SimplySync preset %s into %s…\n' "$preset" "$destination"

if [ "$preset" = all ]; then
    git clone --no-checkout -- "$repository" "$destination"
    git -C "$destination" checkout --quiet "$ref"
else
    git clone --filter=blob:none --no-checkout -- "$repository" "$destination"
    git -C "$destination" sparse-checkout init --cone

    old_ifs=$IFS
    IFS='
'
    # Every preset path is repository-owned and contains no whitespace.
    # Splitting the newline manifest produces the argument list Git expects.
    set -- $paths
    IFS=$old_ifs

    git -C "$destination" sparse-checkout set "$@"
    git -C "$destination" checkout --quiet "$ref"

    for expected_path in "$@"; do
        if [ ! -e "$destination/$expected_path" ]; then
            printf 'Clone is missing required path: %s\n' "$expected_path" >&2
            exit 1
        fi
    done
    verify_unrelated_sources_absent "$destination" "$preset" "$with_relay"
fi

printf '%s\n' "Clone verified: $destination"
next_steps "$destination" "$preset" "$with_relay"
