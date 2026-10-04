#!/bin/sh
set -eu
mode=install
case "${1:-}" in --print|--check) mode=$1; shift ;; esac
[ "$#" = 1 ] || { printf 'Usage: setup-sandbox [--print|--check] ELECTRON_PATH\n' >&2; exit 2; }
executable=$(readlink -f "$1")
[ -f "$executable" ] || { printf 'Electron executable not found.\n' >&2; exit 1; }
case "$executable" in
  *[!a-zA-Z0-9/._-]*) printf 'Sandbox setup requires an executable path containing only letters, digits, /, ., _, and -.\n' >&2; exit 1 ;;
esac
scope=$executable
profile_name=voice-call-electron
case "$executable" in
  */versions/*/runtime/electron/electron)
    install_dir=${executable%/versions/*/runtime/electron/electron}
    version=${executable#"$install_dir/versions/"}
    version=${version%/runtime/electron/electron}
    case "$version" in ''|*/*) printf 'Invalid versioned installation path.\n' >&2; exit 1 ;; esac
    scope="$install_dir/versions/*/runtime/electron/electron"
    identity=$(printf '%s' "$install_dir" | sha256sum | cut -c 1-16)
    profile_name=voice-call-installed-$identity
    ;;
esac
configuration=/etc/apparmor.d/$profile_name
render_profile() {
  cat <<PROFILE
abi <abi/4.0>,
include <tunables/global>

# Anyone able to create or replace a matching executable inherits this permission.
profile $profile_name "$scope" flags=(unconfined) {
  userns,
}
PROFILE
}
if [ "$mode" = --print ]; then render_profile; exit 0; fi
if [ "$mode" = --check ]; then
  # Configuration persists across reboots; doctor checks the running sandbox separately.
  render_profile | cmp -s "$configuration" -
  exit $?
fi
if [ ! -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  printf 'This machine does not expose Ubuntu user-namespace restrictions. No profile installed.\n'
  exit 0
fi
command -v apparmor_parser >/dev/null || { printf 'Install the apparmor package first.\n' >&2; exit 1; }
profile=$(mktemp)
trap 'rm -f "$profile"' EXIT HUP INT TERM
chmod 600 "$profile"
render_profile > "$profile"
printf 'Allowing Chromium user namespaces only for:\n%s\n' "$scope"
printf 'Any process able to create or replace a matching executable inherits the exception.\n'
sudo install -o root -g root -m 0644 "$profile" "$configuration"
sudo apparmor_parser -r "$configuration"
if [ "$scope" = "$executable" ]; then
  printf 'Development sandbox profile loaded. Repeat setup only if the executable path changes.\n'
else
  printf 'Sandbox profile loaded for this install directory, including future builds and versions.\n'
fi
printf 'Run voice-call doctor.\n'
