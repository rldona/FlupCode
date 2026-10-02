# Roadmap (historical)

**This is not the current plan.** The current plan, the status of every feature and the order of
work are in [AUDIT-2026-10.md](AUDIT-2026-10.md): feature statuses in §5, tickets in §17, execution
order in §22. Where this file and that audit disagree, the audit is right.

What follows is the record of how FlupCode was built, phase by phase, up to the 3.0 line (current
release: see the GitHub Releases). Each row's status is what was recorded when the phase closed. The
October 2026 audit, run against the code and the running app, contradicts several of them; those
rows carry a note pointing at it. A `done` without a note means "built", not "verified end to end".

Priorities: **P0** must-have for the phase · **P1** important · **P2** nice-to-have. Detailed
tickets of that period live in [docs/tickets/](tickets/).

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
| **M7 Web actions** | F9 | The agent acts on a real website through a profile you declare, with approval |

Since then FlupCode stopped being a fork: it runs on the pinned OpenCode 2 engine and adds to it
through plugins (ADR-0027). The fork-era rows below (F0, F1) describe a repository layout that no
longer exists.

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
| F2-2 | P0 | Window chrome: traffic lights, back/forward, sidebar toggle | done (desktop owns title bar + traffic lights; Topbar back/forward/sidebar, verified 2026-09-20) |
| F2-3 | P0 | Sidebar: nav sections (Nuevo/Artefactos/Rutinas/Personalizar) | done |
| F2-4 | P0 | Sidebar: project list with quick-create, pin, search/filter | done |
| F2-5 | P0 | Greeting header + home canvas | done |
| F2-6 | P0 | Composer dock: context chips, attachments, voice, model/variant | done |
| F2-7 | P1 | Sidebar footer: profile / plan indicator | done |
| F2-8 | P1 | Empty states, skeletons, toasts | done |

## F3 — TUI parity

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F3-1 | P0 | Slash commands + command palette in harness | done — October audit: seven built-ins are Broken from the composer (§5.2, TI-13) |
| F3-2 | P0 | `@` mentions and `!` shell mode | done |
| F3-3 | P0 | Permissions & questions docks | done |
| F3-4 | P0 | Undo/redo, revert, fork, compact | done |
| F3-5 | P0 | Session list/switch, share/unshare, export | done — October audit: sharing is Partially implemented, a loopback link (§5.2) |
| F3-6 | P0 | Agents, subagents, todos | done — October audit: todos are Dead code on OpenCode 2 (§5.1) |
| F3-7 | P1 | Move session between locations | done (wired 2026-09-16) |
| F3-8 | P1 | Session tags/labels | done (TagsDialog + sidebar filter + server prefs, verified 2026-09-20) |
| F3-9 | P1 | Prompt stash | done |
| F3-10 | P1 | Skill manager + v2 composer slash sources (skill/MCP) | done (SK-1 per-agent visibility, SK-2 source badges, verified 2026-09-20) |
| F3-11 | P1 | Paste summarization | done |
| F3-12 | P1 | Markdown transcript export with options | done |
| F3-13 | P1 | Settings editors: permissions, agents, commands, MCP | done (SE-1 pattern rules, SE-2 MCP OAuth, verified 2026-09-20) — October audit: the agent editor is Partially implemented, its tools are empty on OpenCode 2, and Config (advanced) shows `{}` (§5.2) |
| F3-14 | P2 | MCP add/configure UI | done (wired 2026-09-16) |
| F3-15 | P2 | "Toggle steps" command | done |
| F3-16 | P2 | Console org switch | done (CO-1 selector in providers; no/single-Console verified live, multi-org wired — needs an account with 2 orgs to exercise) — October audit: the organisation switch is Dead code on OpenCode 2 (§5.2) |
| F3-17 | P2 | Keybind/leader parity where sensible | done (7 actions editable in Settings shortcuts, keybinds.test.ts green, verified 2026-09-20) |

