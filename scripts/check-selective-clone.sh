#!/bin/sh

set -eu

preset=${1:-react-native}
SOURCE_ROOT=$(git rev-parse --show-toplevel)
SOURCE_REVISION=$(git -C "$SOURCE_ROOT" rev-parse HEAD)
CHECK_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/simplysync-clone-check.XXXXXX")

case "$CHECK_ROOT" in
    */simplysync-clone-check.*) ;;
    *)
        printf 'Unexpected temporary path: %s\n' "$CHECK_ROOT" >&2
        exit 1
        ;;
esac

cleanup() {
    rm -rf -- "$CHECK_ROOT"
}
trap cleanup EXIT HUP INT TERM

CLONE_DIR="$CHECK_ROOT/$preset"

sh "$SOURCE_ROOT/clone-simplysync.sh" \
    --repo "file://$SOURCE_ROOT" \
    --ref "$SOURCE_REVISION" \
    "$preset" \
    "$CLONE_DIR"

case "$preset" in
    react-native)
        (
            cd "$CLONE_DIR"
            bun install --no-save
            bun run build
            bun run --cwd apps/todolist/expo typecheck
        )
        ;;
    web)
        (
            cd "$CLONE_DIR"
            bun install --no-save
            bun run build
            bun run --cwd apps/todolist/web typecheck
        )
        ;;
    cli)
        (
            cd "$CLONE_DIR"
            bun install --no-save
            bun run build
            bun run --cwd apps/todolist/cli typecheck
        )
        ;;
    node)
        (
            cd "$CLONE_DIR"
            bun install --no-save
            bun run build
            bun run --cwd packages/simplysync-node test
        )
        ;;
    swift)
        (cd "$CLONE_DIR" && swift test)
        ;;
    kotlin)
        (cd "$CLONE_DIR/apps/todolist/kotlin" && ./gradlew test)
        ;;
    relay-go)
        (
            cd "$CLONE_DIR/apps/relay-go"
            go test -race ./...
            go vet ./...
            go build ./...
        )
        ;;
    relay-cloudflare)
        (
            cd "$CLONE_DIR"
            bun install --no-save
            bun run --cwd apps/relay-cloudflare typecheck
            bun run --cwd apps/relay-cloudflare test
        )
        ;;
    core)
        (
            cd "$CLONE_DIR"
            bun install --no-save
            bun run build
        )
        ;;
    all)
        (
            cd "$CLONE_DIR"
            bun install --frozen-lockfile
            bun run typecheck
        )
        ;;
    *)
        printf 'Unsupported verification preset: %s\n' "$preset" >&2
        exit 2
        ;;
esac

if [ -n "$(git -C "$CLONE_DIR" status --short)" ]; then
    printf '%s\n' "Selective clone verification left tracked changes:" >&2
    git -C "$CLONE_DIR" status --short >&2
    exit 1
fi

printf '%s\n' "$preset selective clone passed."
