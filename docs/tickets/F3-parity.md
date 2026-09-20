# F3 — TUI parity

Goal: every P0/P1 row in `docs/PARITY.md` is parity. The matrix is the acceptance gate.

Many features already exist in `packages/app` / `packages/session-ui`; in those cases the work is
porting/adapting them into `packages/harness`, not rebuilding.

## F3-1 — Slash commands + command palette · P0 · todo

**Acceptance**
- All TUI slash commands reachable, plus server/MCP/custom commands.
- Palette searches commands, sessions and files.

## F3-2 — `@` mentions and `!` shell · P0 · todo

**Acceptance**
- `@` fuzzy files, references, agents, MCP resources; line ranges supported.
- `!` runs a shell command via `session.shell`.

## F3-3 — Permissions & questions · P0 · todo

**Acceptance**
- Approve once/always/reject with rich previews (diff, read, bash).
- Multi-question wizard with multi-select and custom answers.
- Auto-accept mode toggle.

## F3-4 — Undo/redo, revert, fork, compact · P0 · todo

**Acceptance**
- Undo/redo restores messages and files; prompt is restored.
- Fork from message; compact uses the current model.

## F3-5 — Sessions, share, export · P0 · todo

**Acceptance**
- List/switch/create/rename/delete/archive.
- Share/unshare; export session.

## F3-6 — Agents, subagents, todos · P0 · todo

**Acceptance**
- Agent switch/cycle; plan/build auto-switch.
- Subagent sessions openable; todo dock.

## F3-7 — Move session between locations · P1 · todo

**Acceptance**
- Move a session to another project/workspace; file-change confirmation.

## F3-8 — Session tags/labels · P1 · todo

**Acceptance**
- Create/assign/filter tags; persisted with the session.

## F3-9 — Prompt stash · P1 · todo

**Acceptance**
- Stash/pop/list prompts with persistence.

## F3-10 — Skill manager + slash sources · P1 · todo

**Acceptance**
- `/skills` dialog inserts a skill command.
- v2 composer shows skill/MCP source badges.

## F3-11 — Paste summarization · P1 · todo

**Acceptance**
- Large pastes collapse to `[Pasted ~N lines]`, expand on submit.

## F3-12 — Markdown transcript export · P1 · todo

**Acceptance**
- Export with options (thinking/tool details/metadata); copy transcript.

## F3-13 — Settings editors · P1 · todo

Permissions, agents, commands and MCP editors.

**Acceptance**
- Each editor reads/writes the corresponding config.
- Validation and defaults match the engine.

## F3-14 — MCP add/configure · P2 · todo

**Acceptance**
- Add and configure MCP servers from the UI, not just toggle.

## F3-15 — "Toggle steps" command · P2 · todo

**Acceptance**
- The orphan `command.steps.toggle` i18n key is wired to a real command.

## F3-16 — Console org switch · P2 · todo

**Acceptance**
- Switch console organization when multiple exist.

## F3-17 — Keybind/leader parity · P2 · todo

**Acceptance**
- Terminal-equivalent actions reachable via configurable bindings where sensible; leader-key
  semantics are not required (see ADR-0006).
