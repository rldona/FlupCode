# Adaptive Harness

> **Status.** Phase 1 (observability) is **done** (FH-000–007, PR #368). Phase 2 (decision
> foundation) is **in progress**. This is a skeleton: the sections below are filled in as each phase
> lands, not a complete manual. The full plan and the Phase 2 design live in the working notes under
> `.flupcode/artifacts/`, which are intentionally not versioned; this file is the versioned summary.

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
| `ContextManager` | Model context items, score and plan | Phase 3 (pending) | ADR-0018 (pending) |
| `LearningManager` / `ReflectionEngine` | Episode → reflection → proposal | Phase 3b (pending) | ADR-0020 (pending) |
| `SkillCurator` | Sole writer of learned skills; lifecycle | Phase 6 (pending) | ADR-0019 (pending) |

The boundary — what lives in `harness-server`, what attaches through the engine plugin, and when a
contained core extension is allowed — is fixed by
[ADR-0016](adr/0016-adaptive-harness-boundary.md).

## Context

_Pending Phase 3a. Will document the `ContextItem` model, budgets, the `CompactionPlan` and the
selection seam that both skill relevance and probation depend on (plan §7)._

## Learning

_Pending Phase 3b. Will document episodes, the reflection cadence, proposals and the evidence gate
(plan §8)._

## Skills

_Pending Phase 3b/6. Will document the learned-skill store, the `self-authored` marker, the
lifecycle and usage accounting (plan §8)._

## Decisions

_In progress during Phase 2. Will document the seven decision kinds, the audit and `explain`, and
the shadow mode that records decisions without acting on them
([ADR-0017](adr/0017-jev-egress-and-governance.md))._
