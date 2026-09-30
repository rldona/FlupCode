# ADR-0025: Preregistered promotion criteria for the adaptive capabilities

- **Status:** Proposed — **needs the owner's approval before any live data is looked at.** Until this
  ADR is marked Accepted, `bun run eval:live -- report` must not be run against the real database, and
  no threshold below may be read as agreed.
- **Date:** 2026-09-30
- **Related:** ADR-0017 (egress and governance), ADR-0021 (skill relevance acting), ADR-0022 (loopback
  auth, retention and rollback), ADR-0023 (failure/loop guardrails), ADR-0024 (cache-aware selection),
  `docs/ADAPTIVE.md` ("Session metrics", "Holdout", "Value-of-information gate", "Tool output trim",
  "Per-step selection", "Compaction anchors", "Promotion and live evaluation (Phase G)"), engineering
  audit 2026-09-30 §6.5, §11 (phase G), §12 (AH-G01/G02/G03) and §14

## Context

Phase G decides the defaults with data: promote what wins, retire what does not (AH-G03). The audit's
own risk for the phase is confirmation bias, and its mitigation is to fix the criteria **before**
looking (AH-G01). §14.3 proposes one line per capability; this ADR turns each line into a rule a
program can apply to the stored fields, with the unit of randomisation, the analysis, the minimum
sample, the stopping rules and the decision table.

What the harness stores today, and what the rules below are written against:

- `session_metrics`: one row per turn (B01) with `input_tokens` (uncached input), `cost` (USD),
  `tool_calls`, `tool_errors`, `tools_json` (calls, errors and bytes per tool), `compactions`,
  `rereads_after_compaction` and `summary_tokens` (D04), `skills_json`, `started_at`, `ended_at` and
  `arms_json`: the session's holdout arms when its first turn was heard of (B05).
- `adaptive_decision`: every decision, with `kind`, `arm`, `source` (`baseline | model | fallback`),
  `provider_id`, `provider_version`, `latency_ms`, `cost_usd`, `answer_json`,
  `baseline_answer_json` and the C06 `label` (`{ outcome, baselineOutcome, source }`, each outcome
  `correct | incorrect | unknown`).
- `session_episodes`: `outcome` (`success | partial | failed | unknown`), `verifications_json`,
  `ended_at`. `tool_evidence`: one row per trimmed output (D02). `skill_proposals`: `status`
  (`proposed | promoted | rejected`), `name`, `target_skill`, `updated_at`.
- `events/<sessionID>.json` (FH-004): the session's `session.error` and `tool.error` events.

The holdout (`armFor(sessionID, capability, fraction)`, `holdout.fraction` default 0.2, at most 0.5)
covered only `relevance` and `guardrails`. Tool-output trim, compaction anchors and per-step selection
acted on every session, so no online comparison of them was possible.

## Decision

### 1. One set of criteria, in one code module

The numbers live in `packages/harness-server/src/adaptive/promotion/criteria.ts` (`CRITERIA`,
`EVALUATION`, `decide`). The table in §8 is generated from that module (`bun run eval:live -- table`)
and `criteria.test.ts` fails if this document and the code disagree. The live report
(`bun run eval:live -- report`, AH-G02) reads the same module. Changing a number after `start` is a
new ADR, not an edit.

### 2. The unit is the session

Randomisation is per session (`armFor`), so the session is the independent unit, and every metric
"per task" is computed **per session**:

- the arm is fixed per session, so turns and episodes of one session are correlated observations,
  not independent ones; analysing them one by one would understate the variance;
- `session_metrics` covers every session, interactive or run, while an episode exists only when the
  coordinator closed one, and its outcome is often `unknown`;
- the bootstrap resamples sessions within each arm, so turn-level and decision-level metrics keep
  their within-session correlation.

Analysis is **intention to treat**: a session counts in the arm `arms_json` recorded, whether or not
the capability acted in it (a paused session, a turn without a large output, a session that never
compacted). A session whose `arms_json` lacks the capability started before that capability had a
holdout and is left out of its comparison.

A session is in the window when its **first** turn started in `[since, until)`. `since` is the time
`bun run eval:live -- start` recorded.

### 3. Metric definitions

