#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
cd "$root"
node --input-type=module -e 'import { prepareDevelopment } from "./scripts/dev.mjs"; await prepareDevelopment();'
npm run build:release
unset VOICE_CALL_VERSION
VOICE_CALL_LOCAL_ASSETS="$root/dist" sh "$root/dist/voice-call-installer.sh"
