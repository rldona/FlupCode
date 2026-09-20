# @openharness/desktop

Electron wrapper for OpenHarness. It loads the `packages/harness` web renderer and, in a later
ticket, will manage the local OpenCode server sidecar, native menus, auto-update and packaging.

## Scripts

```bash
# start the harness dev server first (port 4444)
bun run dev:harness

# then start the desktop shell against it
bun run dev:harness-desktop
```

Set `OPENHARNESS_DEV_URL` to point at a different renderer URL. In packaged builds the window loads
the bundled `out/renderer/index.html`.

## Status

F5-1 bootstrap: main process + window loading. Server sidecar, menus, updater and signing are
tracked in `docs/tickets/F5-desktop.md`.

## Boundary

Never edit upstream packages. Extend from here.
