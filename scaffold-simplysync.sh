#!/bin/sh

set -eu

usage() {
    cat <<'EOF'
Create an app from the TodoList client already present in this clone.

Usage:
  sh scaffold-simplysync.sh <preset> <app-slug>
  sh scaffold-simplysync.sh --list

The generated app lives at apps/<app-slug>, uses this checkout's SimplySync
source, and starts local-only. The command refuses to overwrite any path.

Examples:
  sh scaffold-simplysync.sh react-native my-notes
  sh scaffold-simplysync.sh web reading-log
  sh scaffold-simplysync.sh cli habits
  sh scaffold-simplysync.sh swift private-finance
EOF
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
clone_script="$script_dir/clone-simplysync.sh"

if [ ! -f "$clone_script" ]; then
    printf '%s\n' "Run this command from a SimplySync source clone." >&2
    exit 1
fi

case "${1:-}" in
    --list)
        sh "$clone_script" --list-apps
        exit 0
        ;;
    -h|--help)
        usage
        exit 0
        ;;
esac

if [ "$#" -ne 2 ]; then
    usage >&2
    exit 2
fi

preset=$1
slug=$2

case "$slug" in
    ''|[!a-z]*|*[!a-z0-9-]*)
        printf '%s\n' "App slug must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens." >&2
        exit 2
        ;;
    *) ;;
esac

case "$slug" in
    *--*|*-)
        printf '%s\n' "App slug cannot contain consecutive or trailing hyphens." >&2
        exit 2
        ;;
esac

repo_root_raw=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)
repo_root=
if [ -n "$repo_root_raw" ]; then
    repo_root=$(CDPATH= cd -- "$repo_root_raw" && pwd -P)
fi
if [ -z "$repo_root" ] || [ "$repo_root" != "$script_dir" ]; then
    printf '%s\n' "scaffold-simplysync.sh must be at the root of a SimplySync Git checkout." >&2
    exit 1
fi

if ! source_path=$(sh "$clone_script" --scaffold-source "$preset"); then
    exit 2
fi
if [ ! -d "$repo_root/$source_path" ]; then
    printf 'This clone does not contain the %s app source (%s).\n' "$preset" "$source_path" >&2
    printf 'Clone the %s preset first.\n' "$preset" >&2
    exit 1
fi

destination_rel="apps/$slug"
destination="$repo_root/$destination_rel"
if [ -e "$destination" ]; then
    printf 'Destination already exists; refusing to overwrite it: %s\n' "$destination_rel" >&2
    exit 1
fi

display_name=$(printf '%s\n' "$slug" | awk -F- '{
    for (i = 1; i <= NF; i += 1) {
        word = toupper(substr($i, 1, 1)) substr($i, 2)
        printf "%s%s", (i == 1 ? "" : " "), word
    }
    printf "\n"
}')
type_name=$(printf '%s' "$display_name" | tr -d ' ')
compact_slug=$(printf '%s' "$slug" | tr -d '-')

