# ADR-0002: Where UI code lives

- **Status:** Accepted
- **Date:** 2026-09-12

## Context

OpenCode ships a web app (`packages/app`, SolidJS + Vite) that the desktop app embeds. We want a
Claude Code–style harness experience that differs substantially from the default UI. The obvious
option is to restyle `packages/app` directly, but that package is upstream-owned and changes
frequently, which would make the sync in ADR-0001 painful.

## Decision

Build the product UI in a **new, isolated package** `packages/harness`, reusing:

- `@opencode-ai/ui` for primitives, icons, themes and i18n.
- `@opencode-ai/session-ui` for timeline, message parts, diff rendering and the composer.
- `@opencode-ai/client` / `@opencode-ai/sdk` for the full HTTP + SSE API.

The desktop app becomes `packages/harness-desktop` (Electron), also isolated.

## Alternatives considered

1. **Edit `packages/app` in place.** Maximum reuse and fastest first pixels, but every upstream
   change to that package risks conflicts.
2. **Theme seam inside `packages/app`.** Isolate our styling behind a toggle. Less conflict than (1)
   but still requires editing upstream files and constrains structural change.

## Consequences

- Upstream packages stay pristine; sync remains fast-forward friendly.
- We reimplement routing, providers and app state in `harness`, but reuse the expensive rendering
  and engine-facing layers.
- The harness owns its own build, tests and release pipeline.
- No browser code may import `@opencode-ai/core` or `@opencode-ai/server`; the engine is reached
  over HTTP/SSE.
