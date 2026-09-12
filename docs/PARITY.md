# Parity

Feature parity between the OpenCode terminal UI (`packages/tui`) and the web/desktop UI
(`packages/app`, `packages/session-ui`). This matrix is the output of ticket `F0-1` and the source
of truth for `F3`.

Legend: **✅ parity** · **🟡 partial** · **❌ missing** · **➕ OpenHarness extra** (not in TUI)

## 1. Shell, routing & navigation

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Home screen | `routes/home.tsx` | `pages/home.tsx`, `pages/home/*` | ✅ |
| Session screen | `routes/session/index.tsx` | `pages/session.tsx` | ✅ |
| Sidebar / session rail | `routes/session/sidebar.tsx` | `pages/layout/sidebar-*.tsx` | ✅ |
| Window chrome, back/forward history | n/a (terminal) | `components/titlebar*.tsx` | ✅ |
| Tab strip for sessions/files | n/a | `components/titlebar-tab-strip.tsx` | ✅ |
| Project/workspace rail | `context/project.tsx` | `pages/layout/sidebar-project.tsx` | ✅ |
| Mobile/responsive drawer | n/a | `pages/layout.tsx`, `components/ui/drawer.tsx` | ✅ |
| Harness layout (nav: Artefactos/Rutinas/Personalizar) | ❌ | ❌ | ➕ F4 |

## 2. Session lifecycle

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| New / clear | `/new` | present | ✅ |
| List / switch / search | `/sessions` | present | ✅ |
| Pin / quick slots | `ctrl+f`, `<leader>1..9` | sidebar notification badges; no quick slots | 🟡 |
| Rename | `/rename`, `ctrl+r` | timeline title editor | ✅ |
| Delete (with confirm) | `ctrl+d` | `DialogDeleteSession` | ✅ |
| Archive | — | archive action exists; home affordance disabled (`SHOW_HOME_SESSION_ARCHIVE=false`) | 🟡 |
| Fork from message | `/fork` | `dialog-fork.tsx` | ✅ |
| Compact / summarize | `/compact` | `use-session-commands.tsx` | ✅ |
| Undo / redo | `/undo`, `/redo` | revert dock + commands | ✅ |
| Timeline jump | `/timeline` | message navigation / hash scroll | 🟡 (no dedicated dialog) |
| Move session between locations | `/move`, `dialog-move-session.tsx` | ❌ | ❌ → F3 |
| Session tags/labels | `dialog-tag.tsx` | ❌ | ❌ → F3 |
| Prompt stash | `dialog-stash.tsx` | ❌ | ❌ → F3 |
| Background subagents | `ctrl+b` | subagent session tabs | ✅ |
| Parent/child session nav | present | `session-lineage.ts` | ✅ |

## 3. Composer / prompt input

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Text composer, auto-resize | `component/prompt/index.tsx` | `prompt-input-v2.tsx` | ✅ |
| `@` file/reference/agent/MCP mentions | `prompt/autocomplete.tsx` | `v2/.../interaction.ts` | ✅ |
| `!` shell mode | present | `machine.ts`, `submit.ts` | ✅ |
| `/` slash commands | autocomplete | legacy + v2 popovers | 🟡 (v2 lacks skill/MCP source badges) |
| Image/file/PDF attachments | clipboard + drag/drop | `image-attachments.tsx`, drag overlay | ✅ |
| Attachment cards/preview | inline | `attachment-card-v2.tsx` | ✅ |
| External editor | `/editor` | open-in-app for files; no prompt editor bridge | 🟡 |
| Editor selection context (IDE/Zed) | `context/editor.ts` | ❌ (web) | ❌ → F3 (desktop later) |
| Prompt history | persistent JSONL | `prompt-input/history.ts` | ✅ |
| Paste summarization | `[Pasted ~N lines]` | ❌ | ❌ → F3 |
| Queued / steer prompts | durable admission + QUEUED badge | follow-up dock + queue setting | ✅ |
| Model selector + favorites | `/models` | model dialogs | ✅ |
| Agent selector / cycle | `/agents`, `tab` | `context/local-agent.ts` | ✅ |
| Variant / thinking effort | `ctrl+t` | `context/model-variant.ts` | ✅ |
| Auto-approve permission mode | `permission.mode` | `context/permission.tsx` | ✅ |
| Voice / dictation | ❌ | ❌ | ➕ F4 (screenshot) |
| Context chips (Local / "Sin carpeta") | n/a | workspace selector only | ➕ F2 |