## F4 — Harness extras

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F4-1 | P1 | Global usage dashboard (sessions/messages/tokens/streaks/peak/favorite) | done — October audit: its totals and its per-model breakdown count tokens differently (§2.3, UL-09) |
| F4-2 | P1 | Multi-project workspaces + pinned items | done |
| F4-3 | P1 | Unified "Personalizar" settings surface | done (CU-1–CU-3: agents/providers/MCP sections, modals retired) |
| F4-4 | P2 | Activity heatmap + usage comparisons | done |
| F4-5 | P2 | Artifacts | done in 1.10.0 (H-14): reports and verdicts kept by the harness server, with a panel |
| F4-6 | P2 | Routines (scheduled tasks) | done in 1.8.0 (H-10): run by the harness server, with history — October audit: timezone is a Stub, templates UI-only, desktop only (§5.1) |
| F4-7 | P2 | Voice input | done |
| F4-8 | P2 | In-place message editing | done |

## F5 — Desktop

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F5-1 | P1 | `harness-desktop` Electron shell reusing `packages/desktop` patterns | done |
| F5-2 | P1 | Native menus, window state, multi-window | done |
| F5-3 | P1 | Auto-update | done |
| F5-4 | P1 | Signing/notarization: macOS, Windows, Linux | blocked (still, §5.2) |
| F5-5 | P2 | First-launch onboarding | done |

## F6 — Remote / mobile

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| F6-1 | P1 | PWA + responsive mobile layout | done |
| F6-2 | P1 | QR pairing + auth flow for LAN access | done |
| F6-3 | P2 | Push notifications | done |
| F6-4 | P2 | In-app serve/tunnel management | done (TN-1 copyable LAN/tunnel commands, TN-2 URL reachability, verified 2026-09-20) — October audit: LAN/cloudflared sharing is UI-only and probably broken on OpenCode 2 (§5.2) |

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
| F8-9 | P2 | Web Push while locked | done |
| F8-10 | P1 | Phone layout for remote sessions | done |
| F8-11 | P1 | `flupcode remote` terminal host | done |

---

## F9 — Web actions

The agent acts on a real website on your machine through a browser, driven by a **profile you
declare** in `flupcode.actions`. Publishing is one profile; reading a page is another. Approval is per
sensitive action, credentials are injected by name, and every step keeps evidence. Publishing to a
specific site is a use case, not the feature. See [ADR-0015](adr/0015-web-actions-and-browser-automation.md),
[WEB-ACTIONS.md](WEB-ACTIONS.md) and [tickets/WA-web-actions.md](tickets/WA-web-actions.md). Native OS
automation is a later, separate medium (`flupcode.os`), not a profile inside `actions`.

| ID | P | Ticket | Status |
| --- | --- | --- | --- |
| WA-0 | P0 | Contract and docs (ADR-0015, WEB-ACTIONS) | done |
| WA-1 | P0 | Browser runtime and boundary (token, SSRF, screenshots) | done |
| WA-2 | P0 | Action engine (recipe, deterministic runner, extract, guards) | done |
| WA-3 | P0 | Plugin tools and per-action approval | done — October audit: the approval is applied by the plugin, not by the harness server (§1, TI-09) |
| WA-4 | P0 | Permissions and session UI | done |
| WA-5 | P0 | Credentials, isolated profiles, redaction | done |
| WA-6 | P1 | Live view and takeover | done |
| WA-7 | P0 | Routines integration | done |
| WA-8 | P0 | Actions config UI (PoC) | done |
| WA-9 | P0 | Packaging and security hardening (release blocker) | doing |
| WA-10 | P0 | Validation PoC: publish and read via configuration | todo |

WA-9 status: code hardening done (CORS allowlist, artifact/event bearer, SSE
sanitizing, Chromium via `executablePath`, prompt-injection fencing; CSRF Origin
check and PDF sandbox from the security review). Still open: running
`fetch-browser` + `electron-builder` packaging and signing (needs certificates,
see F5-4), the clean-account launch test, and the `app.flupcode.com` opt-in
decision. Manual E2E so far (editor CRUD, validate/preview/save, interactive
run with approval, auto-open live view, headless default, takeover/release/stop)
is green; the real-site run (WA-10) and a real scheduled run are pending.

