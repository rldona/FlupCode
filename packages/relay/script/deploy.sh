#!/usr/bin/env bash
# Deploys the relay to Fly.io from a minimal build context (the relay and the remote protocol only),
# so the repository and its node_modules are never uploaded. Extra arguments go to `fly deploy`.
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT

mkdir -p "$context/packages/remote" "$context/packages/relay"
cp -R "$root/packages/remote/src" "$root/packages/remote/package.json" "$context/packages/remote/"
cp -R "$root/packages/relay/src" "$root/packages/relay/package.json" "$context/packages/relay/"
cp "$root/packages/relay/Dockerfile" "$root/packages/relay/fly.toml" "$context/"

cd "$context"
fly deploy --config fly.toml --dockerfile Dockerfile --remote-only "$@"
