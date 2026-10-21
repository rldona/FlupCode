#!/usr/bin/env bash
# Regenerates docs/assets/cover.png (the repository cover / GitHub social preview, 1280x640)
# from docs/assets/cover.html, which lays out the app icon, name and docs/assets/flupcode-cover-new.png.
#
#   script/make-cover.sh
#
# Needs Google Chrome (or set CHROME to any Chromium binary).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1280,640 --screenshot="$root/docs/assets/cover.png" "file://$root/docs/assets/cover.html"
echo "wrote docs/assets/cover.png"
