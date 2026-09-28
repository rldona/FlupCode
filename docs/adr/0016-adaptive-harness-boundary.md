# ADR-0016: Adaptive Harness boundary

- **Status:** Accepted
- **Date:** 2026-09-28
- **Related:** ADR-0001 / ADR-0002 (fork boundary), ADR-0012 / ADR-0014 (memory precedent and permission precedence), `docs/ARCHITECTURE.md` (upstream packages are read-only)

## Context

FlupCode is a client of the OpenCode engine and keeps the upstream packages read-only (ADR-0001,
ADR-0002; `docs/ARCHITECTURE.md:39`). Everything FlupCode builds lives in its own packages:
`packages/harness`, `packages/harness-desktop`, `packages/harness-server`, `packages/remote`,
`packages/relay` and `packages/flupcode-cli`.

The Adaptive Harness is a **bounded service layer** over that orchestration — `DecisionProvider`,
`ContextManager`, `LearningManager`, `SkillCurator`, `SessionObserver`, `PredictionService`. It is
not a second agent and does not replace the engine runner (`flupcode-adaptive-harness-plan.md` §5.1).
Its first job is to **observe and explain**, not to act: decisions arrive one at a time, always behind
a deterministic fallback, always reversible.

The product boundary is real but leaky. Upstream is nominally read-only, yet FlupCode added
`packages/core/src/memory.ts` and its modules, and ADR-0012 records that `docs/ARCHITECTURE.md`'s
stock packages "are extended in practice for this primitive" while bounding the diff to memory
modules, one config module, one tool, one protocol group, one handler, and the runner injection point.
ADR-0012 also fixes the precedence **permissions > instructions > skills > memory**, which the
Adaptive Harness inherits and may never widen.

The engine exposes exactly one supported, FlupCode-owned external surface: the installed engine
plugin (`packages/remote/src/engine-plugins.ts:1487` `installEnginePlugins`), which registers the
legacy `Hooks` API used in Phase 1 (`RUNTIME_PROBE_PLUGIN` `engine-plugins.ts:306`,
`EPISODE_EVENTS_PLUGIN` `engine-plugins.ts:1326`). Phase 1 established that observation and injection
attach there.

This ADR settles pending decision #2 of the plan's Top 10: *after the memory precedent, when is a
contained core extension allowed versus a plugin or a harness-server action?*

## Decision

### 1. The Adaptive Harness lives in `packages/harness-server/src/adaptive/**`

`harness-server` already owns durable state (SQLite, SSE, artifacts, checkpoints, findings, the
scheduler) and a `bun:test` suite, and it is spawned by the desktop app
(`packages/harness-desktop/src/main/server.ts`). It is where runs, tasks, episodes, decisions and run
prompts are FlupCode's to change. Phase 1 code already lives there
(`packages/harness-server/src/adaptive/`: `runtime.ts`, `coordinator.ts`, `episode.ts`, `evidence.ts`,
`events.ts`, `signals.ts`, `outcome.ts`). Phase 2 (`decision.ts`, `config.ts`, `egress.ts`,
`decision-service.ts`, `decision-routes.ts`, `shadow.ts`, `providers/**`) lands in the same tree.

The module is a plain TypeScript service layer. It **does not import Jev types**, and it does not
import `@opencode-ai/core`; the engine is reached over HTTP/SSE and through the plugin, as ADR-0002
already requires of browser-side code.

### 2. The engine is reached only through the installed plugin

New engine-internal behaviour goes through `installEnginePlugins` (`engine-plugins.ts:1487`) over the
legacy `Hooks` API. The plugin is stateless and file-based: it observes the engine and writes bounded
signals that `harness-server` reads back. It never holds product state, and it is the only component
that can call `ctx.ask` (the precedent ADR-0015 sets for web actions). The runtime probe (FH-000)
guards every capability-dependent decision: with `v2` or `unknown`, observation and injection degrade
to the SDK/harness-server path and no acting decision runs.

### 3. A contained core extension is a last resort, only after a PoC

When neither the harness-server nor the plugin can reach the needed seam, a **contained core
extension behind an interface** is allowed, following the memory precedent (ADR-0012), but only after
a PoC proves it is required and keeps the diff minimal. This is not hypothetical: PoC-2 (narrowed)
found that `experimental.session.compacting` can replace the summary prompt but **cannot choose which
messages survive**, so a `ContextPlanner` seam in core is a candidate for a later phase — not for
Phase 2.

The preference order is therefore fixed:

1. **harness-server** — act on what FlupCode owns (runs, tasks, episodes, decisions, run prompts).
2. **engine plugin** — observe and inject over the legacy hook surface.
3. **contained core extension** — only behind an interface, only after a PoC, only with its own ADR.

### 4. Rules that follow from the boundary

- The `adaptive/` module speaks plain TypeScript primitives; a `NullProvider` is the default external
  slot so "Jev off" is a representable state, not an absence.
- Phase 2 decisions are **shadow only**: they are recorded and explained, never acted upon.
- Egress is opt-in per project and Jev is off by default; that posture is fixed by ADR-0017.
- Any change that needs core must bring its own ADR and its own PoC; it is not inherited from this
  one.

## Consequences

Positive:

- The Adaptive Harness reuses the durable store, the event log, the scheduler and the test conventions
  that `harness-server` already has, and it stays inside FlupCode-owned code.
- The boundary is enforceable by inspection: Phase 2 does not touch core, Protocol/HttpApi or the
  generated SDK, so upstream sync stays fast-forward friendly.
- Observation degrades safely on a future V2 runtime because the plugin path is capability-gated by
  the runtime probe.

Negative / accepted costs:

- The plugin hook surface is what upstream currently exposes; a feature that needs an engine seam the
  hooks do not offer is blocked until a PoC justifies a core diff.
- `harness-server` does not use Effect or the upstream `config/` self-export pattern, so its adaptive
  config is a compositor over Phase 1 resolvers (`config-files.ts:303` `globalAdaptiveBlock`) rather
  than a new framework.
- The legacy hooks are dispatched by the V1 runtime; a future upstream migration to the V2 runner
  would leave them inert, which is why the runtime probe is a precondition and not an optional
  add-on.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| The engine plugin as the primary seat | The plugin is stateless and file-based: it has no durable store, no HTTP surface and no scheduler, so it cannot audit decisions or accumulate a budget. |
| A contained core extension now | It carries upstream merge cost with no PoC to justify it, and Phase 2 needs no engine-internal seam. Held back until a PoC proves it. |
| `packages/remote` as the seat | It is the plugin-wiring boundary, not a service host; moving the service there would couple the adaptive layer to engine plumbing. |
| A new package for the Adaptive Harness | It would duplicate the store, scheduler and HTTP plumbing that `harness-server` already owns, and add a second place to find product state. |
| Editing core behind the same ADR without a new one | A core change is a boundary crossing that needs its own decision record and its own PoC, following ADR-0012's precedent. |

## Out of scope

- Any core file change in Phase 2.
- Changes to Protocol/HttpApi or regeneration of the SDK for adaptive routes (Phase 2 uses the
  existing plain route style in `api.ts`).
- Acting decisions of any kind; Phase 2 is shadow only.
- Native OS automation and any non-plugin engine seam.

## Implementation plan

Phase 2 is FH-010…FH-017 in `flupcode-adaptive-harness-plan.md` §13. The technical design, including
the file map under `packages/harness-server/src/adaptive/`, is `fh-phase2-design.md` §9. This ADR is
step 0 of Phase 2 and blocks all of Phase 2 code (`fh-phase2-design.md` §11–§12).
