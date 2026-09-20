#!/usr/bin/env bash

# Builds the macOS speech helper. The app ships it as an extra resource and spawns it for
# dictation; on other platforms the dock falls back to the browser Web Speech API.
set -euo pipefail

if [ "$(uname)" != "Darwin" ]; then
  echo "speech helper: skipped (not macOS)"
  exit 0
fi

cd "$(dirname "$0")/.."
mkdir -p out/speech

swiftc -O native/speech-helper.swift \
  -framework AVFoundation \
  -framework Speech \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker native/Info.plist \
  -o out/speech/speech-helper

echo "speech helper: out/speech/speech-helper"
