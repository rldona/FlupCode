# Recovering Local FlupCode Sessions

This guide covers the case where FlupCode opens correctly, but your project
session list is empty or contains only a few sessions.

## What happens

The local FlupCode interface and the session engine are separate processes:

```text
127.0.0.1:4097  →  harness de FlupCode (interfaz)
127.0.0.1:4096  →  OpenCode engine (sessions and projects)
```

The harness uses `FLUPCODE_ENGINE_URL` to connect to the engine. Sessions are
stored in a local SQLite database. On macOS, the primary database is usually:

```text
~/.local/share/opencode/opencode.db
```

Local channels or profiles may use another database, such as
`~/.local/share/opencode/opencode-local.db`. If the engine starts with that
database, FlupCode has not lost the sessions: it is querying a different store.

## Diagnosis

Check which processes are running:

```bash
ps -axo pid=,ppid=,command= | grep -iE 'flupcode|opencode' | grep -v grep
```

Check the available databases:

```bash
find "$HOME/Library/Application Support" -maxdepth 3 -type f \
  \( -name 'opencode*.db' -o -name '*.sqlite' \) -print

find "${XDG_DATA_HOME:-$HOME/.local/share}" -maxdepth 3 -type f \
  \( -name 'opencode*.db' -o -name '*.sqlite' \) -print
```

Compare the number of sessions:

```bash
sqlite3 "$HOME/.local/share/opencode/opencode.db" \
  "SELECT count(*) FROM session;"

sqlite3 "$HOME/.local/share/opencode/opencode-local.db" \
  "SELECT count(*) FROM session;"
```

The harness process should show configuration similar to this:

```text
FLUPCODE_ENGINE_URL=http://127.0.0.1:4096
FLUPCODE_HARNESS_PORT=4097
```

## Fix

Do not delete or move any database. Stop the engine listening on `4096` and
start it again with the primary database explicitly selected:

```bash
kill <PID_DEL_MOTOR_EN_4096>
kill <PID_DEL_LANZADOR_DEL_MOTOR>
```

Get the PIDs from the diagnosis above. If the engine was started from this
repository, run it as follows:

```bash
cd /Users/raul.lopezcepsa.com/workspace/opencode-ui-power/packages/opencode

OPENCODE_DB="$HOME/.local/share/opencode/opencode.db" \
env -u OPENCODE_SERVER_PASSWORD \
bun run ./src/index.ts serve \
  --port 4096 \
  --hostname 127.0.0.1 \
  --cors http://localhost:4444 \
  --cors https://app.flupcode.com
```

If you use the installed binary, replace the `bun run ...` command with:

```bash
OPENCODE_DB="$HOME/.local/share/opencode/opencode.db" \
env -u OPENCODE_SERVER_PASSWORD \
opencode serve \
  --port 4096 \
  --hostname 127.0.0.1 \
  --cors http://localhost:4444 \
  --cors https://app.flupcode.com
```

The interface process on `4097` does not need to be changed. Reload the FlupCode
window after restarting the engine.

## Verification

Check that the engine responds:

```bash
curl -i --max-time 5 http://127.0.0.1:4096/api/health
```

Check that it returns sessions:

```bash
curl -fsS \
  'http://127.0.0.1:4096/session?limit=3&roots=true'
```

To confirm that it is reading the expected project:

```bash
curl -fsS \
  'http://127.0.0.1:4096/session?limit=1&roots=true' \
  | python3 -c 'import json,sys; x=json.load(sys.stdin); print(x[0]["directory"], "—", x[0]["title"])'
```

Finally, check that the harness is still listening on `4097`:

```bash
lsof -nP -iTCP:4097 -sTCP:LISTEN
```

This procedure only changes the engine process and does not modify the contents
of any database.
