#!/usr/bin/env sh
# install.sh — install this plugin into a DSH profile (macOS / Linux).
#
#   ./install.sh                      # link THIS checkout (default)
#   ./install.sh --from npm           # install the published package instead
#   ./install.sh --from npm --ref next  # …a dist-tag, or an exact version
#   DSH_PROFILE=desktop ./install.sh  # explicit profile name
#   DSH_HOME=/path/to/.dsh ./install.sh
#
# Either source does the two steps the profile itself needs: add the plugin to the
# profile (pnpm add), then list it in dsh.profile.bundles — that array IS the enable
# switch; a name missing from it is a disabled plugin. The third step, fully
# restarting the app, is yours.
set -eu

package_name='dsh-prefill-speed-stats'
from='local'
ref=''

while [ $# -gt 0 ]; do
    case "$1" in
        --from) [ $# -ge 2 ] || { echo "--from needs a value: local or npm" >&2; exit 1; }; from="$2"; shift 2 ;;
        --ref)  [ $# -ge 2 ] || { echo "--ref needs a version or dist-tag" >&2; exit 1; }; ref="$2"; shift 2 ;;
        *) echo "unknown argument: $1 (use --from local|npm, --ref <version|tag>)" >&2; exit 1 ;;
    esac
done
case "$from" in
    local|npm) ;;
    *) echo "--from must be 'local' or 'npm'" >&2; exit 1 ;;
esac

package_dir="$(cd "$(dirname "$0")" && pwd)"
home="${DSH_HOME:-$HOME/.dsh}"
profiles_dir="$home/profiles"
profile="${DSH_PROFILE:-}"

if [ -z "$profile" ]; then
    count=$(find "$profiles_dir" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
    if [ "$count" != "1" ]; then
        echo "cannot pick a profile: $profiles_dir holds $count; set DSH_PROFILE=<name>" >&2
        exit 1
    fi
    profile=$(basename "$(find "$profiles_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)")
fi

profile_dir="$profiles_dir/$profile"
manifest="$profile_dir/package.json"
[ -f "$manifest" ] || { echo "no such profile: $profile_dir" >&2; exit 1; }

# What to add: this checkout, or the published package (optionally pinned to a tag or version).
if [ "$from" = 'npm' ]; then
    if [ -n "$ref" ]; then spec="$package_name@$ref"; else spec="$package_name"; fi
else
    spec="link:$package_dir"
fi

runtime="$home/dsh-runtimes/dsh-primary-runtime/dependencies"
node_bin="$runtime/node/bin/node"
pnpm_js="$runtime/pnpm/bin/pnpm.cjs"

# 1) Add it to the profile, preferring the node + pnpm DSH ships with.
cd "$profile_dir"
if [ -x "$node_bin" ] && [ -f "$pnpm_js" ]; then
    add() { "$node_bin" "$pnpm_js" add "$1"; }
else
    add() { pnpm add "$1"; }
fi
if ! add "$spec"; then
    if [ "$from" = 'npm' ] && [ -z "$ref" ]; then
        echo "pnpm add $spec failed. If only a prerelease is published, pin it: --ref <version|tag>" >&2
    fi
    exit 1
fi

# 2) Enable the bundle by listing it in dsh.profile.bundles.
cp "$manifest" "$manifest.bak-$(date +%Y%m%d%H%M%S)"
[ -x "$node_bin" ] || node_bin="$(command -v node || true)"
if [ -z "$node_bin" ]; then
    echo "no node found to edit $manifest — add \"$package_name\" to dsh.profile.bundles by hand" >&2
    exit 1
fi
"$node_bin" -e '
const fs = require("fs");
const [file, name] = process.argv.slice(1);
const json = JSON.parse(fs.readFileSync(file, "utf8"));
json.dsh = json.dsh || {};
json.dsh.profile = json.dsh.profile || {};
json.dsh.profile.bundles = json.dsh.profile.bundles || [];
if (json.dsh.profile.bundles.includes(name)) {
  console.log("already enabled: " + name);
} else {
  json.dsh.profile.bundles.push(name);
  fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
  console.log("enabled: " + name);
}
' "$manifest" "$package_name"

echo
echo "Installed $spec into profile \"$profile\". Last step: fully restart the app."
echo "A page refresh is not enough: the browser bundle is snapshotted at boot."
