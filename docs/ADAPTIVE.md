# Adaptive Harness

> **Status.** Phase 1 (observability) is **done** (FH-000–007, PR #368). Phase 2 (decision
> foundation) is **done** ([ADR-0016](adr/0016-adaptive-harness-boundary.md) /
> [ADR-0017](adr/0017-jev-egress-and-governance.md)). Phase 3a (selection seam) is **done**
> ([ADR-0018](adr/0018-context-selection-seam.md)). Phase 3b (learning loop) is **done**: its
> decisions are [ADR-0020](adr/0020-learning-persistence-and-egress.md) and
> [ADR-0019](adr/0019-learned-skill-lifecycle.md). Phase 4 (skill relevance, the first **acting**
> decision) is **in progress**; its decision is
> [ADR-0021](adr/0021-skill-relevance-acting.md). The learning UI (FH-035/FH-046) is deferred; the
> read surfaces exist as `GET /harness/adaptive/proposals` and `/harness/adaptive/learned-skills`.
> This is a skeleton: the sections below are filled
> in as each phase lands, not a complete manual. The full plan and the phase designs live in the
> working notes under `.flupcode/artifacts/`, which are intentionally not versioned; this file is the
> versioned summary.

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
| `ContextManager` | Model context items, score and plan | Phase 3a (done) | [ADR-0018](adr/0018-context-selection-seam.md) |
| `LearningManager` / `ReflectionEngine` | Episode → reflection → proposal, promotion, read routes | Phase 3b (done) | [ADR-0020](adr/0020-learning-persistence-and-egress.md) |
| `SkillCurator` / `SkillStore` | Sole writer of learned skills; lifecycle and usage | Phase 3b (done) | [ADR-0019](adr/0019-learned-skill-lifecycle.md) |
| `RelevanceService` / `rankSkills` / `renderSkillLine` | Suggest skills for a turn; pure rank and names-only line | Phase 4 (in progress) | [ADR-0021](adr/0021-skill-relevance-acting.md) |
| `RELEVANCE_PLUGIN` | Capture the objective and inject the line over the loopback endpoint | Phase 4 (in progress) | [ADR-0021](adr/0021-skill-relevance-acting.md) |

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