## 4. Message rendering

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Streaming markdown + code highlight | tree-sitter | worker markdown + Shiki/Pierre | ✅ |
| Reasoning/thinking blocks | collapsible | `showReasoningSummaries` | ✅ |
| Tool renderers (bash/read/grep/glob/web/edit/write/task/todo/skill) | specialized | `ToolRegistry` | ✅ |
| Tool details toggle / default-open | `/details` | settings + per-part toggle | ✅ |
| Diffs (inline + full-screen viewer) | `diff-viewer.tsx` | `session-review*.tsx`, Pierre | ✅ |
| Diagnostics under edits | present | present | ✅ |
| Todo list / dock | inline | todo dock | ✅ |
| Subagent task display | present | task card + progress | ✅ |
| Compaction divider | present | present | ✅ |
| Revert/undo marker | present | revert dock | ✅ |
| Copy message / transcript / export | `/copy`, `/export` | copy + JSON export | 🟡 (no Markdown transcript export options) |
| Message in-place editing | ❌ | ❌ (revert/fork only) | ➕ F4 |
| Mermaid | ❌ | ❌ | ➕ F4 (optional) |
| Toggle "steps" | `/details` | orphan i18n key only | ❌ → F3 |

## 5. Commands, keybinds & palette

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Command palette | `ctrl+p` | `dialog-command-palette-v2.tsx` | ✅ |
| Command registry + keybind matching | `keymap.tsx` | `context/command.tsx` | ✅ |
| Leader key | `ctrl+x` | n/a (uses mod-based bindings) | 🟡 (by design) |
| Which-key / shortcuts overlay | `which-key.tsx` | settings → Shortcuts | 🟡 |
| Custom/editable keybinds | `tui.json` | `settings-keybinds.tsx` | ✅ |
| Server/MCP slash commands | present | present | ✅ |
| Skills autocomplete (`/skills`) | `dialog-skill.tsx` | i18n badge only | ❌ → F3 |

## 6. Permissions, questions & attention

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Permission prompt (once/always/reject) | `routes/session/permission.tsx` | `session-permission-dock.tsx` | ✅ |
| Rich permission previews (diff/read/bash) | present | present | ✅ |
| Auto-accept / rules | `permission.mode` | `permission-auto-respond.ts` | ✅ |
| Question wizard (multi-select/custom) | `routes/session/question.tsx` | `session-question-dock.tsx` | ✅ |
| OS notifications | `attention.ts` | `context/platform.tsx` | ✅ |
| Sounds / sound packs | `tui.json` + packs | `utils/sound.ts` + bundled sounds | ✅ |
| Notification badges | footer counter | sidebar/home dots | ✅ |

## 7. Model / agent / theme / providers

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Model list + favorites + recents | `dialog-model.tsx` | model dialogs | ✅ |
| Provider connect (OAuth + API key) | `dialog-provider.tsx` | `dialog-connect-provider.tsx` | ✅ |
| Custom provider | present | `dialog-custom-provider.tsx` | ✅ |
| Agent list/switch | `dialog-agent.tsx` | present | ✅ |
| Theme list + live preview | `dialog-theme-list.tsx` | theme engine + settings | ✅ |
| Light/dark/system + lock | `theme.tsx` | settings → General | ✅ |
| ~30–40 bundled themes | `theme/assets` | `packages/ui/src/theme/themes` | ✅ |
| Console org switch | `/org` | ❌ | ❌ → F3 (low priority) |

