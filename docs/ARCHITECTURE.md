# Architecture

FlupCode is a fork of [OpenCode](https://github.com/anomalyco/opencode). This document explains
the upstream architecture we build on, the boundary we keep with upstream code, and how our
product packages fit in.

## 1. Upstream in one picture

OpenCode is a client/server system. One engine, many front-ends:

```
                         ┌─────────────────────────────┐
   TUI (packages/tui) ──▶│                             │
   Web (packages/app) ──▶│   opencode server (Hono +   │
   Desktop (Electron) ──▶│   Effect) + Core engine     │
   IDE plugins        ──▶│   HTTP API + SSE events     │
                         └─────────────────────────────┘
                                      │
                         packages/core  (sessions, tools,
                         providers, permissions, LSP, PTY)
```

- `packages/opencode` — CLI entrypoint, server bootstrap, TUI launcher.
- `packages/server` — the authoritative `HttpApi` (routes, codecs, middleware).
- `packages/core` — session runtime, tools, providers, permissions, LSP, PTY.
- `packages/protocol` / `packages/schema` — shared public values and HTTP contract.
- `packages/client` / `packages/sdk` / `packages/sdk-next` — generated clients.
- `packages/tui` — the terminal UI (SolidJS + OpenTUI).
- `packages/app` — the upstream web app (SolidJS + Vite), embedded by desktop.
- `packages/desktop` — the upstream Electron app.
- `packages/ui` — shared UI primitives, icons, themes, i18n.
- `packages/session-ui` — message/session rendering and the composer.

The server publishes an OpenAPI 3.1 spec at `/doc`; the SDK is generated from it. Any client that
speaks the HTTP API is a first-class citizen.

## 2. The FlupCode boundary

**Rule: upstream packages are read-only.** We never edit `packages/{opencode,server,core,protocol,
schema,client,sdk,sdk-next,tui,app,desktop,ui,session-ui}`. If we need behaviour we wrap or extend
it from our own packages.

```
packages/harness (web)
  ├── depends on @opencode-ai/ui          (primitives, icons, themes, i18n)
  ├── depends on @opencode-ai/session-ui  (timeline, message parts, composer)
  ├── depends on @opencode-ai/client      (vendored, same tgz upstream/app uses)
  └── depends on @opencode-ai/sdk         (full HTTP API + SSE)

packages/harness-desktop
  └── Electron main process that boots the local server, hosts remote control and loads packages/harness

packages/remote, packages/relay, packages/flupcode-cli
  └── remote control: protocol and host, relay server, `flupcode remote` (ADR-0010)
```

Why a new package instead of forking `packages/app`:
- Upstream `dev` can be merged with near-zero conflicts.
- We can restyle and restructure aggressively without touching shared code.
- We still reuse the hard parts (message rendering, composer, diff viewer, theme engine).

### Dependency direction

FlupCode must respect upstream's layering:

- `sdk`/`client` may be consumed freely.
- `@opencode-ai/ui` and `@opencode-ai/session-ui` are UI-only and safe.
- **Do not import `@opencode-ai/core` or `@opencode-ai/server` from browser code.** The web app
  talks to the engine over HTTP/SSE via the client. Desktop may import core/server in the Electron
  main process only.

## 3. Runtime topology

```
 Desktop shell (Electron main)
   ├── starts / attaches to `opencode serve` (loopback)
   └── BrowserWindow ── loads packages/harness (renderer)
                            │
                            └── HTTP + SSE ──▶ opencode server
 Web mode
   └── browser ── packages/harness ── HTTP + SSE ──▶ opencode serve (LAN/localhost)
 Remote control (ADR-0010)
   phone PWA ── tunnel transport ══ E2E encrypted ══▶ relay ══▶ host: desktop main or `flupcode remote`
                                                               └── HTTP + SSE + WS ──▶ opencode server
```

- `packages/remote` — protocol shared by every side: secure channel, tunnel, relay framing,
  pairing links, the desktop↔renderer bridge types and `createRemoteHost` (the host logic).
- `packages/flupcode-cli` — the `flupcode` command; `flupcode remote` is a terminal host.
- `packages/relay` — the Bun relay server (Docker/Fly.io); it routes opaque frames only.
- The harness sends every engine call through `src/transport.ts`, which the remote client swaps for
  the tunnel. On touch devices controlling a computer it renders the phone layout
  (`components/RemoteHome.tsx`).
- Push notifications (ADR-0011): the host watches engine events and encrypts a Web Push for each
  subscribed phone; the relay signs VAPID and delivers it; `public/sw.js` shows it.
- Deployments: `app.flupcode.com` and `flupcode.com` on Vercel from `power`; the relay on Fly.io.

## 4. Package conventions

- Language: **English only** for identifiers, types, comments, filenames, commits and branches.
  User-facing strings go through i18n (default `en`), never hardcoded. See ADR-0008.
- Stack: SolidJS, Vite, Tailwind v4, Kobalte — identical to upstream to maximise reuse.
- Styling follows the design tokens in `docs/DESIGN.md`.
- Tests run from package directories, never the repo root.

## 5. Related decisions

- ADR-0001 — Fork and upstream synchronisation
- ADR-0002 — Where UI code lives
- ADR-0003 — Design system
- ADR-0004 — Branding and license
- ADR-0005 — Web vs desktop packaging
- ADR-0006 — Definition of parity
- ADR-0007 — Remote/mobile
- ADR-0008 — Language and code conventions
- ADR-0009 — Engine API layer uses the SDK v2 client
- ADR-0010 — Remote control through an end-to-end encrypted relay
- ADR-0011 — Push notifications for remote control
