# @flupcode/harness

The FlupCode web app: a Claude Code–style cockpit on the pinned OpenCode 2 engine, plus the screens
for what FlupCode's harness server keeps (runs, workflows, routines, artifacts).

## Stack

- SolidJS + Vite + Tailwind v4 (same stack as upstream `packages/app`).
- Its own transcript markdown renderer in `src/markdown` (derived from OpenCode, MIT): Shiki in a
  Web Worker, incremental streaming, morphdom patching, KaTeX.
- `@opencode/client` (from npm, pinned with the engine) for the engine's HTTP + SSE API, reached only
  through the adapter in `src/engine/` (ADR-0027).

## Scripts

```bash
bun run dev        # Vite dev server on http://localhost:4444
bun run build      # production build
bun run typecheck  # tsgo
```

## Connecting to a server

Start the engine and point the harness at it:

```bash
# terminal 1 — the pinned OpenCode 2 engine behind FlupCode's engine proxy, on :4096
bun packages/flupcode-cli/src/index.ts serve

# terminal 2 — harness-server
bun run --cwd packages/harness-server dev

# terminal 3 — harness UI
bun run dev:harness
```

The server URL defaults to `http://localhost:4096` and can be overridden with
`VITE_OPENCODE_SERVER_URL` or edited in the top bar at runtime.

Routines are persisted and scheduled by `harness-server` on `http://localhost:4097`.
Override it with `VITE_FLUPCODE_HARNESS_SERVER_URL` or `flupcode.harnessServerUrl` in local storage.
The desktop app starts both the OpenCode engine and the harness server automatically when the
repository checkout is available.

## Status

What works end to end and what does not yet is in `docs/AUDIT-2026-10.md` (§5).

## Boundary

The engine is never patched here. Reach it only through `src/engine/`; extend it with a plugin
(`packages/remote/src/engine-plugins-v2.ts`).