## 8. Terminal, files & context

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Embedded terminal / PTY | external | `components/terminal.tsx` + tabs | ✅ |
| File tree / browser | diff viewer tree | `file-tree-v2.tsx`, file browser tab | ✅ |
| File viewer + search | present | `session-ui/file.tsx` | ✅ |
| Review panel (git/branch/turn) | diff viewer | `review-panel-v2.tsx` | ✅ |
| Line comments / annotations | ❌ | `context/comments.tsx` | ➕ |
| Add selection to context | present | `context.addSelection` | ✅ |
| Status: MCP / LSP / formatter / plugins | `/status` | `status-popover.tsx` | ✅ |
| MCP toggle | `dialog-mcp.tsx` | `dialog-select-mcp.tsx` | ✅ |
| MCP add/configure | ❌ | ❌ (toggle only) | ❌ → F3 |
| LSP/formatter status detail | sidebar panels | status popover | ✅ |

## 9. Settings & configuration

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Settings entry | command palette | `settings-dialog.tsx` | ✅ |
| General (language, shell, behavior, notifications) | `tui.json` | `settings-v2/general.tsx` | ✅ |
| Providers / Models | dialogs | `settings-v2/providers.tsx`, `models.tsx` | ✅ |
| Servers (add/edit/remove/default) | n/a | `settings-v2/servers.tsx` | ✅ |
| Shortcuts editor | `tui.json` | `settings-keybinds.tsx` | ✅ |
| Permissions editor | `tui.json` | i18n only | ❌ → F3 |
| Agents editor | config files | i18n placeholder | ❌ → F3 |
| Commands editor | config files | i18n placeholder | ❌ → F3 |
| MCP editor | config files | i18n placeholder | ❌ → F3 |
| Raw `opencode.json` editor | external | ❌ | ❌ → F4 (optional) |

## 10. Operations & sharing

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Share / unshare | `/share`, `/unshare` | share popover | ✅ |
| Public share viewer | n/a | `packages/web/src/components/Share.tsx` | ✅ |
| Export transcript | `/export` (Markdown + options) | JSON export | 🟡 |
| Copy transcript | `/copy` | copy message | 🟡 |
| Server connect / switch | n/a | `context/server.tsx` | ✅ |
| In-app `serve` / tunnel management | n/a | ❌ (CLI only) | ❌ → F6 |
| Update prompt | present | desktop updater | ✅ |

## 11. Usage, stats & analytics

| Feature | TUI | Web/Desktop | Status |
| --- | --- | --- | --- |
| Per-session context usage (tokens/cost/cache) | sidebar | `session-context-usage.tsx`, context tab | ✅ |
| Per-session token breakdown | sidebar | `session-context-breakdown.ts` | ✅ |
| Global usage dashboard (sessions/messages/tokens/streaks/peak hour/favorite model) | ❌ | ❌ | ➕ F4 |
| Activity heatmap | ❌ | ❌ | ➕ F4 |
| Usage comparisons ("x× más tokens que…") | ❌ | ❌ | ➕ F4 |

## Gap summary (the actual work for F3/F4)

**Missing vs TUI (F3):**
1. Move session between locations.
2. Session tags/labels.
3. Prompt stash.
4. Skill manager/autocomplete in v2 composer.
5. Paste summarization.
6. Markdown transcript export with options.
7. MCP add/configure (beyond toggle).
8. Settings editors for permissions, agents, commands, MCP.
9. "Toggle steps" command (orphan i18n).
10. Console org switch (low priority).

**OpenHarness extras (F2/F4, not in TUI):**
1. Harness shell layout + sidebar nav (Artefactos, Rutinas, Personalizar).
2. Composer context chips (Local / no-folder), voice input.
3. Global usage dashboard + activity heatmap + comparisons.
4. Artifacts.
5. Routines (scheduled tasks).
6. In-place message editing (optional).
7. Remote/mobile PWA + QR pairing + push (F6).
