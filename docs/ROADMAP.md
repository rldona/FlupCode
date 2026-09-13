# Roadmap

Released: **flupcode-v1.0.0** (web bundle attached to the GitHub Release).

Prioritised, ticket-based plan. Priorities: **P0** must-have for the phase · **P1** important ·
**P2** nice-to-have. Detailed tickets live in [docs/tickets/](tickets/).

Status: `todo` · `doing` · `done` · `blocked` · `cut`

## Milestones

| Milestone | Phases | Outcome |
| --- | --- | --- |
| **M0 Foundation** | F0, F1 | Fork bootstrapped, docs, upstream sync |
| **M1 Harness shell (web)** | F2, F3 | Claude Code–style web UI at TUI parity |
| **M2 Harness extras** | F4 | Dashboard, artifacts, routines, workspaces |
| **M3 Desktop** | F5 | Packaged, signed, auto-updating desktop app |
| **M4 Remote/mobile** | F6 | PWA, QR pairing, push |
| **M5 v1.0** | F7 | Stable, documented, released |
| **M6 Remote control** | F8 | Phone drives a desktop session through an E2E encrypted relay |

---

## Status summary

_Last updated: 2026-09-13._

| Status | Count | Tickets |
| --- | --- | --- |
| done | 61 | all F0–F7 tickets except F3-14, F3-16 and F5-4; F8-1 … F8-8, F8-10 |
| doing | 0 | — |
| blocked | 3 | F3-14, F3-16, F5-4 |
| todo | 2 | F8-9, F8-11 |
| **total** | **66** | |

### What remains

F8 (remote control, ADR-0010) shipped in `flupcode-v1.0.9`, with the relay at
`wss://relay.flupcode.com`. Next: the `flupcode remote` terminal host (F8-11) and Web Push (F8-9).

The other open items are blocked on external constraints:

- **F3-14 MCP manager** — the vendored client (`1.17.13`) calls `/api/mcp`, removed in the current
  server (`1.18.30`); configure MCP through the engine config for now.
- **F3-16 Console org switch** — no console API in the v2 client.
- **F5-4 Signing/notarization** — requires Apple/Windows developer certificates and CI secrets.
- **Share/unshare (part of F3-5)** — the v2 client exposes no share endpoint; export is available.

---

## F0 — Discovery

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F0-1 | P0 | TUI ↔ Web parity audit → `docs/PARITY.md` | done |
| F0-2 | P0 | Server/SDK capability inventory vs UI surfaces | done |
| F0-3 | P0 | Fork bootstrap: build `dev:web` / `dev:desktop` | done |
| F0-4 | P0 | Initial ADRs (0001–0008) | done |

## F1 — Foundation & upstream

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F1-1 | P0 | Fork, remotes, branch model (`dev` mirror / `power`) | done |
| F1-2 | P0 | `upstream-sync` GitHub Action (`dev` FF + PR to `power`) | done |
| F1-3 | P0 | Rebrand: name, icons, about, non-affiliation notice | done |
| F1-4 | P0 | Base docs (README, ARCHITECTURE, UPSTREAM, CONTRIBUTING) | done |
| F1-5 | P1 | Product build/release pipeline | done |
| F1-6 | P1 | Set `power` as default branch on the fork | done |

## F2 — Design system & shell (Claude Code style)

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F2-1 | P0 | Design tokens + theme layer mapped to `@opencode-ai/ui` | done |
| F2-2 | P0 | Window chrome: traffic lights, back/forward, sidebar toggle | done |
| F2-3 | P0 | Sidebar: nav sections (Nuevo/Artefactos/Rutinas/Personalizar) | done |
| F2-4 | P0 | Sidebar: project list with quick-create, pin, search/filter | done |
| F2-5 | P0 | Greeting header + home canvas | done |
| F2-6 | P0 | Composer dock: context chips, attachments, voice, model/variant | done |
| F2-7 | P1 | Sidebar footer: profile / plan indicator | done |
| F2-8 | P1 | Empty states, skeletons, toasts | done |

