#!/bin/sh
set -eu

self=$(readlink -f "$0")
root=$(CDPATH= cd -- "$(dirname -- "$self")/.." && pwd -P)
export VOICE_CALL_ELECTRON_PATH="$root/runtime/electron/electron"
unset ELECTRON_RUN_AS_NODE

case "${1:-desktop}" in
  --version|version)
    printf 'voice-call %s\n' "$(cat "$root/VERSION")"
    ;;
  --help|-h|help)
    cat <<'HELP'
Usage: voice-call [desktop|mcp|doctor|setup-sandbox|--version|--help]

  desktop        Open the idle desktop window (default).
  mcp            Run the stdio MCP server; it opens its own window on calls.
  doctor         Check desktop libraries, environment, and Electron sandbox.
  setup-sandbox  Install a scoped Ubuntu AppArmor exception using sudo.

Set OPENAI_API_KEY in the MCP client's launch environment. It is never stored.
Reconnect the MCP server after updates. Voice calls use paid OpenAI API credits.
HELP
    ;;
  mcp)
    shift
    exec "$root/runtime/node/bin/node" "$root/app/mcp.mjs" "$@"
    ;;
  desktop)
    if [ "$#" -gt 0 ]; then shift; fi
    exec "$VOICE_CALL_ELECTRON_PATH" "$root/app/desktop/main.mjs" "$@"
    ;;
  doctor)
    missing=$(ldd "$VOICE_CALL_ELECTRON_PATH" | grep 'not found' || true)
    if [ -n "$missing" ]; then printf '%s\n' "$missing" >&2; exit 1; fi
    if [ -z "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
      printf 'No Linux desktop session. Start MCP from your desktop environment.\n' >&2
      exit 1
    fi
    if [ -n "${OPENAI_API_KEY:-}" ]; then printf 'OpenAI key: set\n'; else printf 'OpenAI key: unset (required for voice calls)\n'; fi
    if ! "$VOICE_CALL_ELECTRON_PATH" --version; then
      printf 'Electron sandbox failed. On Ubuntu, run: voice-call setup-sandbox\n' >&2
      exit 1
    fi
    printf 'Desktop runtime checks passed. Microphone and provider access require a live call.\n'
    ;;
  setup-sandbox)
    exec "$root/bin/setup-sandbox" "$VOICE_CALL_ELECTRON_PATH"
    ;;
  *)
    printf 'Unknown command: %s. Run voice-call --help.\n' "$1" >&2
    exit 2
    ;;
esac
