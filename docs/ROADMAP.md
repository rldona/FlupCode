# Roadmap

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
| F2-7 | P1 | Sidebar footer: profile / plan indicator | doing |
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
| F3-8 | P1 | Session tags/labels | blocked |
| F3-9 | P1 | Prompt stash | done |
| F3-10 | P1 | Skill manager + v2 composer slash sources (skill/MCP) | doing |
| F3-11 | P1 | Paste summarization | done |
| F3-12 | P1 | Markdown transcript export with options | done |
| F3-13 | P1 | Settings editors: permissions, agents, commands, MCP | blocked |
| F3-14 | P2 | MCP add/configure UI | done |
| F3-15 | P2 | "Toggle steps" command | done |
| F3-16 | P2 | Console org switch | blocked |
| F3-17 | P2 | Keybind/leader parity where sensible | todo |

## F4 — Harness extras

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F4-1 | P1 | Global usage dashboard (sessions/messages/tokens/streaks/peak/favorite) | done |
| F4-2 | P1 | Multi-project workspaces + pinned items | doing |
| F4-3 | P1 | Unified "Personalizar" settings surface | done |
| F4-4 | P2 | Activity heatmap + usage comparisons | done |
| F4-5 | P2 | Artifacts | todo |
| F4-6 | P2 | Routines (scheduled tasks) | todo |
| F4-7 | P2 | Voice input | todo |
| F4-8 | P2 | In-place message editing | todo |

## F5 — Desktop

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F5-1 | P1 | `harness-desktop` Electron shell reusing `packages/desktop` patterns | todo |
| F5-2 | P1 | Native menus, window state, multi-window | todo |
| F5-3 | P1 | Auto-update | todo |
| F5-4 | P1 | Signing/notarization: macOS, Windows, Linux | todo |
| F5-5 | P2 | First-launch onboarding | todo |

## F6 — Remote / mobile

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F6-1 | P1 | PWA + responsive mobile layout | todo |
| F6-2 | P1 | QR pairing + auth flow for LAN access | todo |
| F6-3 | P2 | Push notifications | todo |
| F6-4 | P2 | In-app serve/tunnel management | todo |

## F7 — Release

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F7-1 | P1 | E2E, accessibility, i18n coverage | todo |
| F7-2 | P1 | User documentation | todo |
| F7-3 | P1 | v1.0 release | todo |

---

## Sequencing rules

1. F0/F1 unblock everything; keep upstream sync green before starting F2.
2. F2 before F3: the shell is the substrate the parity features drop into.
3. F4 only after F3 parity passes the matrix in `docs/PARITY.md`.
4. F5 can start once F2 stabilises; desktop reuses the web renderer.
5. F6 is independent of F5 and can run in parallel once the web app is responsive.

---

## Blockers

- **F3-8 Session tags/labels** — the v2 client exposes no tag model. Needs an upstream API.
- **F3-13 Settings editors (permissions/agents/commands/MCP config)** — the vendored v2 client has
  no `config` group. Needs a config read/write endpoint or the legacy SDK.
- **F3-16 Console org switch** — no console API in the v2 client.
- **Share/unshare (part of F3-5)** — the v2 client exposes no share endpoint; only export is available.