The selection seam is what skill relevance and skill probation depend on (plan §7); skill relevance is
now acting — see [Skill relevance](#skill-relevance).

## Learning

Phase 3b closes the loop from an episode to a proposal. It hangs off episode close
(`onEpisodeClosed`) plus a startup `sweep`, exactly like the shadow, so reflection **never blocks or
fails a run**. The design is fixed by [ADR-0020](adr/0020-learning-persistence-and-egress.md).

- **Deterministic evidence gate and cadence.** An episode must clear a deterministic gate —
  `minToolCalls` **and** at least one bounded signal (a verification, a touched file, a failure) —
  before any model call. A quiet episode produces **zero** jobs and zero spend; a busy episode
  produces **at most one**. The cadence is a safety net, not the trigger, and a job is terminal after
  its first attempt: a second close or the sweep never re-reflects.
- **Jev classifies; the small model drafts.** A dedicated `skillReflection` decision answers
  *reusable?*, *which intent?* (`add`/`patch`; `merge`/`drop` are rejected with a reason) and *which
  existing skill?*. Its deterministic baseline is **inert** (`reusable: false`), so with Jev off
  there is no proposal. The draft text is generated by the configured small model through the engine
  — `adaptive.learning.model`, falling back to the global `small_model`; with neither, the job is
  `no-model` and the engine is not called. The transcript is bounded to `learning.maxInputChars` and
  the drafted `name`/`description`/`body` are redacted and bounded before they are stored.
- **Persisted, reviewable, idempotent.** Two additive tables hold the state: `reflection_job`
  (primary key `episode_id`, one per episode) and `skill_proposals` (id `proposal:<episodeID>`). A
  proposal stores its `body` redacted and bounded **and** its `body_hash`, because it exists for
  human review before promotion; storing only the hash would force a second draft to inspect it.
- **Egress is opt-in and off by default.** The `skillReflection` classification needs
  `adaptive.jev.enabled` **and** the project in `adaptive.egress.projects` **and**
  `adaptive.egress.kinds.skillReflection`. The draft needs `adaptive.learning.enabled` **and**
  `adaptive.egress.enabled` **and** the project in `adaptive.egress.projects`; its text is passed
  through `EgressGuard.redact` and bounded. Learning is therefore project-scoped and inert until a
  person opts in.
- **Kill switches stop the loop; they never delete.** Already-written skills stay on disk and keep
  loading.

| Control | What it stops | What it does not touch |
| --- | --- | --- |
| `adaptive.learning.enabled = false` (default) | reflection jobs, `skillReflection` classification, the draft and the curator's writes | already-written learned skills, and the `completion`/`skillRelevance` shadow |
| `adaptive.enabled = false` / `FLUPCODE_ADAPTIVE_DISABLED=1` | additionally, every decision and the shadow | episodes, evidence, base harness, learned skills |
| `adaptive.jev.enabled = false` (default) | classification degrades to the inert baseline ⇒ no proposal | learned skills keep loading |
| project absent from `egress.projects`, or `egress.kinds.skillReflection = false` | no egress ⇒ no classification and no draft | learned skills keep loading |
| no `learning.model` and no `small_model` | the draft ⇒ job `no-model`; no write | learned skills keep loading |

- **Measurement.** The falsifiable claim of 3b is **selection/recall**, offline: a PROBATION skill
  is selected by the deterministic `skillRelevance` shadow for the objective it should serve, with
  zero wrong-load over labelled episodes. Outcome improvement is not measurable until Phase 4
  injects the selection, and is not claimed here.

## Skills

Learned skills are written by a single writer, `SkillCurator`, through `SkillStore`, and are
provenance-carrying files the engine loads like any other. The design is fixed by
[ADR-0019](adr/0019-learned-skill-lifecycle.md).

- **One project-scoped root, scannable by the real engine.** A learned skill lives at
  `<project>/.opencode/skills/flupcode-learned/<name>/SKILL.md`, a non-hidden directory inside the
  tree the engine scans with `{skill,skills}/**/SKILL.md` and `dot: false`. The archive and the
  auxiliary roots live **outside `skills/`** (`<project>/.opencode/flupcode-learned-archive/`) so
  they are never re-loaded. The learned root can be overridden in tests with
  `FLUPCODE_ADAPTIVE_LEARNED_ROOT` (and the archive with `FLUPCODE_ADAPTIVE_LEARNED_ARCHIVE`).
- **Only the curator writes, and never a human skill.** Every write passes a realpath containment
  guard, must carry the `self-authored: true` marker, and is rejected if any skill **outside** the
  learned root already uses the name — the only real defence against the engine's order-fragile
  "last wins". A human skill is never modified, moved or deleted.
- **Provenance and rollback on disk.** Each skill carries `.sidecar.json` (state, version,
  `contentHash`, source, evidence refs, usage) and an append-only `.ledger.jsonl`; patches snapshot
  the previous body to `.versions/<hash>.txt`, keeping the last `SNAPSHOT_KEEP = 5`. Install is
  atomic (temp + rename), so an interruption leaves either a complete skill or nothing visible, and
  archive is a **move**, never a delete.
- **Lifecycle.** `PROBATION → MATURE → STALE → ARCHIVED` (`MERGED` is declared but not reached in
  3b). `NEW` is the state of a *proposal* before install; on disk a skill starts in `PROBATION`,
  which is **not evictable**. Graduation is by `load`; archival happens only without recent `load` and
  `view`, so a used skill never archives itself. The `LearningManager` sweep drives the lifecycle: it
  re-evaluates every project a sweep touched, gated by `adaptive.learning.enabled`, and each
  transition is durable, so a repeat is a no-op.
- **Usage is opportunity-relative, not wall-clock.** `load` counts selection by `skillRelevance`,
  `patch` counts improvements, `opportunities` counts every time the skill could have been chosen,
  and the rate is `recallRate = load / max(opportunities, 1)`. `view` counts the harness re-reading a
  body to prepare a `patch`; there is no seam to observe the model opening a skill, so `view == 0`
  still means "unknown", not "unused".
- **The permission ceiling is a rule in the writer.** A learned skill can never create, widen or
  bypass a permission; it is at most one more skill, evaluated by the engine like any other.

## Skill relevance

Phase 4 is the first **acting** decision: at the start of a turn the harness suggests which skills
might be relevant and an engine plugin injects a single non-coercive line. The design is fixed by
[ADR-0021](adr/0021-skill-relevance-acting.md).

- **What is injected.** One fixed `<skill_relevance>` block, **names-only** and **non-coercive**:

  ```
  <skill_relevance>Possibly relevant skills: alpha, beta, gamma. Consider loading one only if it clearly applies; otherwise ignore.</skill_relevance>
  ```

  The only variable content is skill **names**, each validated against the loaded roster and `NAME`;
  the top-`maxSkills` (3) are ordered by a pure rank over the decision's `answer.load`, and the
  underlying selection is unchanged. No descriptions, permissions or instructions travel in the line,
  so a false positive cannot displace a correct choice or widen a permission.
- **Where.** The acting seam is a thin-proxy engine plugin (`RELEVANCE_PLUGIN`,
  `packages/remote/src/engine-plugins.ts`): it captures the turn's objective in
  `experimental.chat.messages.transform`, posts it to the loopback endpoint
  `POST /harness/adaptive/relevance`, and pushes the line in `experimental.chat.system.transform`.
  **The server is the only policy**; the plugin decides nothing and never throws. It is registered
  whenever base+token resolve, so the kill switch is instantaneous, and the endpoint takes the same
  bearer as `/harness/browser/*` and `/harness/actions/*`. The engine→harness call is **local, not
  egress**, so it does not cross the [ADR-0017](adr/0017-jev-egress-and-governance.md) boundary.
- **Off by default.** `adaptive.relevance.enabled=false` is the default: the plugin still posts, but
  the server returns `line: null` and nothing is injected. With the feature on and Jev off, the
  **deterministic lexical line is still injected** — the lexical path is the fallback, and turning
  relevance off (not Jev) restores the previous behaviour. Enabling it is gated on the offline
  evaluation, not a configuration change alone.
- **Inertness.** `system` is **byte-identical** whenever the feature is off, the master kill switch
  (`adaptive.enabled=false` / `FLUPCODE_ADAPTIVE_DISABLED=1`) is on, the runtime is not `legacy`, there
  is no fresh objective, or there is no roster, no candidate, an absent server, a timeout, a non-200,
  invalid JSON or an exception. Two accepted limits come from the hook surface:
  `system.transform` fires on **every** request and cannot discriminate its type, and the hook
  **blocks the turn**, bounded only by the timeout.
- **Relationship to ADR-0016/0017.** The seam stays inside the
  [ADR-0016](adr/0016-adaptive-harness-boundary.md) boundary: only `packages/harness-server` and
  `packages/remote` change, the plugin observes and injects over the legacy hook surface, the runtime
  probe gates it, and no core is touched. Relevance adds **no new egress condition** on top of
  ADR-0017: the Jev call it may make is the existing one (`adaptive.jev.enabled` +
  `egress.projects` + `egress.kinds.skillRelevance`), redacted and bounded by the same guard.
- **Measurement.** The merge gate is an **offline** evaluation comparing the deterministic line against
  a recorded Jev answer — wrong-load and recall, determinism, inertness, one request and trust. Live
  behaviour is validated by PoC-3 before promotion; outcome improvement is not claimed here.

## Decisions

_Landed in Phase 2. Documents the seven decision kinds, the audit and `explain`, and the shadow
mode that records decisions without acting on them
([ADR-0017](adr/0017-jev-egress-and-governance.md)). Phase 3b adds the `skillReflection` kind
(eight in total), whose deterministic baseline is inert — see [Learning](#learning)._
