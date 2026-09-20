#!/usr/bin/env bash
# Restart the local FlupCode engine so it re-reads agent/tool config.
#
# The engine loads .opencode/agent/*.md at startup, so a new agent only appears
# after a restart. This script detaches itself first: a plain background child
# would be killed when the engine that serves the calling turn goes down.
#
# Usage:
#   script/restart-engine.sh              # restart, letting the current turn end first
#   GRACE=0 script/restart-engine.sh      # restart now
#   PORT=4099 script/restart-engine.sh    # another port
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/packages/opencode"
BUN="${BUN:-$HOME/.bun/bin/bun}"
PORT="${PORT:-4096}"
GRACE="${GRACE:-8}"
CORS="${CORS:---cors http://localhost:4444 --cors https://app.flupcode.com}"
LOG="${LOG:-/tmp/flupcode-engine-restart.log}"

# Detach on first run; the child does the actual restart and survives the kill.
if [ "${FLUP_RESTART_CHILD:-}" != "1" ]; then
  FLUP_RESTART_CHILD=1 nohup "$0" "$@" >>"$LOG" 2>&1 &
  echo "engine restart scheduled in ${GRACE}s; log: $LOG"
  exit 0
fi

echo "=== restart $(date) ===" >>"$LOG"

# Leave the turn that invoked us some time to finish before dropping the engine.
sleep "$GRACE"

OLD="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1 || true)"
if [ -n "$OLD" ]; then
  echo "stopping engine pid=$OLD" >>"$LOG"
  kill "$OLD" 2>/dev/null || true
  for _ in $(seq 1 60); do kill -0 "$OLD" 2>/dev/null || break; sleep 0.5; done
  kill -0 "$OLD" 2>/dev/null && { kill -9 "$OLD" 2>/dev/null || true; sleep 1; } || true
else
  echo "no engine listening on $PORT" >>"$LOG"
fi

for _ in $(seq 1 60); do
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 || break
  sleep 0.5
done

cd "$DIR"
export OPENCODE_DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
unset OPENCODE_SERVER_PASSWORD

for attempt in 1 2 3; do
  echo "--- start attempt $attempt ---" >>"$LOG"
  # shellcheck disable=SC2086
  "$BUN" run ./src/index.ts serve --port "$PORT" --hostname 127.0.0.1 $CORS >>"$LOG" 2>&1 &
  NEWPID=$!
  up=0
  for _ in $(seq 1 60); do
    if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then up=1; break; fi
    kill -0 "$NEWPID" 2>/dev/null || break
    sleep 0.5
  done
  if [ "$up" = 1 ]; then echo "engine up pid=$NEWPID" >>"$LOG"; exit 0; fi
  echo "attempt $attempt failed" >>"$LOG"
  kill -9 "$NEWPID" 2>/dev/null || true
  sleep 2
done

echo "FAILED to restart engine" >>"$LOG"
exit 1
