# ADR-0026: What FlupCode does about the features OpenCode 2 removed

- **Status:** Accepted
- **Date:** 2026-10-01
- **Related:** `docs/V2-MIGRATION-AUDIT.md` (V2-42, "Removed" rows of the API table, point 8 of the
  inventory), ADR-0013 (Cowork), H-18 (archiving), H-33 (replay), UN-1 (taking a prompt back)

## Context

OpenCode 2 drops several things FlupCode shows on 1.x. The 2.x adapter (`engine/v2.ts`) already
answers each of them with `unsupported(...)` (an `EngineError` tagged `UnsupportedByEngine`) or an
empty list, so nothing crashes; but an action that is offered and then refused is worse than one that
is not offered. V2-42 asks for one decision per feature, recorded here.

## Decision

Each feature is either hidden on 2.x or left as it is because it already reads correctly. The app
asks `health().line === "v2"` (`engineV2()` in `app.tsx`); nothing is rebuilt on a plugin for now.

| Feature (1.x)                                  | On 2.x                                  | Decision                                                                                                                                                                                                 |
| ---------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks aside (`todowrite`, `/session/:id/todo`) | No todo tool, no route                  | **Hidden.** The aside keeps Subagents and Memory; the Tasks section is not drawn (`RightAside` `tasks`). Rebuilding it as a plugin tool is possible (V2-30 showed the shape) but nothing asks for it yet |
| Share / Stop sharing                           | No share route or service               | **Hidden** from the session menu. Export MD stays as the way to hand a session to someone                                                                                                                |
| Archive / Unarchive (H-18, `time.archived`)    | The session record has no archived time | **Hidden** from the sidebar menu and the launcher (`archive`). The "show archived" toggle already appears only when something is archived                                                                |
| Replay (H-33, the durable session history)     | No 1.x replay history                   | **Hidden** from the launcher (`replay`)                                                                                                                                                                  |
| Take a prompt back (UN-1, deleting messages)   | No message delete                       | **Hidden** (the user message's recall button). Edit, which reverts, stays                                                                                                                                |
| LSP diagnostics and symbol search              | Removed                                 | **Nothing to do:** the UI never called them. The `lsp` permission key the config editor lists is ignored by 2.x                                                                                          |
| Console org switching                          | `/experimental/console` removed         | **Nothing to do:** the adapter lists no orgs, so the switcher has nothing to show                                                                                                                        |
| `vcs apply`                                    | `/api/vcs*` has no apply                | **Nothing to do:** the UI never applied a patch through the engine                                                                                                                                       |

## Consequences

- On 2.x no menu offers an action the engine refuses. On 1.x nothing changes.
- The adapter keeps its `unsupported(...)` answers as the safety net for any caller that is missed.
- A feature brought back on 2.x (a todo plugin tool, a share service) removes its row here and its
  `engineV2()` check in the same change.
