#!/usr/bin/env bash

# Builds the macOS speech helper. The app ships it as an extra resource and spawns it for
# dictation; on other platforms the dock falls back to the browser Web Speech API.
#
# One helper per architecture the Mac app packages, in `out/speech/<arch>/`: each installer takes
# its own, so the x64 app does not ship the build machine's arm64 helper (HE-05). The deployment
# target is the compiler's default, as it was before the helper was built per architecture.
set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "speech helper: skipped (not macOS)"
  exit 0
fi

cd "$(dirname "$0")/.."
macos=$(swiftc -print-target-info | sed -n 's/.*"triple": "[^"]*-apple-macosx\([0-9.]*\)".*/\1/p' | head -1)

for arch in $(node scripts/archs.mjs); do
  case "$arch" in
    x64) cpu=x86_64 ;;
    arm64) cpu=arm64 ;;
    *) echo "speech helper: no Swift target for $arch" >&2; exit 1 ;;
  esac
  mkdir -p "out/speech/$arch"
  swiftc -O native/speech-helper.swift \
    -target "$cpu-apple-macosx$macos" \
    -framework AVFoundation \
    -framework Speech \
    -Xlinker -sectcreate \
    -Xlinker __TEXT \
    -Xlinker __info_plist \
    -Xlinker native/Info.plist \
    -o "out/speech/$arch/speech-helper"
  echo "speech helper: out/speech/$arch/speech-helper"
done