## F3 — TUI parity

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F3-1 | P0 | Slash commands + command palette in harness | done |
| F3-2 | P0 | `@` mentions and `!` shell mode | done |
| F3-3 | P0 | Permissions & questions docks | done |
| F3-4 | P0 | Undo/redo, revert, fork, compact | done |
| F3-5 | P0 | Session list/switch, share/unshare, export | done |
| F3-6 | P0 | Agents, subagents, todos | done |
| F3-7 | P1 | Move session between locations | done |
| F3-8 | P1 | Session tags/labels | done |
| F3-9 | P1 | Prompt stash | done |
| F3-10 | P1 | Skill manager + v2 composer slash sources (skill/MCP) | done |
| F3-11 | P1 | Paste summarization | done |
| F3-12 | P1 | Markdown transcript export with options | done |
| F3-13 | P1 | Settings editors: permissions, agents, commands, MCP | done |
| F3-14 | P2 | MCP add/configure UI | blocked |
| F3-15 | P2 | "Toggle steps" command | done |
| F3-16 | P2 | Console org switch | blocked |
| F3-17 | P2 | Keybind/leader parity where sensible | done |

## F4 — Harness extras

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F4-1 | P1 | Global usage dashboard (sessions/messages/tokens/streaks/peak/favorite) | done |
| F4-2 | P1 | Multi-project workspaces + pinned items | done |
| F4-3 | P1 | Unified "Personalizar" settings surface | done |
| F4-4 | P2 | Activity heatmap + usage comparisons | done |
| F4-5 | P2 | Artifacts | done |
| F4-6 | P2 | Routines (scheduled tasks) | done |
| F4-7 | P2 | Voice input | done |
| F4-8 | P2 | In-place message editing | done |

## F5 — Desktop

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F5-1 | P1 | `harness-desktop` Electron shell reusing `packages/desktop` patterns | done |
| F5-2 | P1 | Native menus, window state, multi-window | done |
| F5-3 | P1 | Auto-update | done |
| F5-4 | P1 | Signing/notarization: macOS, Windows, Linux | blocked |
| F5-5 | P2 | First-launch onboarding | done |

## F6 — Remote / mobile

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F6-1 | P1 | PWA + responsive mobile layout | done |
| F6-2 | P1 | QR pairing + auth flow for LAN access | done |
| F6-3 | P2 | Push notifications | done |
| F6-4 | P2 | In-app serve/tunnel management | done |

## F7 — Release

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F7-1 | P1 | E2E, accessibility, i18n coverage | done |
| F7-2 | P1 | User documentation | done |
| F7-3 | P1 | v1.0 release | done |

## F8 — Remote control

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F8-1 | P0 | Design: ADR-0010 and tickets | done |
| F8-2 | P0 | Secure channel (`@flupcode/remote`) | done |
| F8-3 | P0 | Tunnel multiplexer (`@flupcode/remote`) | done |
| F8-4 | P0 | Relay server (`@flupcode/relay`) | done |
| F8-5 | P0 | Desktop host: identity, pairing, devices | done |
| F8-6 | P0 | Harness transport for all engine traffic | done |
| F8-7 | P0 | Remote control UI (desktop and phone) | done |
| F8-8 | P1 | Docs and end-to-end test | done |
| F8-9 | P2 | Web Push while locked | todo |
| F8-10 | P1 | Phone layout for remote sessions | done |
| F8-11 | P1 | `flupcode remote` terminal host | todo |

---

## Sequencing rules

1. F0/F1 unblock everything; keep upstream sync green before starting F2.
2. F2 before F3: the shell is the substrate the parity features drop into.
3. F4 only after F3 parity passes the matrix in `docs/PARITY.md`.
4. F5 can start once F2 stabilises; desktop reuses the web renderer.
5. F6 is independent of F5 and can run in parallel once the web app is responsive.
6. F8: protocol (F8-2, F8-3) before relay and host; harness transport (F8-6) before the UI.

---

## Blockers

- **F3-14 MCP manager** — the vendored client (`1.17.13`) calls `/api/mcp`, removed in the current
  server (`1.18.30`); configure MCP through the engine config for now.
- **F3-16 Console org switch** — no console API in the v2 client.
- **Share/unshare (part of F3-5)** — the v2 client exposes no share endpoint; only export is available.
- **F5-4 Signing/notarization** — requires Apple/Windows developer certificates and CI secrets; cannot be completed in-repo.

### Engine API layer

Resolved in ADR-0009: the harness uses `@opencode-ai/sdk/v2/client` (ADR-0009) and reaches the
event stream over SSE. Projects are derived from session locations. MCP remains blocked because the
current engine does not expose an MCP group.
