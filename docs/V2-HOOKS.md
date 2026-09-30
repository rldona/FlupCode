# V2 hook contingency

- **Ticket:** AH-D05 (Phase D, "Session weight"), from the 2026-09-30 engineering audit, §2.5.
- **Status:** reviewed mapping, at commit `370412ba0f` (`power`).
- **Scope:** the engine plugins that act or measure for AutoHarness: A11 (`RELEVANCE_PLUGIN`),
  B01 (`SESSION_METRICS_PLUGIN`), D02 (`TOOL_TRIM_PLUGIN` plus the `evidence_read` tool) and D03
  (`CACHE_SELECTION_PLUGIN` in `experimental.chat.messages.transform`, a PoC off by default). The
  runtime probe and the guardrails plugin are listed too, because the alert depends on the first
  and the second shares A11's exposure.

## Summary

The V2 session runner (`SessionV2` → `SessionExecution` → `SessionRunner`) **calls none of the
legacy plugin hooks** these plugins use. The only V1 plugin surface that still reaches a V2 turn is
the generic `event` hook, because it listens on the process-global event bus that the V2 runner
publishes `session.next.*` events to. V2 also has **no way for a plugin to register a tool**.

| Plugin | Hooks | On V2 |
|---|---|---|
| A11 relevance | `messages.transform` | **Missing.** Stays inert, fails safe. |
| B01 session metrics | `event` (`message.*` and `session.next.*`) | **Works, probably.** Not confirmed at runtime. |
| D02 tool trim + `evidence_read` | `tool.execute.after`, plugin `tool` | **Missing.** Tool output enters history untrimmed. |
| D03 cache-aware selection | `messages.transform` | **Missing.** There is no V2 seam; the policy gate stays closed. |

So everything that *acts* depends on V1. Measurement survives. The mitigation is the probe
alert described at the end: the harness notices when the engine moves and says so in the UI. It
does not try to act on V2.

## How the two runners are reached

- **Both engines run in the same server process, and there is no flag that chooses between them.**
  The route the client calls decides which runner serves a turn.
  - V1 serves `/session/:id/message` through `SessionPrompt`
    (`packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:52`).
  - V2 serves `/api/session/:sessionID/prompt` (`packages/protocol/src/groups/session.ts:205`).
    It then goes through `SessionV2.prompt` → `execution.wake` (`packages/core/src/session.ts:382`)
    → `runner.run` (`packages/core/src/session/execution/local.ts:20`).
- **The harness drives V1.** Every run's turn goes through the legacy `/session/:id/message`
  (`packages/harness-server/src/engine.ts:150-157`).
  - So today "the engine switched to V2" means one of two things: a client (or a future harness)
    calls the V2 route, or upstream retires V1.
  - A mixed process is possible, with some sessions on V1 and some on V2. The probe alert has a
    case for it (`v2-turns-observed`).
- **How V1 fires a hook:** `Plugin.trigger` (`packages/opencode/src/plugin/index.ts:284-296`) runs
  every loaded hook as `fn(input, output)`, in order. A plugin acts by mutating `output`.
- **The V2 runner has no hook calls.** The runner is `packages/core/src/session/runner/llm.ts`.
  - A search for `plugin|hook|trigger` across `core/src/session/**`, `core/src/tool/registry.ts`,
    `core/src/system-context/`, `core/src/permission.ts` and `core/src/session/compaction.ts` finds
    only comments.
  - The runner's own checklist lists "plugin … tool definitions" (`llm.ts:67`) and "plugins"
    (`llm.ts:78-79`) as not done.
- **V2's plugin loader expects a different shape.** A V2 plugin is `{ id, effect }` or
  `{ id, setup }` (`packages/core/src/config/plugin/external.ts:15-30`).
  - Its context offers `options`, `agent`, `aisdk`, `catalog`, `command`, `integration`, `plugin`,
    `reference` and `skill` (`packages/plugin/src/v2/effect/context.ts:12-22`).
  - It has no session, tool, message or event hooks.

## Hook map

**Status:**

- **works**: the V2 runner produces the same signal.
- **degraded**: a partial or unconfirmed equivalent exists.
- **missing**: no equivalent in V2.

