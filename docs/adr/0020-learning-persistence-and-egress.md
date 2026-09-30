# ADR-0020: Learning persistence, cadence and egress

- **Status:** Accepted; amended 2026-09-30 (AH-A04, human approval before install; AH-F01, built-in rules without a classifier)
- **Date:** 2026-09-29
- **Related:** ADR-0016 (harness boundary), ADR-0017 (Jev egress and governance), ADR-0018 (context selection seam), ADR-0019 (learned skill lifecycle and provenance), `flupcode-adaptive-harness-plan.md` §8 / §9 / §11 / §13 / §14 / §19, `fh-phase3b-design.md`

## Context

Phase 3b is the learning loop: an episode closes, a deterministic gate decides whether it carries a
lesson, Jev classifies whether the lesson is reusable and what change it calls for, a small model
drafts the skill text, and the curator installs it. It is the first place **observed content reaches
a model**, and the first place the harness writes durable artifacts of its own outside SQLite. Both
crossings need an explicit decision record, not a hardening phase added later
(`flupcode-adaptive-harness-plan.md` §11, "Three rules gate every phase").

The substrate is already built and is reused, not duplicated: `DecisionService.predict` with a
deterministic baseline, an optional Jev layer, a confidence gate and audit
(`adaptive/decision-service.ts`); `EgressGuard` as the single outward serialization, with `allows`,
`prepare` and `redact` (`adaptive/egress.ts:17-37`); `adaptive_decision` with `decisionID` upserts;
the shadow on episode close with `SHADOW_KINDS = ["completion", "skillRelevance"]`
(`adaptive/shadow.ts:24`); the composed adaptive config with a kill switch and per-kind resolvers
(`adaptive/config.ts:144` `resolveDecisionPolicies`, `:219` `resolveEgressKinds`); and
`evidenceFor(episode, now)` on the routine repository (FH-006) as the content-addressed source of
truth the reflection reads. Phase 3a's selection seam is the surface a learned skill is later
measured on.

Two facts shape the storage decision. First, `adaptive_decision` is for *decisions*; a proposal is a
different entity with human review ahead of it, so it gets its own table rather than a reshaped
decision row. Second, the global `small_model` is a top-level config key
(`packages/core/src/config.ts:40`) that `harness-server` does not currently read:
`loadGlobalConfig()` is private (`packages/harness-server/src/config-files.ts:254`) and the adaptive
config is a compositor over it (`config-files.ts:303` `globalAdaptiveBlock`).

The invitation is real: once learning classifies episodes, every closed episode is a candidate spend.
The gate, the cadence and the off-by-default egress posture are what keep an idle project at zero
cost.

This ADR is step 0a of Phase 3b (`fh-phase3b-design.md` §12–§13) and blocks all learning code. It
settles what the plan calls "where episodes, proposals, decisions and evidence live; project vs
global scope; the evidence gate" (§14) and the Phase 3b decisions of 2026-09-29 (§11).

## Decision

### 1. Two additive tables; a proposal is not a decision

`reflection_job` and `skill_proposals` are added to the existing SQLite store with
`CREATE TABLE IF NOT EXISTS`. The change is additive: no prior table is altered and migration over an
existing DB is a no-op replay.

- **`reflection_job`** — primary key `episode_id`. It records `session_id`, `project_id`, `status`
  (`pending | skipped | done | failed`), a machine-readable `reason`, the `decision_id`
  (`skillReflection:<episodeID>`), the `proposal_id` (`proposal:<episodeID>`), `attempts` and
  timestamps. The job row is what makes "already tried" a fact rather than an in-memory guess.
- **`skill_proposals`** — primary key `proposal:<episodeID>`; it records the `episode_id`, the
  `decision_id`, `intent` (`add | patch`; `merge`/`drop` are rejected before storing), an optional
  `target_skill`, the draft's `name`/`description`/`body`/`body_hash`, `evidence_refs_json`,
  `confidence`, `model_version`, `status` (`proposed | promoted | rejected`), a `reason` and
  timestamps.

