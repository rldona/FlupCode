# ADR-0018: Context selection over summarization

- **Status:** Accepted
- **Date:** 2026-09-29
- **Related:** ADR-0012 / ADR-0014 (memory precedence and evidence-gated writes), ADR-0016 (harness boundary), ADR-0017 (Jev egress and governance), ADR-0015 (capability and seam precedent), `flupcode-adaptive-harness-plan.md` §7 / §9 / §11 / §13 / §17

## Context

The engine already "manages" context, but it does so by **summarizing**: on overflow
`compaction.ts` keeps a recent token window and asks the model to emit an anchored Markdown
summary that **replaces** the head (`flupcode-adaptive-harness-plan.md` §2.2). That is
generative rewriting, not selection. It loses original evidence and truncates tool output. The
plan's whole context thesis is the opposite: `context = relevant information`, not
`context = everything that happened` (§7). Selection chooses and archives; it never rewrites
with a model. Generative summarization stays the engine's own job and is not touched here.

Phase 2 built the substrate this ADR reuses rather than duplicating: `DecisionService.predict`
with a deterministic baseline, an optional Jev layer, a gate and an audit
(`adaptive/decision-service.ts`); `EgressGuard.prepare/allows/redact` as the single outward
serialization (`adaptive/egress.ts`); `ContextItemState` and `ContextItemAnswer` as the
`contextItem` contract (`adaptive/decision.ts:56`, `:74`); `opaqueItemID` for HMAC-opaque ids
(`adaptive/shadow.ts:47`); and `adaptive_decision` plus `explain`. ADR-0017 fixed the egress
posture; ADR-0016 fixed where the harness lives and that acting decisions arrive one phase at a
time.

Two facts decide the acting seam. First, Phase 2's `contextItem` baseline is **keep-all**
(`providers/deterministic.ts:70`, `rule: "keep-all"`): it decides nothing. Second, the run prompt
is assembled entirely inside FlupCode-owned code — `runner.ts` builds `contextText` and
`contextFiles` from packs and artifacts (`runner.ts:589-595`) and calls `compose(task, handoff,
contextText, context.memory)` (`runner.ts:616`). The engine's `prompt` API is unchanged by this
ADR, and `packs.ts` stays a pure function.

This ADR settles the design recorded in `fh-phase3a-design.md` (2026-09-29) and the Phase 3a
decisions of the plan §11, and it is the blocking step 0 of Phase 3a. It answers plan §14's
ADR-0018: item model, evidence preservation, deterministic-first scoring, budgets, trigger, and
the acting seam decision.

## Decision

### 1. Selection over summarization; the seam is FlupCode's own run prompts

Context is modeled as typed **items** that are selected, archived or — only for low-value
payloads — dropped. An item is never rewritten by a model. The acting seam of Phase 3a is the
`harness-server` **run prompt** assembly (`runner.ts`), which FlupCode owns: `ContextManager.apply`
may filter whole parts out of that assembly, and nothing else.

- **Shadow on live sessions (never in 3a).** Acting context selection on a live session needs the
  engine's internal seam, which `experimental.session.compacting` does not provide (PoC-2, plan
  §15). It is Phase 9, behind its own PoC and its own ADR, per ADR-0016 §3.
- **Opt-in `apply: false` by default.** The plan is always computed and persisted (shadow), but
  unless `adaptive.context.apply` is true the rendered prompt is byte-identical to today's. The
  one existing `adaptive.enabled` kill switch still turns everything off.
- **No-op on failure.** If classification or scoring throws, `plan` returns `undefined`, `apply`
  returns the parts untouched, and the run renders exactly as before. The runner never fails
  because of selection.
- **Promotion only with a metric.** Enabling `apply` is a promotion and requires the before/after
  evaluation of §6. There is no acting selection without a measured improvement.