**Plugin line numbers** refer to `packages/remote/src/engine-plugins.ts` at the commit above. The D01, D02 and D04 work edits that file in parallel, so search by constant name.

| Plugin | V1 hook (evidence) | V2 equivalent | Status | Fallback when it does not fire |
|---|---|---|---|---|
| A11 `RELEVANCE_PLUGIN` | `experimental.chat.messages.transform` to read the objective, ask once per user turn and append the pinned line to that turn's user message (search `flupcodeRelevance`; ADR-0024 §7). Fired by `session/prompt.ts:1255` with `{ messages }`, and by `session/compaction.ts:379`. It no longer uses `system.transform`. | None. V2 builds messages directly from `toLLMMessages(context, model)` (`core/src/session/runner/llm.ts:242`). | missing | No objective, no request and no line: the turn is byte-identical. Server-side, `relevance.ts` already answers inert with `runtime-not-legacy` when the probe does not read `legacy`. **This fails safe.** |
| B01 `SESSION_METRICS_PLUGIN` | `event`: `message.updated` and `message.part.updated` (plugin `:1957-2046`). Published by V1 only, at `packages/opencode/src/session/session.ts:631` and `:637`. | `event`: `session.next.prompted`, `step.started`, `step.ended` (carries `tokens` and `cost`), `tool.called`, `tool.success` (carries `content`), `tool.failed` and `compaction.ended`. Defined at `packages/schema/src/session-event.ts:88`, `:150`, `:163`, `:313`, `:343`, `:360` and `:421`. The plugin already reads them (`:2049-2105`). | degraded (likely works) | Each observation is independent and fire-and-forget. A missing event leaves a gap in the baseline, not a failure. See the delivery caveat below. |
| D02 `TOOL_TRIM_PLUGIN` (planned) | `tool.execute.after` with a mutable output `{ title, output, metadata }` that is persisted. Fired by `session/tools.ts:121` (registry tools), `:208`, `:291`, `:373` and `:420` (MCP), `session/prompt.ts:389` (subtask) and `tool/code-mode.ts:180`. | None. V2 settles tools through its own registry: `toolMaterialization.settle` (`llm.ts:283`) → `core/src/tool/registry.ts:50-82`. This never passes through `Plugin.trigger`. | missing | Output enters history untrimmed. The engine's own `tool_output.max_lines` / `max_bytes` limits (config, D01) are the only bound. Observing `session.next.tool.success` can measure size but cannot mutate it. |
| D02 `evidence_read` tool (planned) | Plugin `tool` field. V1 registers it at `packages/opencode/src/tool/registry.ts:200-204` via `fromPlugin` (`:126-160`). | None for V1-style plugins. V2 tools register through `Tools.Service.register` (built-ins, e.g. `core/src/tool/read.ts:39`) or `ApplicationTools`, which only `sdk-next` exposes (`packages/sdk-next/src/opencode.ts:18`). | missing | No tool. Any `evidence:<ref>` stub V1 left in history cannot be dereferenced on V2. D02 must therefore never trim on a turn it cannot also serve, which the probe gate gives it. |
| D03 `CACHE_SELECTION_PLUGIN` (PoC, off by default, [ADR-0024](adr/0024-cache-aware-selection.md)) | `experimental.chat.messages.transform`. Its mutable output is what goes to the model, and it is reloaded from the database every step (§2.5). The plugin trims only at cold boundaries and reads its policy from `GET /harness/adaptive/selection`, which folds in `canTransformMessages`. | None. See the A11 row. V2 compaction is `SessionCompaction.make` (`llm.ts:115`), with `compactIfNeeded` at `:246` and overflow recovery at `:317`. It has no plugin seam either. | missing | No selection: V2's own compaction governs. Because D03 is deterministic and non-destructive, not running leaves the full history. Only savings are lost. |
| Probe `RUNTIME_PROBE_PLUGIN` | `experimental.chat.system.transform` (plugin `:393`) stamps `hookAt`. | `event`: `session.next.prompted`, `step.started` and `text.started` (plugin `:372`, `:396`) stamp `v2At`. | works by design | With neither mark, the classification is `unknown` (never `legacy`) and every gate stays closed. |
| Guardrails `GUARDRAILS_PLUGIN` (related) | `tool.execute.before` (plugin `:1837`), fired by `session/tools.ts:106`. `event: message.part.updated` (plugin `:1848`). | `event: session.next.tool.called` carries `input`, so args can be digested. `session.next.tool.failed` carries `error` (`session-event.ts:313`, `:360`). The plugin does not read them yet. | missing (portable) | Server-side it is already inert: `guardrails.ts:101` checks `canObserveToolCalls`. It could be ported to the V2 events without new engine support. |