`RoutineRepository` gains a `LearningRepository` facet with create/get/list for both rows plus the
existing `evidenceFor`; `adaptive/learning-record.ts` mirrors `decision-record.ts` with defensive
decoders — broken JSON becomes empty values and an invalid intent/status discards the row rather
than guessing. Ids are deterministic (`proposal:<episodeID>`, `reflectionID = episodeID`) so re-reads
converge, exactly as `decisionID` does.

### 2. The proposal body is persisted, redacted and bounded

The row stores **both** the bounded `body` and its `body_hash`. A proposal exists *before* promotion
and its reason for existing is human review; storing only the hash would make it irrevisible and
force a second small-model call to inspect it. The honest reading is that the review route exists
even while the UI is deferred (FH-035/FH-046), so the text it reviews must survive the process.

The body is passed through `EgressGuard.redact` and bounded to `learning.maxBodyChars` **before**
`createProposal`, in the same database and under the same trust domain as `evidence`. The same
redaction and bounds apply to the text handed to the drafter and to the `SKILL.md` that is finally
installed on disk. Persisting content is therefore the ADR-0017 posture applied to a new writer, not
a new exception to it.

### 3. Idempotency is per episode; a job is terminal after its first attempt

`reflection_job.episode_id` is the primary key and `skill_proposals.id = proposal:<episodeID>`. The
manager **skips** an episode that already has a job: a second close, or the startup `sweep`, neither
re-reflects nor re-spends. The job is terminal after the first attempt; retrying is an administrative
action outside 3b. The `skillReflection` decision row converges on
`decisionID("skillReflection", episodeID)`, so a re-read never re-executes.

The `sweep` on restart collects only **terminal** episodes (`endedAt !== undefined`) that have no job
— the same criterion the Phase 2 shadow uses. Episodes of a session with no run (no `endedAt`) are
out of 3b (Phase 9).

### 4. Cadence and a deterministic evidence gate

Reflection hangs off `onEpisodeClosed` (like the shadow) plus its own `sweep`; it never blocks or
fails a run. Cadence is a safety net, not the trigger: an episode must clear a **deterministic gate**
before any model call — `minToolCalls` in the config **and** at least one bounded, non-obvious signal
(a verification result, a touched file, a failure). Below the threshold the job is recorded
`skipped` with `below-threshold`/`no-signal` and **nothing is spent**. Quiet episodes therefore
produce zero jobs and zero model calls; a busy episode produces at most one. This is FH-030.

### 5. Egress of the draft reuses the ADR-0017 opt-in; learning is off by default

Learning adds a second, independent egress condition on top of the existing one, and both are off by
default:

- **Jev classification** (`skillReflection`) needs `adaptive.jev.enabled` **and** the project in
  `adaptive.egress.projects` **and** `adaptive.egress.kinds.skillReflection`. The kind is added to
  the allowlist vocabulary and resolved by `resolveEgressKinds`, **false by default**. Classification
  is the door: with Jev off, or the project not allowlisted, the baseline answer is inert and no
  proposal is produced — 3b does not learn without Jev.
- **The draft** needs `adaptive.learning.enabled` **and** `adaptive.egress.enabled` **and** the
  project in `adaptive.egress.projects`. The text handed to the small model is built from the
  objective plus bounded signals and `evidenceFor` slices, then redacted with `EgressGuard.redact`
  and bounded to `learning.maxInputChars`. It is **not** passed through `prepare`, which is typed to
  a `DecisionRequest`; `redact` is the same source of truth for secrets and is the right seam. The
  draft is the first time observed content reaches a generation model, so it uses the same
  per-project consent Jev already established.

### 6. Model resolution: `adaptive.learning.model` → global `small_model` → `no-model`

The drafting model is `adaptive.learning.model` (a `provider/model` key parsed with
`parseModelKey`) and falls back to the global `small_model`. To read it, `config-files.ts` gains a
narrow `globalSmallModel()` export wrapping the private `loadGlobalConfig()`; the model reaches the
engine through the existing `Engine`/SDK session pattern (`commitMessage`/`handoff`), because
`harness-server` has no LLM client by design (ADR-0016 §2, plan §11).

With neither key set, the job is recorded `skipped` with `no-model` and the engine is **not** called.
No model means no draft, not a silent fallback to some other model.

### 7. The learning kill switch stops the loop; it never deletes