- **One trust invariant at the writer.** Selection only **removes** parts of an assembly FlupCode
  already holds; it never adds instructions, never touches permissions and never reorders human
  instructions. `adaptive_plan` and `adaptive_decision` writers apply `EgressGuard.redact` before
  persisting, and store only ids, scores and reasons (ADR-0017 §2–§3). `packs.ts` remains pure and
  the engine `prompt` API (`text`/`files`) is unchanged.

### 2. The `ContextItem` model is content-free; the rich fields live in the plan entry

The item is what was **observed**; the plan is the **decision about it**. `ContextItem` is added
to `adaptive/decision.ts` beside `ContextItemState` and carries no content:

```ts
export type ContextItem = {
  id: string              // opaqueItemID(kind, value, key) — never a path or a command
  kind: ContextItemKind   // closed vocabulary; `other` is protected
  tokens: number
  referenced: boolean     // names something in the current objective (lexical)
  anchors: number         // paths / commands / errors carried, capped by the scorer
  archived: boolean       // archived by a previous plan; enables recovery if also referenced
  createdAt?: number
}
export type ContextItemState = { objective: string; items: ContextItem[] }
```

The kinds are **closed** (`objective`, `plan`, `decision`, `handoff`, `file`, `command`, `error`,
`artifact`, `memory`, `tool`, `message`, `history`, `skill`, `other`). `skill` is reserved for
Phase 3b/4 and the Phase 3a classifier **never emits it** (asserted by a test). `other` is
protected and never dropped. The `importance`/`novelty`/`state`/`reason` fields sketched in plan
§7.1 are **not** put on the item; they are results and materialize in the plan entry
(`ContextPlanEntry`). This keeps the egress state thin, exactly what ADR-0017 §3 allows to travel
and be audited. Ids reuse `opaqueItemID`, extracted to `adaptive/opaque-id.ts`, preserving the
literal `file`/`command`/`failure` strings already written by Phase 2 so rows converge. There are
two **total** classifiers — one for run-prompt inputs, one for an episode — because
`harness-server` sees two vocabularies; the full session timeline is Phase 9. All observed
content remains in its durable source (packs, artifacts, handoffs, `evidence`); the plan stores
no content.

### 3. Scoring → plan: deterministic first, Jev only on ambiguous items

`adaptive/context.ts` holds a pure scorer (`scoreContextItems`) and a class-and-budget planner
(`planContextItems`), with no I/O. The scorer **replaces keep-all** as the deterministic baseline
of `contextItem`; `deterministicContextItem` is the single implementation and
`providers/deterministic.ts` imports it.

- **Signals:** class weight, recency, anchor presence (`paths`/`commands`/`errors`), whether the
  objective references the item, and whether it was already archived (with a recovery bonus for an
  archived-but-referenced item). Weights, thresholds and the recency window are exported
  constants so recalibration never touches the algorithm, and a golden test fixes the output.
- **Disposition:** protected kinds (`objective`, `error`, `other`, `memory`) are always `keep`; a
  score at or above `keepThreshold` is `keep`; at or below `dropThreshold` **and** a droppable kind
  (`tool`, `message`, `history`) it is `drop`; anything else is `archive`. **“Ambiguous” = not
  protected and strictly between the thresholds** — exactly the set Jev may be asked about. A `drop`
  a provider answers for a non-droppable kind is degraded to `archive` before the plan is written.
- **What `apply=true` may archive.** Acting selection removes whole parts, and what it may remove is
  bounded by class: **human instructions are never archivable** — `objective` and project `memory`, a
  note a person wrote for every turn — nor are `error` and `other`. **Support material** a pack
  contributes (`artifact`, `file` refs) and the previous step's `handoff` **may** be archived, and only
  after the before/after metric of §5 has promoted `apply`. `ContextManager.apply` enforces this as
  defence in depth: it refuses to remove a protected kind even if a corrupt plan says `archive`/`drop`,
  and normalises an invalid disposition to `keep` rather than filtering.