**Other hooks from §2.5:**

- `tool.definition` (`packages/opencode/src/tool/registry.ts:323`) is V1 only. V2 definitions come from `core/src/tool/registry.ts:117`.
- `experimental.session.compacting` (`session/compaction.ts:373`) is V1 only.
- `permission.ask` is declared (`packages/plugin/src/index.ts:261`) but **triggered by neither runner**. The only non-declaration mention is a doc line in `core/src/plugin/skill/customize-opencode.md:354`. V2 asks through `PermissionV2.ask` (`core/src/permission.ts:197`) and publishes an event instead.

### Delivery caveat for the `event` hook

The V1 plugin loader subscribes to the global bus (`packages/opencode/src/plugin/index.ts:255-262`)
and **drops events whose `location.directory` is not the plugin's directory**.

V2 publishes through the same `EventV2` service. It stamps `location` from `Location.Service` when
one is in scope (`packages/core/src/event.ts:421-433`).

So B01 and the probe should receive `session.next.*` for sessions of the same directory. **This has
not been confirmed against a running V2 turn.** If location is absent, both go silent.

The failure is safe: the probe reads `unknown` and B01 has gaps. A V2 replay should confirm this
before anyone relies on V2 metrics.

## What we do about it

1. **Keep gating.** Every acting route already asks the probe:
   - relevance: `relevance.ts:122`
   - guardrails: `guardrails.ts:101`
   - settings warnings: `config-surface.ts` `runtime-inert`

   D02 and D03 must use the same gate: `canObserveToolCalls` for D02, and `canTransformMessages`
   for D03.
2. **Alert when the runtime moves (this ticket).** The harness keeps a small *runtime watch* (see
   the next section) and shows unacknowledged changes in Settings → Adaptive.
3. **Port only what V2 can carry.** Measurement (B01) and guardrail observation can move to
   `session.next.*` events. Acting (A11, D02, D03) needs a V2 plugin seam upstream: a hook around
   `toLLMMessages`, the system baseline and tool settlement. Until upstream ships one, we have no
   honest fallback, so the plan is to stay on V1 and alert.

## The runtime alert

Implementation: `packages/harness-server/src/adaptive/runtime.ts` (`watchRuntime`, `createRuntimeProbe`).

After every probe refresh, the harness compares the classification with a persisted baseline
(`runtime-watch.json`, next to `harness.sqlite`). It raises an alert when one of these happens:

| Kind | When |
|---|---|
| `runtime-changed` | The definitive runtime changed (`legacy` ↔ `v2`) since the last definitive observation. |
| `engine-version-changed` | `/global/health` reports another version than last time (`handlers/global.ts:66-67`, `InstallationVersion`). |
| `v2-turns-observed` | One engine process has both a legacy hook mark and a V2 turn mark. The classification still reads `legacy`, but some turns ran where the hooks do not fire. Raised once per engine boot. |

**Not a change:**

- An `unknown` reading (the engine is down, or no turn has run yet).
- A config override, because that is the reader's own statement, not the engine moving.
- The first definitive observation, because there is nothing to compare it with.

**Storage and UI:**

- History is bounded to 20 alerts.
- `GET /harness/adaptive/config` carries the unacknowledged alerts in `runtime.alerts`.
- Settings → Adaptive shows them, in English and Spanish, together with a standing notice whenever
  the runtime reads `v2`.
- `POST /harness/adaptive/runtime/acknowledge` dismisses them. It takes the writer bearer and is
  announced as `adaptive-runtime-alerts`.
