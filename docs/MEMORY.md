# Memory

FlupCode remembers useful knowledge about your projects, repositories, agents, and preferences so a
new session does not have to rediscover it. This document explains what is remembered, how it is
retrieved, and how to control it.

Memory is **not** a transcript and **not** a single `memory.md` pasted into every prompt. It is a
retrieved knowledge layer: only the handful of memories relevant to the current request are added to
the model's context, within a token budget.

## What belongs where

| Layer           | Author                     | Loading                | Example                                       |
| --------------- | -------------------------- | ---------------------- | --------------------------------------------- |
| Instructions    | you, versioned in the repo | always on              | `Never modify generated files.`               |
| Permissions     | you                        | always on, enforced    | `deploy` requires approval                    |
| Skills          | you                        | on demand              | how to run a production release               |
| **Memory**      | the harness and you        | retrieved by relevance | `Production deploy uses ./scripts/release.sh` |
| Session history | the harness                | compacted              | the current conversation                      |

Use instructions for rules you want followed unconditionally. Use memory for knowledge FlupCode
learned or that you asked it to keep. Memory never overrides instructions or permissions.

## Scopes

| Scope     | Applies to                | Example                                   |
| --------- | ------------------------- | ----------------------------------------- |
| `global`  | you, across every project | `I prefer concise commit messages.`       |
| `project` | one repository/worktree   | `This project uses pnpm.`                 |
| `agent`   | one agent in a project    | `The test agent uses Playwright.`         |
| `session` | the current session only  | `During this session we are migrating X.` |

Global and project memories are shared by every agent. Agent memories are private to that agent.
Session memories are never promoted automatically; you can promote one from the manager.

## How FlupCode learns

1. **You ask it to.** Write `Remember that this project uses pnpm.` or `No olvides que production
no se despliega a mano.` FlupCode captures the clause immediately and infers the scope from the
   wording (`this project` → project, `I prefer` → global, `the release agent` → agent).
2. **The agent decides to.** An agent can call the `memory` tool to add, update, forget, or list
   memories when it discovers something durable.
3. **Background extraction.** After a session goes idle, FlupCode can summarize the recent turns
   with the configured small model and store new knowledge as **candidates**. Candidates are never
   used automatically until you approve them (or they come from an explicit instruction).

FlupCode deliberately ignores logs, stack traces, generated code, one-off errors, and ordinary
question/answer chatter. When in doubt, it stores a candidate for you to review rather than silently
trusting it.

## Configuration

Configuration lives in `opencode.json`/`opencode.jsonc` (project or global):

```jsonc
{
  // Optional: model used for background extraction (defaults to `small_model`).
  "small_model": "anthropic/claude-haiku-4-5",
  "memory": {
    "enabled": true,
    "auto": true,
    "model": "anthropic/claude-haiku-4-5",
    "max_injected": 8,
    "max_tokens": 1000,
    "stale_after_days": 90,
    "extract_interval": 30,
    "max_candidates_per_session": 20,
  },
}
```

- `enabled` turns reading and writing off.
- `auto` controls implicit extraction. It is skipped when no memory/small model is configured.
- `model` overrides `small_model` for extraction.
- `max_injected` / `max_tokens` bound what one turn receives.
- `stale_after_days` controls opportunistic re-verification.

## Validation, decay, and conflicts

- A memory about a file, directory, command, or URL is **verifiable**. `Verify` re-checks its
  anchors; a missing file marks it `stale`.
- Confidence decays with age since last use/validation. Stale memories are demoted and only injected
  with a warning when nothing else matches.
- When two active memories contradict each other (same scope, shared tags, opposite tool or
  polarity), only the stronger one is injected; the other is marked superseded.
- When a memory contradicts an instruction, the instruction wins and the manager shows the conflict
  so you can update the instruction yourself.

## Managing memory

Open the command palette and run **Memory** (or the memory command). The manager lets you:

- search and filter by scope and status;
- read the content, source, confidence, use count, and last-used time;
- edit content and title, verify anchors, approve candidates, or delete;
- add a memory manually.

The context panel of a session shows a **Memory** section listing the memories that were retrieved
for that session, so you can see what the agent is relying on.

## HTTP API

The `server.memory` group is part of the public `HttpApi` and is available in the generated clients:

| Operation       | Route                                |
| --------------- | ------------------------------------ |
| `memory.list`   | `GET /api/memory`                    |
| `memory.get`    | `GET /api/memory/:id`                |
| `memory.create` | `POST /api/memory`                   |
| `memory.update` | `PATCH /api/memory/:id`              |
| `memory.remove` | `DELETE /api/memory/:id`             |
| `memory.verify` | `POST /api/memory/:id/verify`        |
| `memory.used`   | `GET /api/memory/session/:sessionID` |

## Limitations

- Retrieval is lexical and deterministic today; semantic/embedding retrieval is planned behind the
  same interface.
- Automatic extraction needs a configured small model; without one, only explicit instructions and
  the `memory` tool write memories.
- Cross-device memory sync is not implemented; memory lives in the engine's database.
- Concurrent edits from several clients are last-write-wins.
