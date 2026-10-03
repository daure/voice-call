#!/bin/sh
set -eu
executable=$(readlink -f "$1")
if [ ! -f /proc/sys/kernel/apparmor_restrict_unprivileged_userns ]; then
  printf 'This machine does not expose Ubuntu user-namespace restrictions. No profile installed.\n'
  exit 0
fi
case "$executable" in
  *[!a-zA-Z0-9/._-]*) printf 'Sandbox setup requires an executable path containing only letters, digits, /, ., _, and -.\n' >&2; exit 1 ;;
esac
command -v apparmor_parser >/dev/null || { printf 'Install the apparmor package first.\n' >&2; exit 1; }
profile=$(mktemp)
trap 'rm -f "$profile"' EXIT HUP INT TERM
chmod 600 "$profile"
cat > "$profile" <<PROFILE
abi <abi/4.0>,
include <tunables/global>

# Replacing this user-owned executable inherits its user-namespace permission.
profile voice-call-installed "$executable" flags=(unconfined) {
  userns,
}
PROFILE
printf 'Allowing Chromium user namespaces only for:\n%s\n' "$executable"
printf 'Any process able to replace this executable inherits the exception.\n'
sudo install -o root -g root -m 0644 "$profile" /etc/apparmor.d/voice-call-installed
sudo apparmor_parser -r /etc/apparmor.d/voice-call-installed
printf 'Sandbox profile loaded. Run voice-call doctor. Repeat setup after changing versions.\n'
