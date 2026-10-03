#!/bin/sh
set -eu
umask 022

fail() { printf 'voice-call installer: %s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Linux ] || fail 'Only Linux is supported.'
[ "$(uname -m)" = x86_64 ] || fail 'This release requires x86_64 (amd64).'
for tool in curl tar xz sha256sum mktemp readlink; do command -v "$tool" >/dev/null || fail "Required command not found: $tool"; done

version=${VOICE_CALL_VERSION:-@VERSION@}
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail 'Expected a stable version such as 1.0.0.'
install_dir=${VOICE_CALL_INSTALL_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/voice-call}
bin_dir=${VOICE_CALL_BIN_DIR:-$HOME/.local/bin}
case "$install_dir:$bin_dir" in /*:/*) ;; *) fail 'Install and binary directories must be absolute.' ;; esac
mkdir -p "$install_dir/versions" "$bin_dir"
install_dir=$(CDPATH= cd -- "$install_dir" && pwd -P)
bin_dir=$(CDPATH= cd -- "$bin_dir" && pwd -P)
if [ -e "$bin_dir/voice-call" ] || [ -L "$bin_dir/voice-call" ]; then
  [ -L "$bin_dir/voice-call" ] && [ "$(readlink "$bin_dir/voice-call")" = "$install_dir/current/bin/voice-call" ] || fail 'An unrelated voice-call executable already exists in the destination.'
fi
if [ -e "$install_dir/current" ] && [ ! -L "$install_dir/current" ]; then fail 'The current installation path is not a symlink.'; fi

stage=$(mktemp -d "$install_dir/.staging.XXXXXX")
cleanup() { rm -rf "$stage"; rm -f "$install_dir/.current.$$" "$bin_dir/.voice-call.$$"; }
trap cleanup EXIT HUP INT TERM
name=voice-call-x86_64-unknown-linux-gnu
archive=$name.tar.xz
base=https://github.com/daure/voice-call/releases/download/v$version
curl --proto '=https' --tlsv1.2 -fLsS --retry 3 "$base/$archive" -o "$stage/$archive"
curl --proto '=https' --tlsv1.2 -fLsS --retry 3 "$base/SHA256SUMS" -o "$stage/SHA256SUMS"
expected=$(awk -v name="$archive" '$2 == name {print $1}' "$stage/SHA256SUMS")
printf '%s\n' "$expected" | grep -Eq '^[a-f0-9]{64}$' || fail 'Missing or invalid archive checksum.'
actual=$(sha256sum "$stage/$archive" | cut -d ' ' -f 1)
[ "$actual" = "$expected" ] || fail 'Archive checksum verification failed.'
tar -tJf "$stage/$archive" > "$stage/entries"
while IFS= read -r entry; do
  case "$entry" in "$name/"*) ;; *) fail 'Archive contains an unexpected top-level path.' ;; esac
  case "/$entry/" in */../*|*/./*) fail 'Archive contains an unsafe path.' ;; esac
done < "$stage/entries"
tar -xJf "$stage/$archive" -C "$stage" --no-same-owner --no-same-permissions
installed_version=$("$stage/$name/bin/voice-call" --version)
[ "$installed_version" = "voice-call $version" ] || fail 'Archive version does not match the requested release.'
printf '%s\n' "$installed_version"
printf '%s\n' "$actual" > "$stage/$name/ARCHIVE_SHA256"
destination=$install_dir/versions/$version
if [ -e "$destination" ]; then
  [ -f "$destination/ARCHIVE_SHA256" ] && [ "$(cat "$destination/ARCHIVE_SHA256")" = "$actual" ] || fail 'This version is installed with different contents; refusing to overwrite it.'
else
  mv -T "$stage/$name" "$destination"
fi
ln -s "$destination" "$install_dir/.current.$$"
mv -Tf "$install_dir/.current.$$" "$install_dir/current"
ln -s "$install_dir/current/bin/voice-call" "$bin_dir/.voice-call.$$"
mv -Tf "$bin_dir/.voice-call.$$" "$bin_dir/voice-call"
printf 'Installed voice-call %s in %s\n' "$version" "$destination"
printf 'Add %s to PATH, then run: voice-call doctor\n' "$bin_dir"
printf 'Reconnect your MCP client after updates. Existing calls and credentials are untouched.\n'
if [ -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns)" = 1 ]; then
  printf 'Ubuntu sandbox setup may be required: voice-call setup-sandbox (uses sudo).\n'
fi
