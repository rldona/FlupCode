# FlupCode on OpenCode 2

FlupCode now starts OpenCode 2 as its engine. This page is the user-facing summary for the release
notes. `docs/V2-MIGRATION-AUDIT.md` has the engineering details.

## What changes

- **The desktop app and `flupcode remote` start OpenCode 2.** It is a pinned version (2.0.18), fetched once
  from the npm registry into FlupCode's cache and checked against its published integrity. FlupCode
  never runs whichever `opencode` happens to be on your PATH for this. `FLUPCODE_OPENCODE` names
  another 2.x binary.
- **It has its own database**: `~/.local/share/flupcode/opencode-v2/opencode.db`. OpenCode 2 changes the
  database it opens in one direction, so FlupCode never points it at OpenCode 1.x's `opencode.db`.
- **It always runs behind a password.** FlupCode makes one up and signs in for you. A plain browser tab
  can't drive OpenCode 2, so use the desktop app (or `flupcode remote` and the web app it pairs).
- **Everything FlupCode adds works on it.** This covers permission modes, memory, web actions, the
  adaptive layer, plan exit and the cowork agent. They run as FlupCode's OpenCode 2 plugins.
- **What OpenCode 2 removed is hidden:** the Tasks list, sharing a session, archiving, the session
  replay and taking a sent prompt back (ADR-0026).

## Your OpenCode 1.x history

It stays where it was, untouched, and is only brought over when you ask:

- **Desktop:** File → _Import OpenCode 1.x History…_ (and _Undo OpenCode 1.x Import…_).
- **Terminal:**
  - `flupcode engine import-v1`, or `--from <path>` for another database.
  - `flupcode engine rollback-import`.
  - `flupcode engine import-memory --from <url of a running 1.x engine>` for your memories.

The import copies the 1.x database (it is only read) and keeps what OpenCode 2 held before, so undoing
it puts that back.

## Staying on OpenCode 1.x for now

Set `FLUPCODE_ENGINE=v1` and FlupCode starts the `opencode` on your PATH as before. An engine you start
yourself is used whichever version it is. OpenCode 1.x is **deprecated**: Settings and
`flupcode remote` say so, and support for it is removed in a coming release.
