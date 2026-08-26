#!/bin/sh

set -eu

preset=${1:-react-native}
source_root=$(git rev-parse --show-toplevel)
source_revision=$(git -C "$source_root" rev-parse HEAD)
check_root=$(mktemp -d "${TMPDIR:-/tmp}/simplysync-scaffold-check.XXXXXX")

cleanup() {
    rm -rf -- "$check_root"
}
trap cleanup EXIT HUP INT TERM

clone_dir="$check_root/source"
app_slug="cold-start-$preset"
app_dir="apps/$app_slug"

case "$preset" in
    cli|web) relay_option=--with-relay ;;
    react-native|swift) relay_option= ;;
    *)
        printf 'No cold-start scaffold check for preset: %s\n' "$preset" >&2
        exit 2
        ;;
esac

sh "$source_root/clone-simplysync.sh" \
    --repo "file://$source_root" \
    --ref "$source_revision" \
    ${relay_option:+"$relay_option"} \
    "$preset" \
    "$clone_dir"

(
    cd "$clone_dir"
    sh scaffold-simplysync.sh "$preset" "$app_slug"

    case "$preset" in
        react-native)
            bun install --no-save
            bun run build
            bun run --cwd "$app_dir" typecheck
            (
                cd "$app_dir"
                bunx expo prebuild --platform ios --no-install
            )
            grep -F "SimplySync: keep every generated Pod target" "$app_dir/ios/Podfile" >/dev/null
            grep -F "I saved this key" "$app_dir/components/todo-screen.tsx" >/dev/null
            grep -F "ALREADY HAVE A KEY?" "$app_dir/components/todo-screen.tsx" >/dev/null
            grep -F "ADD A DEVICE" "$app_dir/components/todo-screen.tsx" >/dev/null
            grep -F "no one can recover your synced data" "$app_dir/components/todo-screen.tsx" >/dev/null
            ;;
        web)
            bun install --no-save
            bun run build
            bun run --cwd "$app_dir" typecheck
            test -f "$app_dir/dist/index.html"
            test -f "$app_dir/dist/app.js"
            test -f "$app_dir/dist/sql-wasm.wasm"
            test -f "$app_dir/dist/tokens.css"
            grep -F "I saved this key" "$app_dir/main.tsx" >/dev/null
            grep -F "Already have a recovery key?" "$app_dir/main.tsx" >/dev/null
            grep -F "Add another device" "$app_dir/main.tsx" >/dev/null
            grep -F "no one can recover your synced data" "$app_dir/main.tsx" >/dev/null
            ;;
        cli)
            bun install --no-save
            bun run build
            bun run --cwd "$app_dir" typecheck
            onboarding=$(bun run --cwd "$app_dir" start -- add "Cold start" --relay off)
            printf '%s\n' "$onboarding"
            printf '%s\n' "$onboarding" | grep -F "FIRST-RUN RECOVERY SETUP" >/dev/null
            printf '%s\n' "$onboarding" | grep -F "setup --device cli --confirm" >/dev/null
            printf '%s\n' "$onboarding" | grep -F "no one can recover your synced data" >/dev/null
            bun run --cwd "$app_dir" start -- setup --device cli --confirm
            add_device=$(bun run --cwd "$app_dir" start -- add-device --device cli)
            printf '%s\n' "$add_device"
            printf '%s\n' "$add_device" | grep -F "restore --device <new-device> --key" >/dev/null
            output=$(bun run --cwd "$app_dir" start -- list --relay off)
            printf '%s\n' "$output"
            printf '%s\n' "$output" | grep -F "Cold start" >/dev/null
            bun run --cwd "$app_dir" dev -- --once
            ;;
        swift)
            type_name=ColdStartSwift
            swift test
            grep -F "I saved this key" "$app_dir/$type_name/Views.swift" >/dev/null
            grep -F "Restore another owner" "$app_dir/$type_name/Views.swift" >/dev/null
            grep -F "Add a device" "$app_dir/$type_name/Views.swift" >/dev/null
            grep -F "no one can recover your synced data" "$app_dir/$type_name/Views.swift" >/dev/null
            xcodebuild \
                -project "$app_dir/$type_name.xcodeproj" \
                -scheme "$type_name" \
                -sdk iphonesimulator \
                -configuration Debug \
                CODE_SIGNING_ALLOWED=NO \
                build
            ;;
    esac

    tracked_changes=$(git status --short --untracked-files=no)
    if [ -n "$tracked_changes" ]; then
        printf '%s\n' "Scaffold verification changed tracked clone files:" >&2
        printf '%s\n' "$tracked_changes" >&2
        exit 1
    fi
)

printf '%s scaffold cold start passed.\n' "$preset"
