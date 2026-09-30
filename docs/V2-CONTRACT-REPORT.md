# OpenCode V2 contract report

- **Ticket:** V2-06 in [V2-MIGRATION-AUDIT.md](V2-MIGRATION-AUDIT.md)
- **Date:** 2026-09-30
- **Engines:**
  - **v1:** this checkout's `packages/opencode` (1.18.32, upstream `dev@0f549842ee`).
  - **v2:** the pinned sandbox binary `@opencode/cli@2.0.20` (V2-05).
- **Source of every claim:** `packages/engine-contract`.
  - The v1 flows are in `test/contract.test.ts` and `test/plugins.test.ts`, with results in `fixtures/v1/`.
  - The same flows through OpenCode 2's API are in `test/contract-v2.test.ts`, with results in `fixtures/v2/`.
  - Run `bun run --cwd packages/engine-contract test:v2` to reproduce the v2 side.

## Summary

On OpenCode 2, FlupCode's contract fails at its first contact:
- **The event stream.** The per-folder `/event` stream the harness opens answers `200 text/html`.
- **The plugins.** All 14 engine plugins are discovered and refused.

Every flow FlupCode needs does exist on V2, and each one ran green through V2's own API against the same stub model and the same 1.x config, which V2 migrates in memory. The audit's §3 and §4 predictions held. There are four surprises, listed below, and one of them changes how V2-20 must fail.

## What FlupCode meets on V2 today

The 1.x suites (`contract.test.ts`, `plugins.test.ts`) pointed at the v2 engine both stop before any test runs. The cause: `recordEvents` refuses `GET /event?directory=` because it is `200 text/html`, not an event stream.

**Routes.** Each route FlupCode calls, as V2 answers it (`fixtures/v2/legacy-routes.json`, plus a wider probe):

| Route (1.x) | V2 answer |
|---|---|
| `GET /global/health`, `/event`, `/global/event`, `/path`, `/config`, `/global/config`, `/config/providers`, `/session/status`, `/session/:id/message`, `/session/:id/children`, `/session/:id/todo`, `/permission`, `/question`, `/mcp`, `/experimental/resource`, `/agent`, `/provider`, `/provider/auth`, `/vcs`, `/experimental/tool/ids`, `/experimental/console`, `/experimental/worktree` | **`200 text/html`**: the V2 web UI |
| `POST /session`, `/session/:id/prompt_async`, `/session/:id/abort`, `/config/reload`, `/global/dispose`; `PATCH /config` | `405`, empty body |
| `GET /api/health`, `/api/memory`, `/api/question/request` | `404` |
| `GET /api/session`, `/api/session/active`, `/api/event`, `/api/model`, `/api/agent`, `/api/mcp`, `/api/permission/request`, `/api/form`, `/api/info` | `200` JSON / event stream |

**Plugins.** They are discovered from `<config>/plugins/` and listed by `GET /api/plugin` as `failed` once the location has booted (`fixtures/v2/plugins.json`):

| Plugins | V2 error |
|---|---|
| 12 of them (all V1 `Hooks` exports) | `Plugin must export a default definition with an id and an effect or setup function.` |
| `flupcode-reasoning-variants.js` (embedded-v2 shape) | `TypeError: undefined is not an object (evaluating 'ctx.catalog.transform')` |
| `flupcode-deliver.js` | `Plugin failed to load` (see surprise 2) |

## Flow by flow

Each row compares `fixtures/v1/<flow>.json` with `fixtures/v2/<flow>.json`.

| Flow | 1.x | 2.x |
|---|---|---|
| **Send a turn** | `POST /session/:id/prompt_async {model, parts}` → 204 | `POST /api/session/:id/prompt {text}` returns the inbox item `{id, sessionID, type:"user", payload, delivery:"steer", time}` |
| **Stream** | `/event?directory=`: `message.part.delta`, `message.part.updated`, `message.updated`, `session.status`, `session.idle` | `/api/event` (global): `session.inbox.enqueued/delivered`, `session.execution.started/succeeded`, `session.step.started/streamed/ended`, `session.text.started/delta/ended`, `session.usage.updated`, `session.renamed`, `session.instructions.updated` |
| **End of turn** | `session.idle` | `session.execution.succeeded`, plus a durable `idle` message with `outcome: "succeeded"` |
| **Transcript** | `GET /session/:id/message`, oldest first: `user[text]`, `assistant[step-start, text, step-finish]` | `GET /api/session/:id/message`, **newest first**: `user`, `assistant{content:[text]}`, `idle` |
| **Assistant keys** | `agent, cost, finish, id, mode, modelID, parentID, path, providerID, role, sessionID, time, tokens` | `agent, content, cost, finish, id, model, rawFinish, time, tokens, type` |
| **Tool** | part `{callID, tool, state{input, metadata, output, status, time, title}}` | content item `{executed, id, name, state{content, input, metadata, status}}` |
| **Permission** | `permission.asked {always, id, metadata, patterns, permission, sessionID, tool{callID, messageID}}`; `GET /permission`; `POST /permission/:id/reply {reply:"once"}` | `permission.asked {action, id, resources, save, sessionID, source}`; `GET /api/session/:id/permission`; `POST …/permission/:id/reply {decision:"once"}` |
| **Question** | `question.asked {id, questions, sessionID, tool}`; `POST /question/:id/reply {answers:[["A"]]}` | `form.created {form{fields, id, metadata, sessionID, title}}`; the field is `{custom, description, key, options, title, type:"string"}`; `POST /api/session/:id/form/:formID/reply {answer:{q0:"A"}}` |
| **Abort** | `POST /session/:id/abort`; `session.error`; the assistant has `error{name:"MessageAbortedError", data}` | `POST /api/session/:id/interrupt` returns `{interrupted:true}`; `session.step.failed`, `session.execution.interrupted`; the assistant has `error{type, message}`; `idle` has `outcome:"interrupted"` |
| **Reads** | `/session/status` (map), `/mcp` (map), `/config` (merged object) | `/api/session/active`, `/api/mcp {location, data}`, `/api/config` (list of `directory`/`document` entries) |