- **Budgets and fill order:** a global token ceiling and per-class budgets (configuration with
  conservative defaults; this ADR fixes the policy, not a number). Protected items consume their
  tokens first; `drop` items free budget; the rest is filled in class order (objective first,
  evidence last) and by score within a class, with a stable tie-break. An item that does not fit is
  `archive`, never `drop` — **archive is recoverable, `drop` is only for low-value payloads** whose
  bytes still live in their durable source.
- **No reordering.** Phase 3a filters whole parts; the order of the prompt does not change.
  Reordering by score is Phase 9.
- **Jev only on ambiguous items.** If there are none, Jev is **not called** (zero cost, no decision
  row). Otherwise one `DecisionRequest<"contextItem">` carries only the ambiguous items; the merge
  is **per item** on top of the full deterministic baseline, and on any degradation
  (timeout/egress/low confidence/…) the baseline is kept. After the merge the **same budget cap** the
  planner uses is re-applied, so an external `keep` can never push the plan past `budget.total` or a
  per-class budget. The known limitation — the Phase 2 `contextItem` confidence is a batch minimum
  (`providers/jev.ts:203`) — is documented, not fixed here; per-item confidence is Phase 3b/4.
- **Do nothing on total failure.** Disabled, uncovered or throwing ⇒ `plan` is `undefined` and the
  prompt is today's.

### 4. `adaptive_plan` is one row with `items_json`, side by side with `adaptive_decision`

A new additive table in `harness-server` records one plan per scenario:

- run prompt: id `plan:<runID>:<taskID>`;
- episode: id `plan:<episodeID>`.

`planID(scope) = plan:<scope>`, mirroring `decisionID`; the upsert converges on re-planning, so
migration is `CREATE TABLE IF NOT EXISTS` with no change to any prior table. The row stores scope
ids, an `objective_hash` (never the objective text), a bounded `items_json` array of entries
(id/kind/disposition/score/reason/protected/tokens), counters, `score_source`, `degraded`, the
tokens before/after, and `decision_id`.

The plan **does not create or duplicate evidence**. An episode plan’s entries are keyed by opaque
id; `explainPlan` walks to evidence through `episode.evidenceRefs` → `episode_evidence` →
`evidence`, exactly as Phase 2’s `explain` does. `adaptive_plan.decision_id` points at the
`contextItem` row when Jev was asked, so the plan can explain why an ambiguous item took its
disposition without re-running anything; when nothing was ambiguous it is null. No content is ever
stored: not pack text, not handoffs, not memory. The shadow path delegates `contextItem` to the
manager (`SHADOW_KINDS` keeps `completion`/`skillRelevance`), so Phase 2’s keep-all fixtures are
updated as part of Phase 3a — authorized by plan §11, not regressions.

### 5. The evaluation is a deliverable, not a test

Phase 3a is not done without `context-eval.test.ts`: an **offline** before/after metric over the
FH-007 fixtures and the new `fixtures/context/`, with no network and no model. It asserts the
must-keep invariant (objective and errors always present, `other` never dropped), determinism
(same input ⇒ same score and disposition), the recorded-Jev merge (band respected; zero calls with
no ambiguous item; degradation equals the baseline), budget invariants, and byte-identity
(`renderRunPrompt === compose`; `apply=false` and kill switch identical). This metric is what makes
enabling `apply` falsifiable, and it conditions **any** future promotion of the selection seam.

## Consequences

Positive:

- Selection is deterministic, explainable and reversible: every entry carries a reason, an
  archived item is recoverable, and dropped bytes remain in their durable source.
- With the seam off, `apply=false` or the kill switch, the run prompt is byte-identical by
  construction: one renderer, proven by a golden test. Turning the feature off restores today's
  behaviour exactly.
- Jev is asked only about genuinely ambiguous items; with no ambiguous item there is no call, no
  cost and no decision row. The Phase 2 substrate (decision service, audit, egress guard, opaque
  ids) is reused, not duplicated.
- The plan is auditable from stored rows alone, and the evaluation makes "better" measurable.

Negative / accepted costs:

- The scorer is a lexical heuristic; it can archive something useful. Mitigated by `apply=false`
  by default, protected kinds, the evaluation and metric-gated promotion — and by recovery.
- The `contextItem` Jev confidence is a batch minimum, so one low-confidence item degrades the
  batch. Documented; per-item confidence is Phase 3b/4.
- Changing `ContextItemState.items` from the thin Phase 2 shape to `ContextItem` touches literals
  in `deterministic.ts`, `shadow.ts` and Phase 2 tests. The change is additive and localized; the
  implementation plan enumerates it.
- A plan row per task per execution grows the store. The deterministic id (upsert) bounds it;
  retention is an open question (plan §19), out of Phase 3a.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| Acting on live sessions now | Needs the engine’s internal seam, which `experimental.session.compacting` does not give; Phase 9 behind a PoC and its own ADR (ADR-0016 §3). |
| Apply by default | Acting before measuring is unsafe; the plan fixes `apply: false` by default and metric-gated promotion. |
| A `ContextItem` with `content`/`preview` | Puts observed text in the state that reaches Jev and the audit; violates ADR-0017 §3. Bytes stay in the durable source. |
| Put `importance`/`novelty`/`reason` on the item | Thickens the egress state and duplicates the plan entry; the item is the observation, the plan is the decision. |
| New salted ids | Breaks convergence with Phase 2’s `adaptive_decision` rows and duplicates the HMAC. `opaqueItemID` is reused. |
| One classifier guessing the source | Mixes the prompt and episode vocabularies and defeats a per-source golden; two total functions, one model. |
| Open `kind: string` | Prevents exhaustive weights/budgets and admits kinds with no declared weight; closed plus protected `other`. |
| Pure sort and threshold, no classes/budgets | Ignores plan §7.2 (“budget class by class”) and the objective-first/evidence-last order; one huge item would eat the whole budget. |
| Reorder the prompt by score | Changes the prompt byte-for-byte and complicates reversibility; Phase 3a filters without reordering. |
| Ask Jev about every item and filter after | Spends on already-resolved items and contaminates the batch confidence gate; only ambiguous items are asked. |
| `drop` for any low score | Loses evidence (errors, files); `drop` is for low-value payloads only, everything else archives. |
| Merge Jev answers inside `DecisionService` | The service is kind-agnostic; per-item merge is context semantics and lives in the manager. |
| A normalized `adaptive_plan_item` table | Better per-item queries, but 3a needs none and the UI is deferred; one row mirrors `adaptive_decision`. |
| Store entries in `adaptive_decision.state_summary_json` | Mixes two entities and makes a deterministic (Jev-free) plan unexplainable with no decision row. |
| Store the objective or content “to recover” | Violates ADR-0017 §3; recovery reconstructs from the source, it does not reread the plan. |

## Out of scope

- Acting context selection on **live sessions** and any core `ContextPlanner` seam (Phase 9).
- Reordering the prompt by score and per-item Jev confidence (Phase 3b/4).
- The `ContextPanel` UI (FH-025 deferred): Phase 3a ships only the route and the
  `adaptive-context` capability.
- Reimplementing generative summarization; the engine’s `compaction.ts` is unchanged.
- Any change to `packs.ts`, `packages/remote`, Protocol/HttpApi, the SDK or `packages/harness`.
- Retention and purge of adaptive data (plan §19).
- Concrete budget/threshold numbers: they are configuration with conservative defaults.

## Implementation plan

Phase 3a is FH-020…FH-025 in `flupcode-adaptive-harness-plan.md` §13, with the file map and step
order in `fh-phase3a-design.md` §6 and §11 (step 0 is this ADR and `docs/ADAPTIVE.md#context`;
then model + opaque id, classifiers, scorer + budget, plan + persistence, Jev merge, the runner
seam, the shadow delegation, the route + capability, and the evaluation deliverable). This ADR is
accepted from the start, as ADR-0016 and ADR-0017 were, and blocks Phase 3a code.
