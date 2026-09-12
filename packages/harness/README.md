# @flupcode/harness

The FlupCode web app. A Claude Code–style harness that reuses the OpenCode engine and UI
libraries without modifying upstream packages.

## Stack

- SolidJS + Vite + Tailwind v4 (same stack as upstream `packages/app`).
- `@opencode-ai/ui`, `@opencode-ai/session-ui` for shared UI and rendering.
- `@opencode-ai/client` (vendored, zero-Effect) for the HTTP + SSE API.

## Scripts

```bash
bun run dev        # Vite dev server on http://localhost:4444
bun run build      # production build
bun run typecheck  # tsgo
```

## Connecting to a server

Start the engine and point the harness at it:

```bash
# terminal 1 — engine
bun run --cwd packages/opencode ./src/index.ts serve --port 4096

# terminal 2 — harness
bun run dev:harness
```

The server URL defaults to `http://localhost:4096` and can be overridden with
`VITE_OPENCODE_SERVER_URL` or edited in the top bar at runtime.

## Current scope

This is the F1/F2 bootstrap shell. It connects to the server, lists sessions, creates a session and
sends a prompt. The Claude Code–style shell (F2) and full TUI parity (F3) are tracked in
`docs/ROADMAP.md`; the parity matrix lives in `docs/PARITY.md`.

## Boundary

Never edit upstream packages to make this app work. Wrap or extend them here.
