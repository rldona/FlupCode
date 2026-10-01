# Architecture

FlupCode is a web and desktop app on the official [OpenCode](https://github.com/anomalyco/opencode) 2
engine. This document explains the engine we build on, the boundary we keep with it, and how our
packages fit together. The repository holds only FlupCode's code (ADR-0027).

## 1. The engine in one picture

OpenCode is a client/server system. One engine, many front-ends:

```
                         ┌─────────────────────────────┐
   OpenCode's TUI     ──▶│                             │
   FlupCode web       ──▶│   opencode serve (2.x)      │
   FlupCode desktop   ──▶│   HTTP API + SSE events     │
   flupcode CLI       ──▶│   plugins (FlupCode's)      │
                         └─────────────────────────────┘
```

- The engine is the official `@opencode/cli-<platform>` binary at one pinned version
  (`OPENCODE_V2_VERSION` in `packages/remote/src/opencode-v2.ts`), fetched from npm and checked
  against its published integrity. The desktop, `flupcode remote` and `flupcode serve` start it with
  a password of their own and FlupCode's own database.
- The apps talk to it through `@opencode/client`, pinned to the same version.
- What FlupCode adds to the engine (memory, `plan_exit`, permission modes, web actions, the adaptive
  layer…) ships as 2.x plugins (`packages/remote/src/engine-plugins-v2.ts`), installed into the
  engine's config folder before it starts.

See [UPSTREAM.md](UPSTREAM.md) for how the pin moves.

## 2. The engine boundary

```
packages/harness (web)
  └── src/engine/v2.ts         the adapter: EngineClient (src/engine/contract.ts) over @opencode/client

packages/harness-server
  └── src/engine-v2.ts         the server's door to the engine (runs, routines, the adaptive layer)

packages/remote
  ├── opencode-v2.ts           installs and starts the pinned binary
  ├── engine-plugins-v2.ts     FlupCode's plugins
  └── engine-proxy.ts          signs the web app in to the engine (2.1)
```

- Only the adapters import `@opencode/client`; a test in each package enforces it. The rest of the
  app works with FlupCode's own types (`src/engine-types.ts`, `src/engine/sdk-types.ts`).
- `bun script/opencode-pin.ts` (CI) checks that every pin agrees with the binary.
- `packages/engine-contract` runs FlupCode's flows and plugins against the real binary, so a pin bump
  is judged by what the engine actually does.

## 3. Runtime topology

```
 Desktop shell (Electron main)
   ├── starts the pinned OpenCode 2 on a private port, and the engine proxy on 4096
   ├── starts harness-server (loopback)
   └── BrowserWindow ── loads packages/harness (renderer)
                            │
                            └── HTTP + SSE ──▶ proxy ──▶ opencode serve
 Web mode
   └── browser ── packages/harness ── HTTP + SSE ──▶ desktop or `flupcode serve` (proxy on 4096)
 Remote control (ADR-0010)
   phone PWA ── tunnel transport ══ E2E encrypted ══▶ relay ══▶ host: desktop main or `flupcode remote`
                                                               └── HTTP + SSE + WS ──▶ opencode serve
```

- `packages/remote` — protocol shared by every side: secure channel, tunnel, relay framing,
  pairing links, the desktop↔renderer bridge types and `createRemoteHost` (the host logic).
- `packages/flupcode-cli` — the `flupcode` command: `remote`, `serve`, `engine`.
- `packages/relay` — the Bun relay server (Docker/Fly.io); it routes opaque frames only.
- The harness sends every engine call through `src/transport.ts`, which the remote client swaps for
  the tunnel. On touch devices controlling a computer it renders the phone layout
  (`components/RemoteHome.tsx`).
- Push notifications (ADR-0011): the host watches engine events and encrypts a Web Push for each
  subscribed phone; the relay signs VAPID and delivers it; `public/sw.js` shows it.
- Deployments: `app.flupcode.com` and `flupcode.com` on Vercel from `main`; the relay on Fly.io.

## 4. Package conventions

- Language: **English only** for identifiers, types, comments, filenames, commits and branches.
  User-facing strings go through i18n (default `en`), never hardcoded. See ADR-0008.
- Stack: SolidJS, Vite, Tailwind v4.
- Styling follows the design tokens in `docs/DESIGN.md`.
- Tests run from package directories, never the repo root.

## 5. Related decisions

- ADR-0027 — FlupCode runs the official OpenCode 2, not a fork (supersedes ADR-0001)
- ADR-0026 — What FlupCode does about the features OpenCode 2 removed
- ADR-0002 — Where UI code lives
- ADR-0003 — Design system
- ADR-0004 — Branding and license
- ADR-0005 — Web vs desktop packaging
- ADR-0006 — Definition of parity
- ADR-0007 — Remote/mobile
- ADR-0008 — Language and code conventions
- ADR-0009 — Engine API layer
- ADR-0010 — Remote control through an end-to-end encrypted relay
- ADR-0011 — Push notifications for remote control
- ADR-0012 — Memory as a first-class knowledge primitive (see `docs/MEMORY.md`)
- ADR-0013 — Cowork, a chat that can work in the project
- ADR-0014 — Memory handoff and guarded capture
- ADR-0015 — Web actions and browser automation (see `docs/WEB-ACTIONS.md`)
