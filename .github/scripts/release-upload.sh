#!/usr/bin/env bash
#
# Uploads release assets and retries the ones GitHub's asset endpoint drops.
#
# Measured against uploads.github.com on 2026-09-17: about a quarter of attempts fail with HTTP
# 500/504, and a failing attempt crawls at ~100-200 KB/s for one to three minutes before it dies,
# while a healthy one moves 1-8 MiB/s. A retry almost always recovers, so the fix is to retry rather
# than to change how many jobs upload (parallel jobs measured ~4.5 MiB/s combined and did not
# degrade each other). `--clobber` replaces whatever a killed attempt left behind.
#
# Usage: release-upload.sh <tag> <file>...
#
#   GH_REPO          owner/repo, the same variable `gh` itself reads (required)
#   UPLOAD_ATTEMPTS  attempts per file, default 5
#   UPLOAD_TIMEOUT   seconds before an attempt is killed and retried, default 240
#   UPLOAD_BACKOFF   seconds before the first retry, doubling up to 120, default 10
set -euo pipefail

tag="${1:?usage: release-upload.sh <tag> <file>...}"
shift
repo="${GH_REPO:?GH_REPO is not set}"
attempts="${UPLOAD_ATTEMPTS:-5}"
timeout="${UPLOAD_TIMEOUT:-240}"
backoff="${UPLOAD_BACKOFF:-10}"

# `kill` is portable; GNU `timeout` is not, on macOS or Git Bash, and both run this script.
upload_with_timeout() {
  local file="$1" status=0
  gh release upload "$tag" "$file" --repo "$repo" --clobber &
  local pid=$!
  (
    sleep "$timeout"
    kill -0 "$pid" 2>/dev/null && kill "$pid" 2>/dev/null || true
  ) &
  local watcher=$!
  wait "$pid" || status=$?
  kill "$watcher" 2>/dev/null || true
  wait "$watcher" 2>/dev/null || true
  return "$status"
}

for file in "$@"; do
  attempt=1
  wait_seconds="$backoff"
  while true; do
    if upload_with_timeout "$file"; then
      echo "uploaded $file"
      break
    fi
    if [ "$attempt" -ge "$attempts" ]; then
      echo "::error::gave up on $file after $attempt attempts"
      exit 1
    fi
    echo "retrying $file in ${wait_seconds}s (attempt $((attempt + 1))/$attempts)"
    sleep "$wait_seconds"
    attempt=$((attempt + 1))
    wait_seconds=$((wait_seconds * 2))
    if [ "$wait_seconds" -gt 120 ]; then
      wait_seconds=120
    fi
  done
done
