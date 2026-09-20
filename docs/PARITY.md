# Parity

What FlupCode's harness (`packages/harness`, plus `harness-desktop` and `remote`) does, measured
against the OpenCode engine it runs on (v1.18.30) and against OpenCode's own clients: the terminal
UI (`packages/tui`) and the official desktop/web app (`packages/app` + `packages/session-ui`).

This file used to compare the TUI with `packages/app` — upstream's client, not ours — so it read as
a nearly complete matrix of features FlupCode does not have. `docs/AUDIT-2026-09.md` (14 September 2026) checked every row against `packages/harness` and found F3-7, F3-8, F3-10, F3-13, F3-17,
F4-3, F4-5, F4-6 and F2-2 marked done while empty or broken. The matrix below is the corrected one:
every status refers to **FlupCode's harness**, and each claim points at the code that backs it.
Re-verified 2026-09-20 against `@flupcode/harness-server` 1.13.8 + HF-1–HF-9 (PR #252).

Legend: **✅** works end to end · **🟡** partial or worse than upstream · **🔌** the engine exposes it
and the harness does not use it · **❌** nobody has it · **➕** FlupCode has it and upstream does not

Paths are relative to `packages/`.

## 1. Shell, routing & navigation

| Feature                                                       | Upstream  | FlupCode | Evidence                                                                |
| ------------------------------------------------------------- | --------- | -------- | ----------------------------------------------------------------------- |
| Sidebar, top bar, right context panel                         | ✅        | ✅       | `harness/src/components/{Sidebar,Topbar,RightAside}.tsx`                |
| Tool screens in the main column, sidebar kept, nav active       | ❌        | ➕       | `RunsPanel/WorkflowsPanel/ArtifactsPanel/RoutinesPanel.tsx` in `fc-main`, `toolScreen()` |
| Side panels (browser, diff, terminal), split up to 4 sessions | 🟡 (tabs) | ➕       | `WorkspacePanels.tsx`, `split.ts`                                       |
| URL routing, session tabs, lineage breadcrumb                 | ✅        | ❌       | navigation is signals; only `?session=` and `#remote=`                  |
| Command palette                                               | ✅        | 🟡       | `CommandPalette.tsx`: commands, sessions, files, workflows; no split/rename/pin |
| Editable keybinds, leader key, which-key                      | ✅        | ❌       | only the palette key (`SettingsPanel.tsx`)                              |
| Phone layout, remote pairing, push, PWA                       | ❌        | ➕       | `remote/*`, `relay/*`, `flupcode-cli/*`                                 |

## 2. Session lifecycle

| Feature                                          | Upstream                   | FlupCode | Evidence                                                        |
| ------------------------------------------------ | -------------------------- | -------- | --------------------------------------------------------------- |
| New, list, switch, filter, pin, rename, delete   | ✅                         | ✅       | `app.tsx`                                                       |
| Fork, including from one message                 | ✅                         | ✅       | `client.session.fork({ messageID })`, `SessionView` fork action |
| Share / unshare                                  | ✅                         | ✅       | `client.session.share` → `/session/:id/share`                   |
| Move between projects                            | ✅                         | ✅       | `/experimental/control-plane/move-session`                      |
| Compact / summarize                              | ✅                         | 🟡       | compaction runs; no divider or summary in the timeline          |
| Undo / redo with file restore                    | ✅                         | 🟡       | `revert.stage/commit/clear`; no marker in the timeline, no redo |
| Archive, tags, server-side search, cursor paging | ✅                         | 🟡       | tags via `TagsDialog` + `/harness/session-prefs`; search/paging still unused |
| Export transcript                                | ✅ (Markdown with options) | 🟡       | Markdown, no options (`exportMarkdown`)                         |
| Engine-generated title                           | ✅                         | ✅       | the engine's title agent names the session on its first turn    |
| Session list cap                                 | paged                      | 🟡       | 200, no paging (`client.ts`)                                    |

## 3. Composer

| Feature                                                     | Upstream          | FlupCode | Evidence                                                       |
| ----------------------------------------------------------- | ----------------- | -------- | -------------------------------------------------------------- |
| `/` commands, `@file`, `!shell`, attachments, paste summary | ✅                | ✅       | `Composer.tsx`                                                 |
| Queue vs steer, with the badge saying which                 | ✅                | ✅       | `DeliveryMenu.tsx`, `pending-prompts.ts`                       |
| Agent / model / variant / permission-mode pickers           | ✅                | ✅       | `Composer.tsx`                                                 |
| `@agent`, `@mcp-resource`, file contents as a part          | ✅                | ❌       | `@path` inserts text only                                      |
| Skills as slash commands                                    | ✅                | 🟡       | `/name` asks the agent to load the skill; no skill manager     |
| External editor for the prompt, IDE selection context       | ✅                | ❌       | —                                                              |
| Prompt history                                              | ✅ (engine JSONL) | 🟡       | localStorage (`prompt-history.ts`)                             |
| Mobile composer                                             | n/a               | 🟡       | `MobileComposer.tsx` duplicates it without `/`, `@` or history |
| Voice dictation                                             | ❌                | ➕       | `dictation.ts` + the desktop speech helper                     |

## 4. Message rendering

| Feature                                       | Upstream           | FlupCode | Evidence                                                       |
| --------------------------------------------- | ------------------ | -------- | -------------------------------------------------------------- |
| Streaming markdown + highlighting             | ✅ (Shiki, worker) | ✅       | `@opencode-ai/session-ui`, mapped onto FlupCode's palette      |
| Tool renderers                                | ✅ (per tool)      | 🟡       | bash/edit/write; the rest show raw output (`SessionView.tsx`)  |
| Reasoning blocks                              | ✅                 | ✅       | collapsed by default in the transcript                         |
| Inline diff per edit + full diff viewer       | ✅ (Pierre)        | 🟡       | LCS diff on the main thread; the panel shows a raw patch       |
| Subagent cards, compaction and revert markers | ✅                 | ❌       | subagents are a row of chips (`SubagentList.tsx`)              |
| LSP diagnostics under edits                   | ✅                 | 🟡       | the runtime produces them; the transcript does not render them |
| Line comments on a diff                       | ✅                 | ✅       | own viewer anchors findings to the new file's line, resolve/reopen (`FileDiff.tsx`, H-32) |

## 5. Permissions & questions

| Feature                                                 | Upstream | FlupCode | Evidence                                                        |
| ------------------------------------------------------- | -------- | -------- | --------------------------------------------------------------- |
| Permission dock (once / always / reject)                | ✅       | ✅       | `PermissionDock.tsx`                                            |
| Previews of the command, the diff, the file             | ✅       | ✅       | `permission-preview.ts` reads the tool call from the transcript |
| Reason on reject                                        | ✅       | ✅       | `permission.reply({ message })`                                 |
| Saved "always" grants, listed and revocable             | ✅       | ✅       | `/api/permission/saved`, Settings → Remembered permissions      |
| Pending permissions across sessions                     | ✅       | ✅       | `/api/permission/request`, sidebar dot + top-bar count          |
| Rule editor (`allow`/`ask`/`deny` per tool and pattern) | ✅       | ❌       | modes only (`permission-modes.ts`)                              |
| Question dock                                           | ✅       | ✅       | `QuestionDock.tsx`                                              |

## 6. Agents, skills, commands, MCP

| Feature                                                   | Upstream | FlupCode | Evidence                                               |
| --------------------------------------------------------- | -------- | -------- | ------------------------------------------------------ |
| MCP: status, add local/remote, connect/disconnect         | ✅       | ✅       | `client.mcp.*` → `/mcp` + the configuration            |
| MCP: OAuth, per-server logs, resources, per-agent access  | ✅       | ❌       | `/mcp/:name/auth`, `/experimental/resource` unused     |
| Agent list and switch                                     | ✅       | 🟡       | the menu only appears with more than one primary agent |
| Subagents via the task tool, `subagent_depth`, background | ✅       | ✅       | Code runs on the legacy runtime, which has them        |
| Commands with agent/model/variant overrides, subtask      | ✅       | 🟡       | runs them, no overrides                                |
| Skill manager (sources, per-agent, install)               | ✅       | ❌       | `SkillsPanel.tsx` lists them and nothing else          |
| Editors for agents, commands, permissions, MCP            | ✅       | ❌       | raw JSON only (`ConfigPanel.tsx`)                      |
| Plugins: install and list                                 | ✅       | ❌       | —                                                      |

## 7. Files, terminal, git

| Feature                               | Upstream          | FlupCode | Evidence                                             |
| ------------------------------------- | ----------------- | -------- | ---------------------------------------------------- |
| Embedded terminal                     | ✅ (tabs, replay) | 🟡       | `Terminal.tsx`: one per panel, no tabs, no reconnect |
| File tree, viewer, text/symbol search | ✅                | 🔌       | `fs.list/read`, `find.text/symbols` unused           |
| Review panel per git / branch / turn  | ✅                | 🟡       | the Changes panel carries findings as line comments (H-32); no per-turn panel |
| Git: branch and +/-                   | ✅                | 🟡       | `RepoBar.tsx`; "Commit" sends a prompt               |
| Worktrees and workspaces              | ✅                | 🔌       | `/experimental/worktree` unused                      |

## 8. Reliability & security

| Feature                                              | Upstream                        | FlupCode | Evidence                                                     |
| ---------------------------------------------------- | ------------------------------- | -------- | ------------------------------------------------------------ |
| Event stream with heartbeat, idle timeout and resync | ✅                              | ✅       | `client.ts` drops a quiet stream; reconnecting resyncs       |
| Event-driven state                                   | ✅ (store)                      | ✅       | `transcript.ts` applies message events; one refetch per turn |
| Per-region error boundaries, stale-data notice       | ✅                              | ✅       | `PanelBoundary.tsx`, `resource.ts`                           |
| Permission defaults that only restrict               | ✅                              | ✅       | `permission-modes.ts`; bypass is explicit                    |
| Renderer sandbox and same-origin policy (desktop)    | ✅                              | ✅       | `harness-desktop`: `oc://renderer`, `sandbox: true`          |
| Engine password                                      | ✅ (`OPENCODE_SERVER_PASSWORD`) | ✅       | the desktop app sets one for the engine it starts            |
| Provider API keys kept out of the page               | ✅                              | ✅       | the client drops them from the provider directory            |

## 9. Settings, usage & operations

| Feature                               | Upstream | FlupCode | Evidence                                                                        |
| ------------------------------------- | -------- | -------- | ------------------------------------------------------------------------------- |
| Providers: API key + OAuth            | ✅       | ✅       | `ProvidersPanel.tsx`                                                            |
| Settings by section with real editors | ✅       | 🟡       | one panel plus a raw JSON editor                                                |
| Themes                                | ✅ (~40) | ❌       | two palettes and light/dark                                                     |
| Per-session context usage             | ✅       | ✅       | `ContextMeter.tsx`                                                              |
| Usage dashboard, activity heatmap     | ❌       | ➕       | `HomeCanvas.tsx` — but it downloads up to 30 transcripts to count               |
| Reply suggestions, Chat tab           | ❌       | ➕       | `reply-suggestion.ts`, `chat.ts` — one hidden child session per turn            |
| Artifacts, routines                   | ❌       | ✅       | routines run in the harness server with workflow+policy, history, resume; artifacts indexed with search/export/`@artifact` cites (HF-1–HF-9, 1.13.8) |
| Runs, verification, workflows         | ❌       | ✅       | runs with tasks, cancel/resume/retry/steer, `verify` with evidence and bounded retry, workflows with gates/until/inputs (1.10.0 + HF) |

## Where the work is

The audit's P0 block is done: the legacy runtime for Code (H-01 ✅), an event-driven store (H-02 ✅), a
resilient event stream (H-03 ✅), secure defaults (H-04 ✅), removing the placebos (H-05 ✅), adopting
`session-ui` (H-06 ✅ except the composer v2), queue and steer (H-07 ✅), complete permissions (H-08 ✅)
and error states (H-09 ✅).

Where `session-ui` was adopted, it pays: the transcript's markdown is upstream's renderer (Shiki in a
worker) and reasoning is back. The diff viewer and its line comments are FlupCode's own (H-06, H-32),
and adopting `session-ui` for them was **decided against** in H-32, with the obstacle measured:
`packages/session-ui` compiles under `@tsconfig/node22`, while the harness extends `@tsconfig/bun`,
which turns on `verbatimModuleSyntax` and `noUncheckedIndexedAccess`. The markdown entry point
satisfies both; `components/file.tsx`, `pierre/*`, and the `@opencode-ai/ui` components the line
comments pull in do not — and the repo does not touch upstream (ADR-0001). Taking them needs either
those two flags relaxed for the whole harness — 15k lines of its own code — or `session-ui` made to
compile under them upstream. Neither is worth a viewer whose job the own one already does.

Since 2026-09-16 the HF block (HF-1–HF-9, PR #252) closed the harness gaps: workflow palette
launch with run-until-task and checkpoint resume, input defaults with specific validation errors,
`worktrees` in the file, queued-task cancel, run resume with restart requeue, inline `@artifact:`
cites resolved to content, artifact text search + `screenshot` kind + md/json export, routines on
workflows with policy, and the four tool screens embedded in the main column with lifecycle nav
order and session chrome hidden like New.

`docs/ROADMAP.md` still describes the older plan. `docs/AUDIT-2026-09.md` §17 is the priced backlog
and supersedes it wherever the two disagree.