---

## Sequencing rules

1. F0/F1 unblock everything; keep upstream sync green before starting F2.
2. F2 before F3: the shell is the substrate the parity features drop into.
3. F4 only after F3 parity passes the matrix in `docs/PARITY.md`.
4. F5 can start once F2 stabilises; desktop reuses the web renderer.
5. F6 is independent of F5 and can run in parallel once the web app is responsive.
6. F8: protocol (F8-2, F8-3) before relay and host; harness transport (F8-6) before the UI.
7. F9: WA-1 (runtime and boundary) before WA-2/WA-3 — the token and the SSRF guard land before any
   navigation. WA-9 is a release blocker; the PoC runs in development first.

---

## Blockers

As recorded in September 2026; the current blockers and risks are in AUDIT-2026-10 §21 and §22.

- **F3-16 Console org switch** — no console API in the v2 client.
- **F5-4 Signing/notarization** — requires Apple/Windows developer certificates and CI secrets; cannot be completed in-repo. WA-9 packaging (Chromium `extraResources` + signature check) waits on this too.
- **WA-9 leftovers (open, no ticket yet)** — `app.flupcode.com` stays denied for the harness (desktop-only browser use; decided); loopback token travels via argv/env (IPC delivery is future work); every `/harness` route but the health, a share link and the separately guarded adaptive surfaces asks for the bearer when a token exists (AH-A05), and fails open when no token is configured (explicit opt-in missing); a web tab without the desktop has no harness until a pairing flow exists (only `vite` dev injects the token).
- **WA E2E follow-ups (open, no ticket yet)** — second agent session on a project with a live browser gets `browser_busy`: decide reuse vs. actionable close/takeover; a real scheduled run end-to-end (WA-7 code is done and tested); the real-site publish+read run (WA-10).
- ~~`web-actions` branch — WA-0…WA-9 committed locally, not yet PR'd into `power`~~ — merged long since; `power` is now `main`.
- ~~F3-14 MCP manager — vendored client calls removed `/api/mcp`~~ — false: the engine serves `/mcp`; the harness uses it.
- ~~Share/unshare without endpoint~~ — false: `session.share/unshare` exist; the harness uses them.

### Engine API layer

Superseded: the app talks to the pinned OpenCode 2 engine through `@opencode/client` and FlupCode's
adapters only (ADR-0027); ADR-0009's `@opencode-ai/sdk` no longer applies.

## HF — High features (2026-09-20, PR #252)

`docs/tickets/HF-high-features.md`. This block was recorded as bringing Workflows, Runs, Artifacts
and Routines "to 100%". The October audit found that claim false: stopping a run did not stop the
agent, "success" meant "the session went idle", a handoff was lost at a gate, and resuming from a
checkpoint has no UI (§1 and §5.1 of AUDIT-2026-10; tickets TI-01 to TI-03, RP-01 to RP-07).

| ID | Ticket | Status |
| --- | --- | --- |
| HF-1 | Workflows: palette launch, run-until-task, checkpoint resume | done — checkpoint resume is Backend-only (§5.1) |
| HF-2 | Workflows: input defaults, specific validation errors | done |
| HF-3 | Workflows: `worktrees` in file, verify→recovery `when` | done |
| HF-4 | Runs: cancel a queued task from the supervisor | done |
| HF-5 | Runs: resume interrupted runs, restart requeues in-flight work | done — the notice, global pause and lock watch HF-5/HF-8 promised are Missing (§5.1) |
| HF-6 | Artifacts: cite inline by id, resolve `@artifact:` refs to content | done — in interactive chat `@artifact:` is UI-only, inserted as text (§5.1) |
| HF-7 | Artifacts: text search, `screenshot` kind, md/json export | done |
| HF-8 | Routines: run workflows with policy and inputs | done |
| HF-9 | Tool screens embedded in the main column, lifecycle nav order, clean topbar | done |

Out of scope on purpose: routine-finish push to mobile (crosses into `remote`; separate ticket).