should_copy() {
    file=$1
    case "$preset:$file" in
        react-native:$source_path/ios/*) return 1 ;;
        swift:$source_path/Tests/*|swift:$source_path/verify/*) return 1 ;;
    esac
    return 0
}

mkdir -p "$destination"
git -C "$repo_root" ls-files -- "$source_path" |
while IFS= read -r file; do
    if ! should_copy "$file"; then continue; fi
    relative=${file#"$source_path"/}
    target="$destination/$relative"
    mkdir -p "$(dirname -- "$target")"
    cp -p "$repo_root/$file" "$target"
done

if [ ! -f "$destination/README.md" ]; then
    printf 'Scaffold source did not copy correctly from %s.\n' "$source_path" >&2
    exit 1
fi

# Fixed-string replacement without GNU/BSD sed differences. Inputs are all
# validated identifiers or repository-owned literals.
replace_text() {
    old=$1
    new=$2
    file=$3
    if [ ! -f "$file" ]; then return; fi
    temporary="$file.simplysync-new"
    awk -v old="$old" -v new="$new" '
        {
            rest = $0
            output = ""
            while ((position = index(rest, old)) > 0) {
                output = output substr(rest, 1, position - 1) new
                rest = substr(rest, position + length(old))
            }
            print output rest
        }
    ' "$file" > "$temporary"
    mv "$temporary" "$file"
}

case "$preset" in
    react-native)
        replace_text '@simplysync/todolist-expo' "@app/$slug" "$destination/package.json"
        replace_text 'SimplySync Todos' "$display_name" "$destination/app.json"
        replace_text 'simplysync-todos' "$slug" "$destination/app.json"
        replace_text 'simplysynctodos' "$compact_slug" "$destination/app.json"
        replace_text 'dev.simplysync.todos' "app.simplysync.$compact_slug" "$destination/app.json"
        replace_text 'SimplySync Todos' "$display_name" "$destination/app.json"
        replace_text 'simplysync-todos' "$slug" "$destination/lib/todo-engine.ts"
        replace_text 'projectRoot, "../../.."' 'projectRoot, "../.."' "$destination/metro.config.js"
        start_command="bun run --cwd $destination_rel ios  # or: bun run --cwd $destination_rel android"
        verify_command="bun run --cwd $destination_rel typecheck"
        sync_hint="Set EXPO_PUBLIC_SIMPLYSYNC_RELAY_URL, or paste a relay URL in the app settings."
        ;;
    web)
        replace_text '@simplysync/todolist-web' "@app/$slug" "$destination/package.json"
        replace_text 'simplysync-todolist-web' "$slug" "$destination/schema.ts"
        replace_text 'simplysync-todolist' "$slug" "$destination/relay.ts"
        replace_text '../../docs/tokens.css' '../docs/tokens.css' "$destination/build.ts"
        start_command="bun run --cwd $destination_rel dev"
        verify_command="bun run --cwd $destination_rel typecheck && bun run --cwd $destination_rel build"
        sync_hint="Paste a relay URL into the app and choose Connect."
        ;;
    cli)
        replace_text '@simplysync/todolist-cli' "@app/$slug" "$destination/package.json"
        replace_text 'resolve(cliRoot, "../../..")' 'resolve(cliRoot, "../..")' "$destination/src/support.ts"
        start_command="bun run --cwd $destination_rel start -- add \"My first item\""
        verify_command="bun run --cwd $destination_rel typecheck"
        sync_hint="Add --relay http://localhost:4100 to a command when you are ready to sync."
        ;;
    swift)
        old_app_dir="$destination/SimplySyncDemo"
        old_project="$destination/SimplySyncDemo.xcodeproj"
        new_app_dir="$destination/$type_name"
        new_project="$destination/$type_name.xcodeproj"
        mv "$old_app_dir" "$new_app_dir"
        mv "$old_project" "$new_project"
        if [ -f "$new_app_dir/SimplySyncDemoApp.swift" ]; then
            mv "$new_app_dir/SimplySyncDemoApp.swift" "$new_app_dir/${type_name}App.swift"
        fi
        replace_text 'SimplySyncDemo' "$type_name" "$new_project/project.pbxproj"
        replace_text '../../../Sources/SimplySync' '../../Sources/SimplySync' "$new_project/project.pbxproj"
        replace_text 'dev.simplysync.engineios' "app.simplysync.$compact_slug" "$new_project/project.pbxproj"
        replace_text 'SimplySyncDemo' "$type_name" "$new_app_dir/${type_name}App.swift"
        replace_text 'static let engineName = "simplysync"' "static let engineName = \"$slug\"" "$new_app_dir/AppModel.swift"
        replace_text 'apps/todolist/swift' "$destination_rel" "$destination/README.md"
        start_command="open $destination_rel/$type_name.xcodeproj"
        verify_command="xcodebuild -project $destination_rel/$type_name.xcodeproj -scheme $type_name -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build"
        sync_hint="Paste a relay URL into the app's relay field when you are ready to sync."
        ;;
esac

printf 'Created %s app at %s from %s.\n' "$preset" "$destination_rel" "$source_path"
printf '%s\n' "" "Local-first start:" "  $start_command"
printf '%s\n' "" "Verify:" "  $verify_command"
printf '%s\n' "" "Add sync later:" "  $sync_hint"
