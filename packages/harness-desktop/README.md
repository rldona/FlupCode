# @flupcode/desktop

Electron app for FlupCode. It loads the `packages/harness` web renderer, starts the pinned OpenCode 2
engine and FlupCode's harness server as sidecars, signs its window in to both, and carries native
menus, auto-update and packaging.

## Scripts

```bash
# start the harness dev server first (port 4444)
bun run dev:harness

# then start the desktop shell against it
bun run dev:harness-desktop
```

Set `FLUPCODE_DEV_URL` to point at a different renderer URL. In packaged builds the window loads
the bundled `out/renderer/index.html`.

## Status

Builds are not signed or notarized yet (F5-4). Open desktop hardening work is in
`docs/AUDIT-2026-10.md` (TI-10, TI-17).

## Boundary

The engine is never patched here; FlupCode's additions to it ship as plugins.