Per session `s` in arm `a` (sums over the session's turns in the window):

| Metric | Definition (stored fields) |
| --- | --- |
| Uncached input tokens per session | mean over sessions of Σ `session_metrics.input_tokens` |
| USD per session | mean over sessions of Σ `session_metrics.cost` (provider USD; the predictive model's own USD is in `adaptive_decision.cost_usd` and is judged under "Predictive model") |
| Tool calls per session | mean over sessions of Σ `session_metrics.tool_calls` |
| Task completion | Σ complete ÷ Σ sessions with a known outcome. A session is **complete** when every one of its closed episodes (`ended_at` set) with `outcome ≠ unknown` is `success` and no entry of its `verifications_json` has `ok: false`, the same reading the C06 `completion` label uses. Sessions with no such episode are left out of this metric only |
| Turns with a tool or provider error | Σ turns with `tool_errors > 0` or a `session.error` event between the turn's `started_at` and the next turn's ÷ Σ turns |
| p95 turn duration | nearest-rank p95 of `ended_at − started_at` over every turn of the arm |
| Recall miss | treatment arm: Σ `tools_json.evidence_read.calls` ÷ Σ `tool_evidence` rows (trimmed outputs). An upper bound: a ref paged in several reads counts each read |
| Requests rejected for a broken tool pair | count of `session.error` events in the treatment arm whose message names a tool pair (`tool_use`, `tool_result`, `tool_call_id`) |
| Correct skill load | over `adaptive_decision` rows with `kind = 'skillRelevance'` and an `arm`: Σ `label.outcome = 'correct'` ÷ Σ `label.outcome ∈ {correct, incorrect}`. C06 marks a row correct when the skills loaded in the turn and the next two equal the answer's `load` and the turn ended without a `session.error` (audit §6.5) |
| p95 relevance decision latency | nearest-rank p95 of `latency_ms` of the treatment arm's `skillRelevance` rows, split by `source`: `model` (with a model) or not (no model) |
| Detected loops that stopped | over `kind = 'failure'` rows with a judged label: the loop persisted when (`answer.verdict = 'intervene'`) equals (`label.outcome = 'correct'`); stopped otherwise. Share stopped |
| Re-reads after compaction per compaction | over sessions with `compactions > 0`: Σ `rereads_after_compaction` ÷ Σ `compactions` |
| Summary tokens per compaction | same sessions: Σ `summary_tokens` ÷ Σ `compactions` |
| Uplift conditional on disagreement | per (kind, `provider_id`, `provider_version`), over `source = 'model'` rows whose label judged both answers: among rows whose canonical `answer_json ≠ baseline_answer_json`, acc(model) − acc(baseline) — the VOI gate's `valueStats` (AH-C05) |
| USD per useful decision | per the same group: Σ (`cost_usd` + `voi.kinds.<kind>.latencyCostUsdPerSecond` × `latency_ms`/1000) over its `model`/`fallback` rows ÷ useful decisions (disagreed, model correct, baseline incorrect) |
| Proposals approved | over `skill_proposals` created in the window with `status ∈ {promoted, rejected}`: share `promoted` |
| Approved skills used | over `promoted` proposals whose 30-day window (from `updated_at`) closed before `until`: share whose skill (`name`, else `target_skill`) appears in `skills_json` of 2+ distinct sessions within those 30 days |
| Content incidents | not stored: the number the owner attests with `--content-incidents <n>` |

`relative` is mean(treatment) ÷ mean(control) − 1 and `difference` is treatment − control.

### 4. Analysis

- **One analysis** per capability, when its window closes: 14 days after `start` or the day the
  minimum sample is reached, **whichever is later**.
- **Estimate and CI:** the difference (or ratio − 1) between arms, with a 95% percentile bootstrap
  that resamples sessions within each arm (2,000 resamples, seed `ah-g01` plus the metric's key, so the
  same database always prints the same interval). Learning resamples proposals; the predictive model
  resamples the sessions its decisions came from.
- **Significance** is part of a primary rule: promotion needs the point estimate past the threshold
  **and** the 95% CI clear of zero on the good side.
- **Guardrails** are read on the point estimate (see refinement R3).
- A capability that is off in the config during the window is still analysed (its treatment arm is
  then the control), and the report says it was off; the owner should read that as "not evaluated".

### 5. Minimum sample per arm (power)

Two-sided α = 0.05, power 0.8, equal arms. Means: n = 2 (z₀.₉₇₅ + z₀.₈)² (CV / effect)².
Proportions: n = (z₀.₉₇₅ + z₀.₈)² (p₀q₀ + p₁q₁) / (p₁ − p₀)². The function and assumptions are in
`criteria.ts` (`POWER_ASSUMPTIONS`), and the test recomputes each minimum.

| Capability | Minimum | Assumption |
| --- | --- | --- |
| Tool-output trim | 698 sessions per arm | CV of uncached input per session 1.0; true effect −15% |
| Per-step selection | 698 sessions per arm | CV of USD per session 1.0; true effect −15% (only cold boundaries trim, so a smaller true effect will read as "keep observing") |
| Skill suggestion | 1,562 judged relevance decisions per arm | correct-load rate 0.50 in control, +10% relative (0.55). The tool-call alternative (−5%, CV 1.0) would need 6,280 sessions per arm and is read with whatever sample the first one reached |
| Predictive model | 194 judged disagreements per group | model right on 60% of disagreements (uplift 0.2) against 50% |
| Loop warnings | 36 judged detections per arm | 20% of detected loops stop in control; true uplift +30 pp |
| Compaction anchors | 252 compacted sessions per arm | CV of re-reads per compacted session 1.0; true effect −25% |
| Learning | 10 decided proposals and 3 approved skills with a closed 30-day window | not a test: at 10 decided, one approval is 10% |

With the default 20% share the control arm fills four times slower than with equal arms. **During the
window `holdout.fraction` should be 0.5** (the largest the resolver accepts); `start` prints this in
its checklist and does not change it. At single-user volumes (tens of sessions a day) the trim and
selection minimums take weeks to months; that is the honest price of a 15% effect with a CV of 1, and
the rule is to wait, not to lower the bar.

### 6. No peeking, and safety stops

- `bun run eval:live -- status` shows counts, label coverage and progress towards the minimum sample,
  never an effect estimate.
- `report` withholds every primary and guardrail estimate of a capability whose window has not
  closed or whose sample is short, and suggests **insufficient data**. Only the safety checks are
  shown before that.
- **No early stopping except a safety stop.** A safety stop retires the capability at once:
  - completion Δ < −5 pp, or error-rate Δ > +5 pp, once each arm has 30 sessions (so one bad session
    cannot stop it);
  - per-step selection: any request rejected for a broken tool pair in the treatment arm;
  - learning: any attested content incident.
- `start` refuses to move an existing start (it needs `--force`), because moving the window after a
  look is a way of choosing the result.

### 7. Decision table

Applied in this order by `decide()`:

| # | Condition | Suggested decision |
| --- | --- | --- |
| 1 | A safety stop fired | **retire** |
| 2 | Window not closed, or a minimum sample not reached | **insufficient data** |
| 3 | A guardrail fails on its point estimate | **retire** (§14.2: a gain that worsens a guardrail is a regression) |
| 4 | Every primary check passes (skill suggestion: any), and no required guardrail is unmeasurable | **promote** |
| 5 | A primary check's 95% CI lies wholly on the wrong side of its threshold (skill suggestion: all of them) | **retire** |
| 6 | Otherwise | **keep observing** (the capability stays at its current, opt-in level) |

The suggestion is not the decision: AH-G03 records the owner's decision in its own ADR, and the
"checked by hand" items of each capability are part of that review.

### 8. The criteria

<!-- criteria:begin (generated by `bun run eval:live -- table`; criteria.test.ts checks it) -->
Window: 14 days or the minimum sample, whichever is later. CI: 95% percentile bootstrap by unit, 2000 resamples, seed `ah-g01`.

| Capability | Randomisation | Primary (promote when met) | Guardrails | Safety stop | Minimum sample |
| --- | --- | --- | --- | --- | --- |
| Tool-output trim | session (`armFor(…, "toolTrim")`) | Uncached input tokens per session, relative Δ (T ÷ C − 1) ≤ −15%; 95% CI upper < 0 | Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; Recall miss (evidence reads per trimmed output), treatment arm < 5% | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 698 sessions per arm |
| Per-step selection | session (`armFor(…, "selection")`) | USD per session, relative Δ (T ÷ C − 1) < 0%; 95% CI upper < 0 | Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; Requests rejected for a broken tool pair, treatment arm ≤ 0 | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp; Requests rejected for a broken tool pair, treatment arm > 0 | 698 sessions per arm |
| Skill suggestion | session (`armFor(…, "relevance")`) | Correct skill load, relative Δ (T ÷ C − 1) ≥ +10%; 95% CI lower > 0 **or** Tool calls per session, relative Δ (T ÷ C − 1) ≤ −5%; 95% CI upper < 0 | Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; p95 relevance decision latency, no model, treatment arm < 50 ms; p95 relevance decision latency, with a model, treatment arm < 300 ms | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 1562 judged relevance decisions per arm |
| Predictive model (per kind and provider) | none (no holdout arm) | Uplift conditional on disagreement, all units > 0%; 95% CI lower > 0 | USD per useful decision, all units ≤ 0.05 USD (`voi.valueOfCorrect`, default) | — | 194 judged disagreements |
| Loop warnings | session (`armFor(…, "guardrails")`) | Detected loops that stopped, Δ (T − C) ≥ +30 pp; 95% CI lower > 0 | Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; Detected loops that stopped, control arm < 10% | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 36 judged loop detections per arm |
| Compaction anchors | session (`armFor(…, "anchors")`) | Re-reads after compaction per compaction, relative Δ (T ÷ C − 1) < 0%; 95% CI upper < 0 | Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; Summary tokens per compaction, relative Δ (T ÷ C − 1) ≤ +10% | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 252 sessions with a compaction per arm |
| Learning | none (no holdout arm) | Proposals approved, all units ≥ 10% **and** Approved skills used in 2+ sessions within 30 days, all units ≥ 50% | Content incidents (attested), all units ≤ 0 | Content incidents (attested), all units > 0 | 10 decided proposals; 3 approved skills with a closed 30-day window |
<!-- criteria:end -->

Checked by hand at G03 (not stored per call, so not in the table): the trim hook's added p95 latency
< 20 ms (measured offline, as the D02 tests do); loop warnings against the engine's native
`doom_loop`, whose firing and the user's aborts are not recorded where the harness can read them; and
0 installations without approval (ADR-0022), which the tests enforce.

### 9. Refinements of §14.3, listed

Every place this ADR departs from, or makes precise, the audit's §14.3 line:

- **R1 (all).** "Per task" is **per session** (§2). §14.1's completion ("no reopening in 24 h") is
  read as "every known episode of the session succeeded with green checks"; a reopening is not stored,
  and a later failed episode of the same session already makes the session incomplete.
- **R2 (all primaries).** A primary threshold needs the point estimate past it **and** a 95% CI clear
  of zero on the good side. §14.3 gave only the point threshold.
- **R3 (all guardrails).** "Completion ≥ −1 pp" is read on the **point estimate**. A non-inferiority
  test with a 1 pp margin would need tens of thousands of sessions; the −5 pp safety stop and the
  guardrail retire rule bound the risk instead.
- **R4 (session capabilities).** §14.2's guardrails without a number get one: error rate Δ ≤ +1 pp
  (turns with a tool error or a provider error) and p95 turn duration Δ ≤ +10%. §14.3's
  "added p95 latency < 20 ms / < 50 ms / < 300 ms" is kept where a stored field measures it (relevance
  `latency_ms`); the trim hook's is checked by hand.
- **R5 (tool-output trim).** Recall miss is Σ `evidence_read` calls ÷ trimmed outputs, an upper bound
  (paged reads count once each).
- **R6 (per-step selection).** "0 requests rejected" is 0 provider errors naming a tool pair in the
  treatment arm, and any such error is also a safety stop. "Including the cache effect" is satisfied
  because `session_metrics.cost` is the provider's USD, cache reads and writes priced in.
- **R7 (skill suggestion).** "Correct skill load" is the C06 `skillRelevance` label (§6.5's
  definition). In the treatment arm the line nudges the agent towards the suggested set, so part of an
  uplift is the line being followed; the "ended well" half of the label and the completion guardrail
  are what keep that honest. The alternative "−5% tool calls per task" keeps §14.3's "or".
- **R8 (predictive model).** "Cost per useful decision < agreed threshold" is ≤ the kind's
  `voi.kinds.<kind>.valueOfCorrect` (0.05 USD by default), recorded at `start`, with latency priced by
  `latencyCostUsdPerSecond` — the same weights the VOI gate uses. There is no session holdout: the C06
  label scores both the model and the baseline on the same outcome, so each decision carries its own
  counterfactual.
- **R9 (loop warnings).** Aborts after a warning are not observable (the events plugin drops aborts,
  and `doom_loop` is not recorded). "Useful aborts > 30%" becomes "the share of detected loops that
  stopped is ≥ 30 pp higher with the warning than without it" (treatment − control), and "false
  warnings < 10%" becomes "< 10% of detected loops stop on their own in the control arm", i.e. the
  detector's natural false-positive rate. "Retire if it adds nothing over `doom_loop`" stays a manual
  check.
- **R10 (compaction anchors).** Not in §14.3; added from AH-D04's acceptance: re-reads after
  compaction per compaction go down (CI upper < 0) and summary tokens per compaction rise by at most
  10%.
- **R11 (learning).** "≥ 10% approved" counts decided proposals (promoted ÷ promoted + rejected).
  "Approved skills used in ≥ 2 sessions in 30 days" becomes "≥ 50% of approved skills whose 30-day
  window has closed were loaded by 2+ distinct sessions", counted from `skills_json`, with the approval
  time read as the proposal's `updated_at`. "0 content incidents" is attested by the owner, since no
  field records one; without the attestation learning cannot be promoted.

### 10. Holdout coverage

`HOLDOUT_CAPABILITIES` was `["relevance", "guardrails"]`. This ADR's change adds `toolTrim`,
`anchors` and `selection`, each drawn independently by `armFor`:

- **Tool-output trim:** the `POST /harness/adaptive/tool-trim` route answers `trimmed: false,
  reason: "holdout"` for a control session, after the size and exemption checks and before anything
  is stored, so the output reaches the model whole.
- **Compaction anchors:** the anchors route answers no block for a control session.
- **Per-step selection:** `GET /harness/adaptive/selection` carries `holdoutFraction`, and the plugin
  draws the session's arm with the same `sha256("selection:" + sessionID)` bucket as `armFor`. A
  control session is offered the off policy and latches it like a paused one, so it never trims and
  never rewrites a warm cache; a malformed share holds nothing out.
- `session_metrics.arms_json` records all five arms from then on (`armsFor`).

The predictive model and learning have no session holdout by design (R8, and the human review is
learning's control). With the default share of 0.2, 20% of sessions now also go without the trim,
the selection and the anchors whenever those are on; compaction anchors are on by default, so this is
the one visible change for a user who never touched the settings.

## Consequences

- The report can only say what these rules say, and it says it with a CI; "it seems to work" is not a
  result (§14.3).
- Most capabilities will need more than two weeks at one person's volume. The window is "14 days or
  the minimum sample, whichever is later" on purpose.
- Anchors, which were on for every session, are withheld from the control share. That is the cost of
  knowing whether they help.
- The criteria are frozen at `start`: changing one means a new ADR and a new `start --force`, and the
  old window is abandoned, not merged.

## Alternatives considered

- **Per-episode analysis.** More units, but correlated within a session and randomised per session;
  it would overstate precision. Rejected (§2).
- **Sequential testing with early stopping on the primary.** Faster, but it needs an alpha-spending
  plan that nothing here can enforce by hand. Rejected in favour of one analysis plus safety stops.
- **Guardrails as non-inferiority tests.** The right tool at scale, infeasible at single-user volume
  (R3).
- **Lowering the minimum samples to what two weeks can deliver.** That would promote noise. Rejected;
  the report says "insufficient data" instead.

## Out of scope

- The decision itself and the default changes (AH-G03, its own ADR).
- The context plan acting (`context.apply`) and the frozen kinds (audit §11): not candidates here.
- Changing any setting: `start` prints a checklist and changes nothing.

## Approval

To accept: the owner reviews §3, §5, §7, §8 and §9, changes any number in `criteria.ts` (and
regenerates §8 with `bun run eval:live -- table`), sets **Status: Accepted** with the date, and only
then runs `bun run eval:live -- start`.