## Audit predictions confirmed

- **Config compatibility.** V2 reads FlupCode's 1.x config as-is and migrates it in memory (§3.6):
  - a custom provider through `npm: "@ai-sdk/openai-compatible"`;
  - `model` and `small_model`;
  - `permission: {bash: "ask"}`, which became an ask rule on `shell`.
- **Event and API renames.** Every rename in §3.3 and §3.4 that these flows touch behaves as predicted: `session.next.*` → `session.*`, the inbox and execution lifecycle, forms, `decision`, `interrupt`, `location[directory]` / `x-opencode-directory`.
- **Plugin loader.** The V2 loader refuses the V1 plugin shape with the exact message quoted in §4.1, and `reasoning-variants` fails on the missing `ctx.catalog`.
- **No workspace or directory query.** V2 resolves the location from the `x-opencode-directory` header; no workspace is involved.

## Surprises

1. **Unknown routes answer `200 text/html`, not 404** (the audit said "removed").
   - **What happens:** every 1.x `GET` FlupCode makes returns the V2 web UI with a 200, and every write returns a bare 405.
   - **Why it matters:** FlupCode's generated client would try to decode HTML as JSON and fail with a parse error, not an HTTP error.
   - **What already copes:** V2-00's `detectEngine` requires a JSON body, and `probeEngineProfile` already treats non-JSON as "stock".
   - **What to change:** the V2 adapter (V2-20) must never fall back to a 1.x route on V2, and anything that probes by status code alone is wrong on V2.
2. **`flupcode-deliver.js` fails for a different reason.**
   - It is refused before the export check (`Plugin failed to load`), most likely because it imports `@opencode-ai/plugin`, which no longer exists: V2's package is `@opencode/plugin`.
   - The V2 plugin shell (V2-30) must not import the old package.
3. **The V2 transcript pages newest first.**
   - `GET /api/session/:id/message` returns the latest message first, with a cursor.
   - The V2 reducer (V2-21) has to reverse or page it; the 1.x route was oldest first.
4. **Built-in tool inputs changed with the names.**
   - `read` takes `path` (1.x `filePath`), and `bash` is `shell`.
   - FlupCode does not call tools itself, but its plugins match on tool names and arguments: `tool-uses` special-cases `bash` and reads `args.filePath`, and `session-metrics` and `compaction-anchors` match `read` with `args.filePath`. Their V2 ports need the new names.

Smaller observations:
- **Titles:** V2's title request uses a different prompt (`You are a title generator`) and emits `session.renamed`.
- **Plugin listing:** `GET /api/plugin` lists local plugins only after the location has booted, a moment after its first request.

## What this changes in the roadmap

- **V2-20 / V2-21:** use the flow table above as the adapter's contract. Add the "never fall back to 1.x routes on V2" rule (surprise 1) and newest-first paging (surprise 3).
- **V2-22:** the form field for a question is `type: "string"` with `options` and `custom: true`, not `multiselect`.
- **V2-30:** do not import `@opencode-ai/plugin` (surprise 2). Rename tool matches to `shell` and `path` (surprise 4).
  - `fixtures/v2/plugins.json` is the tripwire: when the V2 plugin shell ships, those entries must turn `active`, and the fixture must be rewritten on purpose.
- **Performance (V2-07):**
  - **Engine start to healthy:** about 0.3 s for the v2 binary and about 1.8 s for v1. This is not a fair comparison: v1 runs from source through `bun run`, v2 is a compiled binary. Measure v1 as a compiled binary before drawing conclusions.

## Reproduce

```bash
bun run --cwd packages/engine-contract opencode-v2 install   # pinned 2.0.20, verified, under ~/.cache/flupcode
bun run --cwd packages/engine-contract test:v2               # the v2 flows, against fixtures/v2
bun run --cwd packages/engine-contract test                  # the v1 flows, against fixtures/v1
FLUPCODE_CONTRACT_ENGINE="$(bun run --cwd packages/engine-contract opencode-v2 install | tail -1) serve --port {port} --hostname 127.0.0.1" \
  bun run --cwd packages/engine-contract test                # the v1 flows on v2: stops at /event
```