`adaptive.learning.enabled = false` is the default and stops reflection, the `skillReflection`
classification, the draft and the curator's writes. It **does not** remove skills already written:
they stay on disk and keep loading, and the `completion`/`skillRelevance` shadow keeps running. The
master `adaptive.enabled = false` (or `FLUPCODE_ADAPTIVE_DISABLED=1`) additionally stops every
decision and the shadow. `adaptive.jev.enabled = false` leaves learning inert (the classification
degrades to `reusable:false`), but already-written skills still load.

Nothing in any kill switch **purges** a learned skill. Archive is a move and "nothing is deleted"
(plan §9); removing a skill means deleting its folder, a human action outside the harness. The
exact matrix is documented in [`docs/ADAPTIVE.md#learning`](../ADAPTIVE.md#learning).

### 8. Project scope only; the global layer is a later, explicit promotion

3b is **project-scoped**. Nothing is derived from `configDirectory()` and no cross-project
promotion exists. The learned root is project-scoped and the curator requires a real, absolute,
writable project directory (see ADR-0019). This removes cross-project leakage **by construction**;
the global layer (plan §9, FH-081) is Phase 11 and requires the same explicit human promotion a
PROBATION skill gets, with its own decision record.

### 9. The measurement contract: selection/recall offline; outcome is Phase 4

The falsifiable claim of 3b is offline and reproducible:

> A learned skill in PROBATION whose `description` describes the objective it should serve is
> selected by the deterministic `skillRelevance` baseline (the shadow) for that objective, with a
> **zero wrong-load rate** over labelled episodes.

That is a *selection* claim (`answer.load`), measured by `learning-eval.test.ts` over
`fixtures/learning/*.json` with no network and no real model. It is **not** an outcome claim:
improvement in task outcome needs Phase 4 to actually inject the selection, and is neither measured
nor asserted here. Measuring a metric by wall-clock is explicitly rejected (plan §8.1, "not
wall-clock"); the learning rate is opportunity-relative in ADR-0019.

## Consequences

Positive:

- Every reflection is idempotent and bounded: one job per episode, terminal after the first attempt,
  zero spend below the deterministic gate and zero engine calls with no model.
- A proposal is reviewable without re-drafting, because its body survives redacted and bounded in the
  same trust domain as `evidence`.
- Learning is off by default and opt-in per project, so an idle project behaves exactly as it did
  before learning existed; the master kill switch and the per-kind allowlist compose rather than
  conflict.
- The store, the decision service, the egress guard and the shadow are reused, so Phase 3b adds
  tables and orchestration rather than a second decision path.
- The metric is offline and reproducible from fixtures, which makes "learned" claimable without a
  live model.

Negative / accepted costs:

- Persisting the body retains observed content in the DB. Mitigated by redaction, bounds and the same
  domain as `evidence`; the alternative is an irrevisible proposal.
- Two additive tables are hard to un-ship, but they are additive and the deterministic ids make the
  data recomputable.
- `egress.enabled` is coupled to `jev.enabled`: disabling Jev leaves learning inert. This is the
  intended posture, documented so it is not read as a bug.
- One job row per terminal episode grows the store. Retention and purge are plan §19 and out of 3b.
- The phase's claim is narrow: it proves selection, not usefulness. A wrong or low-quality draft can
  still land in the library; PROBATION, the validation lint and archive-not-delete are the controls,
  and the quality bar is Phase 4's.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| Store only `body_hash` | The proposal is pre-promotion and human reviewable; a hash forces a second model call just to inspect it. |
| Reuse `adaptive_decision` for proposals | A decision and a proposal are different entities and mixing their vocabularies blurs both. |
| A normalized `skill_proposal_evidence` table | 3b never queries by evidence; an array of refs walks to the episode as `explain` already does. |
| Idempotency by `attempts` without a job row | Without a row there is no durable "already tried"; the job is the key. |
| A deterministic baseline that proposes something | Contradicts the opt-in posture and spends without a classifier; a lexical heuristic is a Phase 4 question. |
| `adaptive.learning.enabled = true` by default | Egress would not be opt-in; violates ADR-0017. |
| Delete learned skills when learning is disabled | Destroys work and contradicts archive-not-delete. |
| A separate `egress.learning` opt-in | Duplicates the per-project consent; `egress.enabled` + `egress.projects` are reused. |
| Send the draft body to Jev for `prepare` | `prepare` is typed to a `DecisionRequest`; `redact` is the same secret source of truth and the right seam. |
| A fallback model when none is configured | Silently spends on a model the user did not choose; `no-model` is the honest answer. |
| Global scope in 3b | Leaks learning across projects; the global promotion is Phase 11 and explicitly human. |
| Measure outcome improvement in 3b | With nothing injected (Phase 4), it is unfalsifiable; 3b measures selection/recall. |
| Per-`noul` confidence instead of the batch minimum | Inherited Phase 2 limitation; per-item confidence is Phase 3b/4 and would reopen ADR-0018. |

## Out of scope

- The proposal review UI and the rejected-proposal report (FH-035/FH-046); 3b ships backend routes and
  the `adaptive-proposals` / `adaptive-skills` capabilities only.
- Curator merge and capacity eviction (FH-044) and archive/revive (FH-045); 3b rejects `merge`/`drop`
  intents with a reason.
- The global scope and cross-project promotion (FH-081, Phase 11).
- Acting selection and outcome measurement (Phase 4).
- Live-session and core hooks (Phase 9).
- Retention and purge of adaptive data (plan §19).
- Concrete config numbers: `minToolCalls`, `maxInputChars`, `maxBodyChars` and the cadence are
  configuration with conservative defaults; this ADR fixes the policy, not the numbers.
- Any change to Protocol/HttpApi, the SDK, `packages/harness`, `packages/remote`, `packs.ts`,
  `runner.ts` or `scheduler.ts`; reflection hangs off `coordinator.onEpisodeClosed` and its own
  `sweep`, like the shadow.

## Implementation plan

Phase 3b is FH-030…FH-035 and FH-040…FH-046 in `flupcode-adaptive-harness-plan.md` §13, with the file
map, step order and verification commands in `fh-phase3b-design.md` §10, §13 and §14. This ADR is
step 0a and blocks all Phase 3b code; step 0b is
[ADR-0019](0019-learned-skill-lifecycle.md). Its criteria: the tables migrate over an existing DB,
an episode produces at most one proposal without blocking, and with Jev off, learning off or the
kill switch the harness behaves exactly as before and no new learned skill appears.

## Amendment (2026-09-30, AH-A04): the loop ends at a proposal

The Context's last step — "the curator installs it" — is replaced by human approval. A reflection now
ends at a `skill_proposals` row: `proposed` when the draft passes the lint, `rejected` with the lint
reason when it does not, and the job reason is `proposed` rather than `promoted`. Only
`POST /harness/adaptive/proposals/:id/approve` (bearer and `confirm: true`) moves a row to `promoted`,
installing it through the curator (ADR-0019 §2); `POST …/reject` closes it as `rejected` /
`human-rejected`. §2's reason for persisting the redacted body — a proposal exists for human review —
is now the mechanism rather than a possibility, and §9's selection metric is measured after that
approval.

## Amendment (2026-09-30, AH-F01): learning without a classifier uses the built-in rules

§5's "classification is the door … 3b does not learn without Jev" no longer holds. When the model
path cannot run — no `skillReflection` classifier, or one whose provider has not consented for the
project and the kind — the manager falls back to the local heuristic classifier (`heuristics.ts`).
It sends nothing off the machine, drafts nothing remotely (its candidate is a local template), and its
proposals go through the same redaction, lint and `proposed` staging, so they still need a person's
approval (AH-A04, ADR-0022). The egress condition on the classification itself is unchanged: the
egress guard still refuses the remote call per project at call time.

The settings writer therefore no longer refuses `learning.enabled = true` without the classifier's
consent (`guard:egress-allowlist-required` is gone for that switch; its guard is `none`). Turning
learning on still asks for confirmation and travels the `learning-draft-egress` warning, because on
the model path the draft goes to the small model's provider and `learning.enabled` is that consent.
When the classifier cannot run, the write also travels `classifier-no-consent` ("reflection uses the
built-in rules only"), and `no-model` is only said on the model path, where a draft is attempted.
