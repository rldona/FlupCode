#!/usr/bin/env bash
#
# Fails unless the harness workflow's `gate` passed on a commit: a release is what CI tested (HE-05).
#
# `gate` is the required check on `main`, so the commit a release tag names has normally passed it on
# its push to `main`. A tag pushed right after the merge can arrive while that run is still going, so
# this waits for it; a commit whose `gate` failed, was cancelled, or never ran fails the release.
# Only jobs of `harness.yml` count: a check named `gate` that some other workflow or app reports is
# not the one `main` requires.
#
# Usage: release-gate.sh <sha>
#
#   GH_REPO        owner/repo, the same variable `gh` itself reads (required)
#   GATE_TIMEOUT   seconds to wait for a run that has not finished, default 2700
#   GATE_INTERVAL  seconds between polls, default 30
set -euo pipefail

sha="${1:?usage: release-gate.sh <sha>}"
repo="${GH_REPO:?GH_REPO is not set}"
timeout="${GATE_TIMEOUT:-2700}"
interval="${GATE_INTERVAL:-30}"
deadline=$((SECONDS + timeout))

while true; do
  pending=0
  failed=""
  runs=$(gh api "repos/$repo/actions/workflows/harness.yml/runs?head_sha=$sha&per_page=100" \
    --jq '.workflow_runs[] | "\(.id) \(.status) \(.html_url)"')
  while read -r id status url; do
    [ -n "$id" ] || continue
    if [ "$status" != completed ]; then
      pending=1
      continue
    fi
    # The latest attempt of the run: a re-run that passed counts, the attempt it replaced does not.
    conclusion=$(gh api "repos/$repo/actions/runs/$id/jobs?per_page=100" --jq '.jobs[] | select(.name == "gate") | .conclusion')
    if [ "$conclusion" = success ]; then
      echo "gate passed on $sha: $url"
      exit 0
    fi
    failed="$failed $url (gate: ${conclusion:-did not run})"
  done <<< "$runs"

  if [ "$pending" = 0 ] && [ -n "$failed" ]; then
    echo "::error::gate did not pass on $sha, so it is not released:$failed"
    exit 1
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    if [ "$pending" = 1 ]; then reason="harness.yml was still running"; else reason="harness.yml never ran on it"; fi
    echo "::error::no passing gate on $sha after ${timeout}s ($reason), so it is not released"
    exit 1
  fi
  if [ "$pending" = 1 ]; then echo "harness.yml is still running on $sha; waiting"; else echo "no harness.yml run on $sha yet; waiting"; fi
  sleep "$interval"
done
