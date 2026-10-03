#!/bin/sh
set -eu
url=
output=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    https://github.com/daure/voice-call/releases/download/*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ -n "$url" ] && [ -n "$output" ]
case "${url##*/}" in
  voice-call-x86_64-unknown-linux-gnu.tar.xz|SHA256SUMS) cp "$RELEASE_ASSETS/${url##*/}" "$output" ;;
  *) exit 1 ;;
esac
