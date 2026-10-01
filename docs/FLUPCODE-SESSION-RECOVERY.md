# Recovering Local FlupCode Sessions

This guide covers the case where FlupCode opens correctly, but your project session list is empty or
shows only a few sessions.

## What happens

The FlupCode interface and the engine are separate processes:

```text
127.0.0.1:4096  →  OpenCode 2, through FlupCode's engine proxy (sessions and projects)
127.0.0.1:4097  →  FlupCode's harness server (runs, routines, artifacts)
```

The OpenCode 2 engine FlupCode starts uses its own database:
`~/.local/share/flupcode/opencode-v2/opencode.db` (under `$XDG_DATA_HOME` when it is set). It never
opens OpenCode 1.x's `~/.local/share/opencode/opencode.db`, so sessions you had on 1.x are missing
until you import them.

## Diagnose

1. **Which engine answers?** Settings → Server shows `OpenCode <version>`. A banner saying the
   engine is OpenCode 1.x means a 1.x engine took the port: stop it and reopen FlupCode.
2. **Was the history imported?** While OpenCode 2 imports a 1.x copy, the session list shows a
   banner with its progress. If you never imported, nothing from 1.x is there yet.

## Recover

- **Your 1.x sessions:** File → _Import OpenCode 1.x History…_ in the desktop app, or
  `flupcode engine import-v1` with FlupCode's engine stopped. The 1.x database is only read.
- **Undo an import:** File → _Undo OpenCode 1.x Import…_, or `flupcode engine rollback-import`. The
  database it replaces is kept aside, not deleted.
- **Memories from 1.x:** `flupcode engine import-memory --from <url of a running 1.x engine>`.

See [OPENCODE-2.md](OPENCODE-2.md) for what the import brings over.
