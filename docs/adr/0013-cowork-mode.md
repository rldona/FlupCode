# ADR-0013: Cowork, a chat that can work in the project

- **Status:** Accepted
- **Date:** 2026-09-17

## Context

The chat tab is a conversation surface next to code sessions. Today a chat is a session whose
location is the engine's **state folder** (`enginePaths().state`, from `GET /path`), with every tool
denied except `webfetch` and `websearch`, and a conversational system prompt. See
`packages/harness/src/chat.ts`: `CHAT_PERMISSION`, `CHAT_SYSTEM` and `isChatSession`.

That design makes chat safe but useless for anything that has to touch the project. A reader asks
the agent to write an ADR and the agent answers, correctly, that it cannot create
`docs/adr/ADR-0001-...md` because it has no filesystem access. The conversation can produce the
text; it cannot deliver it.

Claude Code solves this inside the chat surface with **Cowork**: the same conversational mode, but
with project access and connectors. The toggle sits in the composer, next to the attachment button,
and picks which kind of conversation the next message starts.

The engine has no chat concept at all; chat is a harness convention layered on `session.location`.
So Cowork is also a harness convention, and this ADR decides how it is identified and what it may
do, without opening the session contract or a database migration.

## Decision

A conversation is one of two chat classes:

- **Chat** — no project. Lives in the engine state folder, all tools denied but the web ones, plain
  conversational prompt. Unchanged.
- **Cowork** — a chat that runs **in the selected project folder**, under the **same permission
  modes as Code**, with a conversational prompt that knows it can read, write and run things.

Both classes appear under the **Chat** tab. Cowork is not a third top-level tab.

### Identity

A Cowork session is a session in a project directory whose `agent` is the reserved id `cowork`.
`chat.ts` gains `isCoworkSession(session)`, and the harness resolves a session's class in one place:

```ts
type ChatClass = "chat" | "cowork"
// chat:   location.directory === enginePaths().state
// cowork: session.agent === "cowork"
```

The id is backed by a **native, hidden agent** in `packages/opencode/src/agent/agent.ts`:

- `mode: "primary"`, `hidden: true`, so the agent picker (`primaryAgents`, which filters `hidden`)
  never shows it and no reader has to understand it.
- Its permission ruleset is the engine `defaults` (project access), and the harness still applies
  the reader's permission mode with `setPermission`, exactly like Code.
- No prompt is required: the harness owns chat prompts and sends `COWORK_SYSTEM` as the legacy
  `system` override, the same mechanism plain chat uses.

Using an agent as the marker keeps the session durable and **shared by every client of the engine**
(the property `chat.ts` already documents), needs no schema field, no migration, and no regenerated
SDK. The alternative — a first-class `Session.Info` field such as `surface` — is more correct on
paper and far more expensive: schema, SQL, projector, protocol, generated clients and a DB
migration, all in upstream-owned files. That cost is not justified by one harness surface. If a
second surface ever needs to classify sessions, that contract change can supersede this decision.

### Mechanics

Cowork reuses the Code path with one difference, the system prompt:

- Location: `targetDirectory() ?? selectedSession()?.location?.directory`, the same resolution as
  Code. No folder means the folder picker appears, exactly as in Code. No fixed or per-chat folder.
- Permissions: `setPermission` with `permissionMode(permissionModeId()).rules`, the same modes Code
  offers (Ask/Auto/…). No separate Cowork permission set.
- Prompt: sent through the legacy runtime (`session.send`) with `agent: "cowork"`,
  `system: COWORK_SYSTEM` and the normal files/model. Because the runtime is the complete one, MCP
  servers, skills, subagents and the shell all work under the same permission modes. **Connectors are
  therefore permission-gated, not a separate feature**: Cowork exposes them through the existing
  tool and permission path. A dedicated connector manager is future work.
- Delivery: Cowork keeps Code's steer/queue delivery. The queued path is the harness's own
  (`pending-prompts.ts`), so the pending record carries the system prompt too; otherwise a queued
  Cowork message would be replayed later as an ordinary coding turn.

### Surface

- The composer gets a **Chat / Cowork segmented control** on the left, next to the attach button,
  matching Claude's placement. It chooses the class of the **next new conversation**; switching it
  while a session is open resets to that class's home with the draft kept.
- Chat keeps today's minimal composer: no folder, mode menu, agent menu, commands or mentions.
- Cowork shows the Code composer chrome it now earns: the folder picker (`FolderMenu`), the
  permission `ModeMenu`, the delivery menu, the repo bar and the context meter. `@`-mentions and
  attachments stay as they are. It also gets the Code side panels (files, browser, terminal) and the
  context panel, which the repo bar's commit and diff buttons act on. It hides the agent menu: the
  agent is fixed to the Cowork marker.
- The sidebar, search and palette show Cowork sessions in the Chat tab, with a small **Cowork**
  badge so a reader can tell a project-backed conversation from a plain one.
- The chosen class is remembered in storage next to the existing `view` and session keys.

## Consequences

- A reader can ask for an ADR in chat and have it written into the project, which is the need that
  motivated this ADR, without learning the Code tab's chrome.
- Plain chat stays exactly as safe as it was: Cowork is opt-in and clearly labelled.
- Permissions are the only gate on project access, so a reader who picks a dangerous mode in Cowork
  gets dangerous access. That is the same trust model as Code, and the mode menu already confirms
  dangerous picks.
- Cowork sessions are ordinary sessions in the project; they are persisted, searchable and visible to
  any client of that engine, and their class is stable across reloads.
- The marker is an agent id, which is a slight semantic stretch: `agent` means "which agent", and
  here it also means "which chat surface". It is contained to `chat.ts` and one native agent entry.
- Contained upstream diff: one native agent in `packages/opencode`, and harness-only changes
  otherwise. No schema, protocol, generated-SDK or database changes.
- Future work: a first-class session surface field, per-conversation folders, a connectors manager,
  and surfacing Cowork in the TUI.

## Implementation plan

1. **Engine agent.** Add the hidden native `cowork` agent to
   `packages/opencode/src/agent/agent.ts` with the `defaults` permission ruleset and no prompt.
2. **Chat model.** In `chat.ts` add `ChatClass`, `COWORK_AGENT` (`"cowork"`), `COWORK_SYSTEM`, and
   `isCoworkSession`. Add unit coverage in `chat.test.ts`.
3. **Classification.** In `app.tsx` replace the boolean `isChat` with `chatClass(session)` (or
   `isChatLike`), and update `viewSessions`, the two `kind: AppView` effects, the palette filter at
   ~line 2138 and the `project: undefined` mapping at ~line 2146.
4. **Send path.** Generalise `submitPrompt` to take an optional agent and system prompt, add
   `sendCowork` on top of it, thread the system prompt through `pending-prompts.ts`, and branch
   `send`/`retryTurn`/`SessionPane.send` on the selected session's chat class.
5. **Composer.** Add the Chat/Cowork segmented control, branch the folder/mode/agent/context-meter
   `Show` conditions on the class, and thread the new props through `app.tsx` and `MobileComposer`.
6. **Chrome and labels.** Cowork badge in `Sidebar`, `RemoteHome`, session titles and search; i18n
   strings for `Cowork`, its system prompt-adjacent labels and the empty state.
7. **Verify.** `bun typecheck` and the harness tests from `packages/harness` (`bun test`), plus the
   relevant Playwright specs. Run the engine from `packages/opencode` only if an agent-level test is
   needed.
