# Adaptive Harness

> **Status.** Phase 1 (observability) is **done** (FH-000–007, PR #368). Phase 2 (decision
> foundation) is **done** (ADR-0016 / ADR-0017). Phase 3a (selection seam) is **in progress**: the
> decision record is [ADR-0018](adr/0018-context-selection-seam.md). This is a skeleton: the
> sections below are filled in as each phase lands, not a complete manual. The full plan and the
> phase designs live in the working notes under `.flupcode/artifacts/`, which are intentionally not
> versioned; this file is the versioned summary.

## What the Adaptive Harness is

The Adaptive Harness is a bounded service layer that makes FlupCode **observe** how work actually
goes, **explain** the decisions it would take, and — one step at a time, always behind a
deterministic fallback — **adapt** to it. It augments the existing orchestration; it is not a second
agent and does not replace the engine runner.

Its first value is not autonomy but **observation and explanation**: show what the harness knows,
what it would do, and why. Acting decisions arrive later, one at a time, always reversible.

## Adaptive ≠ Autonomous

The harness is **adaptive**: it learns from evidence and proposes changes. It is **not autonomous**:
it does not decide on its own to act, it does not create capabilities, and disabling it restores the
previous behaviour exactly. Every acting decision ships **shadow first**, is audited, and requires
measured improvement to be promoted.

## Trust invariant

The invariant is a **rule, enforced at the writer**, not a component:

> Learned knowledge may inform routing, context, and proposals. It may never create, widen, or bypass
> a permission, and it may never silently modify human-authored instructions or files.

This inherits the precedence **permissions > instructions > skills > memory** from
[ADR-0012](adr/0012-memory-knowledge-layer.md) and the guard rules of
[ADR-0014](adr/0014-memory-handoff.md).

## Component map

| Component | Responsibility | Home | Decision record |
| --- | --- | --- | --- |
| `SessionObserver` | Normalize session signals into episodes; detect boundaries | `packages/harness-server/src/adaptive/` | Phase 1; [ADR-0016](adr/0016-adaptive-harness-boundary.md) |
| `DecisionProvider` | Answer typed decisions; deterministic, Jev, fallback | `packages/harness-server/src/adaptive/providers/` | [ADR-0017](adr/0017-jev-egress-and-governance.md) |
| `DecisionService` | Predict, apply thresholds, audit, explain | `packages/harness-server/src/adaptive/` | [ADR-0017](adr/0017-jev-egress-and-governance.md) |
| `ContextManager` | Model context items, score and plan | Phase 3a (in progress) | [ADR-0018](adr/0018-context-selection-seam.md) |
| `LearningManager` / `ReflectionEngine` | Episode → reflection → proposal | Phase 3b (pending) | ADR-0020 (pending) |
| `SkillCurator` | Sole writer of learned skills; lifecycle | Phase 6 (pending) | ADR-0019 (pending) |

The boundary — what lives in `harness-server`, what attaches through the engine plugin, and when a
contained core extension is allowed — is fixed by
[ADR-0016](adr/0016-adaptive-harness-boundary.md).

## Context

Phase 3a models context as **selection over summarization**: the harness chooses what enters a
prompt, archives the rest, and never rewrites content with a model. Generative summarization stays
the engine's own job and is untouched. The design is fixed by
[ADR-0018](adr/0018-context-selection-seam.md).

- **A content-free item model.** Context is a closed set of typed `ContextItem`s — `objective`,
  `handoff`, `memory`, `artifact`, `file`, `command`, `error`, and so on — carrying an opaque HMAC
  id, a token estimate, whether the objective references them, how many anchors (paths, commands,
  errors) they hold, and whether a previous plan archived them. **No content travels**: the bytes
  stay in their durable source (packs, artifacts, handoffs, episode evidence) and the plan keeps
  only ids, scores and reasons. `objective`, `error`, unknown items (`other`) and project `memory`
  (a human note, possibly a directive) are never dropped nor archived, and `skill` is reserved for
  Phase 3b/4 and never emitted in 3a.
- **Deterministic scoring with budgets.** A pure scorer combines class weight, recency, anchors and
  objective reference; a planner fills a global budget and per-class budgets — objective first,
  evidence last — without reordering the prompt. Weights, thresholds and budgets are configuration
  with conservative defaults, not hardcoded numbers. Protected items always `keep`; low-value
  payloads (`tool`, `message`, `history`) may `drop`; everything else overflows to `archive`.
- **An explainable and reversible plan.** Every decision carries a stable reason and `archive` is
  recoverable: `explainPlan` answers "why was this kept or archived" from stored rows alone, reaching
  the durable evidence through the episode's `evidenceRefs`. (Phase 3a leaves the per-entry
  `evidenceRef` unset: an opaque id does not map to a run/task/session ref; per-item evidence is
  Phase 3b/4.)
- **Jev only on ambiguous items.** Items inside the ambiguity band (not protected, between the drop
  and keep thresholds) may be asked to Jev in one request; with none ambiguous, Jev is not called at
  all. The **run prompt** is a live turn, so it takes the hot path (`runHot`, ADR-0017 §4): it never
  queues behind the adaptive limiter and is bounded end to end by the per-kind `timeoutMs`, degrading
  to the deterministic baseline if it expires. The **episode** plan is background work and stays on the
  batch path. On any degradation the deterministic baseline is kept, and on total failure the prompt is
  left exactly as it is.
- **An opt-in seam on run prompts.** The plan may filter FlupCode's own **run prompt** assembly.
  `apply` is **off by default**, so the prompt is byte-identical to today unless it is explicitly
  enabled; acting on **live sessions** is Phase 9, behind its own PoC and ADR. With `apply` on, only
  **support material** may be archived: pack `artifact`/`file` refs and the previous step's `handoff`.
  **Human instructions** (`objective`, project `memory`) and `error`/`other` are never removed, and
  `apply` enforces that even against a corrupt plan. The plan is always computed and persisted
  (shadow) so its "what would have happened" is measurable, and enabling `apply` is a promotion gated
  on the before/after evaluation over the offline fixtures — not a configuration change alone.

The selection seam is what skill relevance and skill probation will later depend on (plan §7).

## Learning

_Pending Phase 3b. Will document episodes, the reflection cadence, proposals and the evidence gate
(plan §8)._

## Skills

_Pending Phase 3b/6. Will document the learned-skill store, the `self-authored` marker, the
lifecycle and usage accounting (plan §8)._

## Decisions

_Landed in Phase 2. Documents the seven decision kinds, the audit and `explain`, and the shadow
mode that records decisions without acting on them
([ADR-0017](adr/0017-jev-egress-and-governance.md))._
