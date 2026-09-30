# ADR-0025: Preregistered promotion criteria for the adaptive capabilities

- **Status:** Proposed — **needs the owner's approval before any live data is looked at.** Until this
  ADR is marked Accepted, `bun run eval:live -- report` must not be run against the real database, and
  no threshold below may be read as agreed.
- **Date:** 2026-09-30 (revised the same day: "Revision (2026-09-30): reachable within one user's usage")
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
| Approved skills used | over `promoted` proposals whose 14-day window (from `updated_at`) closed before `until`: share whose skill (`name`, else `target_skill`) appears in `skills_json` of 2+ distinct sessions within those 14 days (30 days before R17) |
| Content incidents | not stored: the number the owner attests with `--content-incidents <n>` |

`relative` is mean(treatment) ÷ mean(control) − 1 and `difference` is treatment − control.

### 4. Analysis

- **One analysis** per capability, when its window closes: 14 days after `start` or the day the
  minimum sample is reached, **whichever is later**, and **no later than 42 days** after `start`
  (R16). A sample still short at 42 days is a final **insufficient data**; the window is not extended
  and later sessions are not read.
- **Estimate and CI:** the difference (or ratio − 1) between arms, with a **90%** percentile bootstrap
  (a one-sided test at α = 0.05, R12) that resamples sessions within each arm (2,000 resamples, seed
  `ah-g01` plus the metric's key, so the same database always prints the same interval). Heavy-tailed
  per-session sums are compared as a ratio of geometric means with a CUPED project adjustment (R13).
  Learning resamples proposals; the predictive model resamples the sessions its decisions came from; a
  replay resamples fixture pairs (R15).
- **Significance** is part of a primary rule: promotion needs the point estimate past the threshold
  **and** the 90% CI clear of zero on the good side (one-sided α = 0.05).
- **Replay-decided capabilities** (tool-output trim, per-step selection, compaction anchors; R15): the
  primary check reads a paired replay report passed with `report --replay <report.json>`; the live
  holdout still runs and supplies their guardrails and safety stops.
- **Guardrails** are read on the point estimate (see refinement R3).
- A capability that is off in the config during the window is still analysed (its treatment arm is
  then the control), and the report says it was off; the owner should read that as "not evaluated".

### 5. Minimum sample per arm (power)

**Revised (R12–R17).** One-sided α = 0.05, power 0.8, equal arms, and every live minimum within the
owner's budget: ~100 real top-level sessions a week, `holdout.fraction` 0.5, about four weeks, so
**at most 150 sessions per arm** (300 without arms). With k = (z₀.₉₅ + z₀.₈)² = (1.645 + 0.842)²:

- log-scale means (R13): n = 2 k (σ_log / ln(1 + effect))² sessions per arm;
- paired replay (R15): n = k (σ_paired / ln(1 + effect))² fixtures, σ_paired the SD of the
  per-fixture log ratio;
- proportions: n = D k (p₀q₀ + p₁q₁) / (p₁ − p₀)², D the design effect of several units per session;
- one proportion (predictive model): n = ((z₀.₉₅ √(p₀q₀) + z₀.₈ √(p₁q₁)) / (p₁ − p₀))².

`POWER_ASSUMPTIONS` in `criteria.ts` holds each assumption, its minimum and its budget (what 150
sessions per arm plausibly yield at the stated rate); `criteria.test.ts` recomputes every minimum and
fails if one exceeds its budget.

| Capability | Old minimum | New minimum | Budget | MDE and assumption | Instrument |
| --- | --- | --- | --- | --- | --- |
| Tool-output trim | 698 sessions per arm | **22 replay fixtures** × 3 repetitions; 150 sessions per arm for the live guardrails | 30 fixtures; 150 | −15% uncached input, σ_paired 0.3 | replay (`tool-trim.json`) |
| Per-step selection | 698 sessions per arm | **22 replay fixtures** × 3; 150 per arm live | 30 fixtures; 150 | −15% USD, σ_paired 0.3 (threshold stays "< 0") | replay (`selection.json`) |
| Skill suggestion | 1,562 judged decisions per arm | **313 judged decisions per arm**; 150 sessions per arm | 450 (~3 judged per session); 150 | +12 pp correct load (0.50 → 0.62), design effect 1.5; the tool-call alternative −25% on the geometric mean, σ_log 1.0 → 150 sessions | live |
| Predictive model | 194 judged disagreements | **97 judged disagreements** per kind and provider | 105 (~0.35 per session × 300) | uplift 0.25 (62.5% vs 50%) | live (per-decision counterfactual) |
| Loop warnings | 36 judged detections per arm | **16 judged detections per arm**; 150 sessions per arm | 22 (~0.15 per session); 150 | +40 pp stopped (0.20 → 0.60) | live |
| Compaction anchors | 252 compacted sessions per arm | **19 compacting replay fixtures** × 3; 150 per arm live | 20 compacting fixtures; 150 | −25% re-reads per compaction, σ_paired 0.5 | replay (`anchors.json`) |
| Learning | 10 decided; 3 approved with a closed 30-day window | **10 decided; 2 approved with a closed 14-day window** | 18 decided (~3 a week × 6); 2 | not a test | live (human review) |

The original table, kept for the record (two-sided α = 0.05, raw means):

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
its checklist and does not change it. The original paragraph said the trim and selection minimums take
weeks to months at single-user volume and that the rule is to wait; the revision keeps the bar where
the instrument can reach it (replay for trim, selection and anchors) and raises the MDE where it
cannot (R14), instead of waiting a quarter for one analysis.

### 6. No peeking, and safety stops

- `bun run eval:live -- status` shows counts, label coverage, progress towards the minimum sample and
  an ETA per counter from the pace since `start` ("at the current pace the minimum is reached in ~N
  days", flagged when it lands after the 42-day cap), never an effect estimate.
- `report` withholds every primary and guardrail estimate of a capability whose window has not
  closed or whose sample is short, and suggests **insufficient data**. Only the safety checks are
  shown before that.
- **No early stopping except a safety stop.** A safety stop retires the capability at once:
  - completion Δ < −5 pp, or error-rate Δ > +5 pp, once each arm has 30 sessions (so one bad session
    cannot stop it);
  - per-step selection: any request rejected for a broken tool pair in the treatment arm;
  - learning: any attested content incident.
- `start` refuses to move an existing start (it needs `--force`), because moving the window after a
  look is a way of choosing the result. For the same reason `report --replay` refuses a replay report
  that ran before `start`, and more than one report for the same capability.

### 7. Decision table

Applied in this order by `decide()`:

| # | Condition | Suggested decision |
| --- | --- | --- |
| 1 | A safety stop fired | **retire** |
| 2 | Window not closed, or a minimum sample not reached (final once the 42-day cap passed) | **insufficient data** |
| 3 | A guardrail fails on its point estimate | **retire** (§14.2: a gain that worsens a guardrail is a regression) |
| 4 | Every primary check passes (skill suggestion: any), and no required guardrail is unmeasurable | **promote** |
| 5 | A primary check's 90% CI lies wholly on the wrong side of its threshold (skill suggestion: all of them) | **retire** |
| 6 | Otherwise | **keep observing** (the capability stays at its current, opt-in level) |

The suggestion is not the decision: AH-G03 records the owner's decision in its own ADR, and the
"checked by hand" items of each capability are part of that review.

### 8. The criteria

<!-- criteria:begin (generated by `bun run eval:live -- table`; criteria.test.ts checks it) -->
Window: 14 days or the minimum sample, whichever is later, capped at 42 days (then insufficient data). CI: 90% percentile bootstrap by unit (one-sided α = 0.05), 2000 resamples, seed `ah-g01`. Budget: 150 sessions per arm.

| Capability | Randomisation | Primary instrument | Primary (promote when met) | Guardrails | Safety stop | Minimum sample |
| --- | --- | --- | --- | --- | --- | --- |
| Tool-output trim | session (`armFor(…, "toolTrim")`) | replay: `bun run replay -- --variants fixtures/replay/variants/tool-trim.json --repeat 3 --yes`; live: guardrails and safety | Uncached input tokens per session, replay (paired by fixture) Δ (T ÷ B − 1) ≤ −15%; 90% CI upper < 0 | Task completion, replay (paired by fixture) Δ (T − B) ≥ −1 pp; Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; Recall miss (evidence reads per trimmed output), treatment arm < 5% | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 22 paired replay fixtures (3 repetitions per variant); 150 sessions per arm |
| Per-step selection | session (`armFor(…, "selection")`) | replay: `bun run replay -- --variants fixtures/replay/variants/selection.json --repeat 3 --yes`; live: guardrails and safety | USD per session, replay (paired by fixture) Δ (T ÷ B − 1) < 0%; 90% CI upper < 0 | Task completion, replay (paired by fixture) Δ (T − B) ≥ −1 pp; Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; Requests rejected for a broken tool pair, treatment arm ≤ 0 | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp; Requests rejected for a broken tool pair, treatment arm > 0 | 22 paired replay fixtures (3 repetitions per variant); 150 sessions per arm |
| Skill suggestion | session (`armFor(…, "relevance")`) | live | Correct skill load, relative Δ (T ÷ C − 1) ≥ +10%; 90% CI lower > 0 **or** Tool calls per session, ratio of geometric means (T ÷ C − 1, log scale, CUPED by project) ≤ −10%; 90% CI upper < 0 | Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; p95 relevance decision latency, no model, treatment arm < 50 ms; p95 relevance decision latency, with a model, treatment arm < 300 ms | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 313 judged relevance decisions per arm; 150 sessions per arm |
| Predictive model (per kind and provider) | none (no holdout arm) | live | Uplift conditional on disagreement, all units > 0%; 90% CI lower > 0 | USD per useful decision, all units ≤ 0.05 USD (`voi.valueOfCorrect`, default) | — | 97 judged disagreements |
| Loop warnings | session (`armFor(…, "guardrails")`) | live | Detected loops that stopped, Δ (T − C) ≥ +30 pp; 90% CI lower > 0 | Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10%; Detected loops that stopped, control arm < 10% | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 16 judged loop detections per arm; 150 sessions per arm |
| Compaction anchors | session (`armFor(…, "anchors")`) | replay: `bun run replay -- --variants fixtures/replay/variants/anchors.json --repeat 3 --yes`; live: guardrails and safety | Re-reads after compaction per compaction, replay (paired by fixture) Δ (T ÷ B − 1) < 0%; 90% CI upper < 0 | Task completion, replay (paired by fixture) Δ (T − B) ≥ −1 pp; Summary tokens per compaction, replay (paired by fixture) Δ (T ÷ B − 1) ≤ +10%; Task completion, Δ (T − C) ≥ −1 pp; Turns with a tool or provider error, Δ (T − C) ≤ +1 pp; p95 turn duration, relative Δ (T ÷ C − 1) ≤ +10% | Task completion, Δ (T − C) < −5 pp; Turns with a tool or provider error, Δ (T − C) > +5 pp | 19 paired replay fixtures (3 repetitions per variant); 150 sessions per arm |
| Learning | none (no holdout arm) | live | Proposals approved, all units ≥ 10% **and** Approved skills used in 2+ sessions within 14 days, all units ≥ 50% | Content incidents (attested), all units ≤ 0 | Content incidents (attested), all units > 0 | 10 decided proposals; 2 approved skills with a closed 14-day window |
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
  of zero on the good side. §14.3 gave only the point threshold. *(The 95% two-sided CI is superseded
  by R12: a 90% CI, one-sided α = 0.05. The "point and CI" rule stays.)*
- **R3 (all guardrails).** "Completion ≥ −1 pp" is read on the **point estimate**. A non-inferiority
  test with a 1 pp margin would need tens of thousands of sessions; the −5 pp safety stop and the
  guardrail retire rule bound the risk instead.
- **R4 (session capabilities).** §14.2's guardrails without a number get one: error rate Δ ≤ +1 pp
  (turns with a tool error or a provider error) and p95 turn duration Δ ≤ +10%. §14.3's
  "added p95 latency < 20 ms / < 50 ms / < 300 ms" is kept where a stored field measures it (relevance
  `latency_ms`); the trim hook's is checked by hand.
- **R5 (tool-output trim).** *(Still read on the live treatment arm; the primary moved to the replay,
  R15.)* Recall miss is Σ `evidence_read` calls ÷ trimmed outputs, an upper bound
  (paged reads count once each).
- **R6 (per-step selection).** "0 requests rejected" is 0 provider errors naming a tool pair in the
  treatment arm, and any such error is also a safety stop. "Including the cache effect" is satisfied
  because `session_metrics.cost` is the provider's USD, cache reads and writes priced in. *(The USD
  primary is superseded by R15: it is read from the replay's `usd`, the same provider USD; the
  rejected-pair guardrail and safety stop stay live.)*
- **R7 (skill suggestion).** "Correct skill load" is the C06 `skillRelevance` label (§6.5's
  definition). In the treatment arm the line nudges the agent towards the suggested set, so part of an
  uplift is the line being followed; the "ended well" half of the label and the completion guardrail
  are what keep that honest. The alternative "−5% tool calls per task" keeps §14.3's "or". *(Its
  threshold and scale are superseded by R13 and R14: −10% on the ratio of geometric means, powered for
  −25%.)*
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
  check. *(The +30 pp bar stays; the minimum is now powered for +40 pp, R14.)*
- **R10 (compaction anchors).** Not in §14.3; added from AH-D04's acceptance: re-reads after
  compaction per compaction go down (CI upper < 0) and summary tokens per compaction rise by at most
  10%. *(Both checks are kept but superseded in instrument by R15: they are read from a paired replay
  over compacting fixtures, not from compacted live sessions.)*
- **R11 (learning).** "≥ 10% approved" counts decided proposals (promoted ÷ promoted + rejected).
  "Approved skills used in ≥ 2 sessions in 30 days" becomes "≥ 50% of approved skills whose 30-day
  window has closed were loaded by 2+ distinct sessions", counted from `skills_json`, with the approval
  time read as the proposal's `updated_at`. "0 content incidents" is attested by the owner, since no
  field records one; without the attestation learning cannot be promoted. *(The 30-day window and the
  3 approved skills are superseded by R17.)*

Added by the revision of 2026-09-30 (see "Revision" below); each states its trade-off:

- **R12 (all tests). One-sided α = 0.05.** Every primary asks a directional question ("does it help",
  "does it not hurt"), so the test is one-sided at α = 0.05 with power 0.8: the report prints the 90%
  two-sided CI, and a primary is significant when the bound on its good side clears zero (the point
  estimate must still pass the threshold, R2). The retire-as-futile rule reads the same 90% CI.
  *Trade-off:* for the same sample a one-sided test detects an effect about 12% smaller
  ((1.960 + 0.842)² ÷ (1.645 + 0.842)² ≈ 1.26 times fewer units), at the price of never concluding
  "it helps" from an effect in the other direction — which is not a promotion anyway.
- **R13 (heavy-tailed session sums). Log scale and CUPED by project.** Uncached input tokens, USD and
  tool calls per session span orders of magnitude, so a raw mean is carried by a few long sessions.
  They are compared as the **ratio of geometric means**, exp(mean log(1 + x) in T − the same in C) − 1,
  with the power assumption stated on σ_log (the SD of log(1 + x) per session; 1.0 for tool calls).
  The log value is **CUPED-adjusted by project**: y − θ (x_project − x̄), where x_project is the mean
  log value of the same project's sessions in the 28 days before `start` (at least two of them;
  otherwise the session is not adjusted) and θ = cov ÷ var is estimated once on both arms pooled. The
  covariate predates assignment, so the adjustment cannot bias the comparison; θ is 0 when the data
  does not support it. The power calculation does **not** count on the CUPED gain.
  *Trade-off:* the question becomes "the typical session", not "the total bill": a capability that
  saves a lot on a few huge sessions and nothing on the rest reads smaller on the log scale than on the
  raw mean.
- **R14 (per capability). Larger minimum detectable effects where the variance leaves no choice.**
  Skill suggestion: +12 pp correct loads (0.50 → 0.62) with a design effect of 1.5 for ~3 judged
  decisions per session (313 per arm), or −25% tool calls on the geometric mean (150 sessions per
  arm; threshold −10%). Loop warnings: +40 pp stopped (16 judged detections per arm; bar still
  +30 pp). Predictive model: uplift 0.25, model right on 62.5% of disagreements (97 per kind and
  provider). *Trade-off:* only clearly visible effects promote; a real but smaller gain reads as
  "keep observing" (the capability stays opt-in), never as "retire".
- **R15 (tool-output trim, per-step selection, compaction anchors). Replay as primary evidence.**
  Their effect is concentrated in a minority of sessions (large outputs, cold cache boundaries,
  compactions), so an intention-to-treat live comparison dilutes it beyond any single-user budget. A
  paired, controlled replay is the better instrument: the same fixtures run with the capability off
  (baseline) and on, three repetitions each, and the primary is read from paired differences across
  fixtures (geometric mean of the per-fixture ratios for tokens and USD, Σ treatment ÷ Σ baseline for
  re-reads and summary tokens per compaction, the mean difference for completion), with a 90%
  bootstrap over fixture pairs. Minimums: 22 fixtures for trim and selection (σ_paired 0.3, −15%) and
  19 compacting fixtures for anchors (σ_paired 0.5, −25%). The replay also carries a completion
  guardrail (Δ ≥ −1 pp, the replay's own rule) and, for anchors, the summary-token guardrail. The live
  arm still runs with the ≤ 150-per-arm budget and reads the session guardrails, recall miss, the
  rejected-pair stop and the safety stops; its session checks are intention to treat over the whole
  arm (anchors no longer restrict them to compacted sessions). The report takes the replay's
  `report.json` with `--replay`, identifies the capability from the variant that turns it on against a
  baseline that turns it off explicitly, and refuses a report that ran before `start` or a second
  report for the same capability. Commands: `bun run replay -- --variants
  fixtures/replay/variants/{tool-trim,selection,anchors}.json --repeat 3 --yes`.
  *Trade-off:* the replay measures the fixtures, not the owner's live mix; a corpus without large
  outputs or long sessions cannot show an effect, and the replay spends model money (22 fixtures × 2
  variants × 3 repetitions = 132 sessions per capability).
- **R16 (all). A 150-per-arm budget and a 6-week cap.** Every live session minimum is at most 150 per
  arm (the budget: ~100 real sessions a week at `holdout.fraction` 0.5 for about four weeks). For a
  replay-decided capability the 150 sessions are the live guardrail sample, read on the point estimate
  (R3), not a power calculation. The window is the later of 14 days and the minimum sample, **capped at
  42 days**: a sample still short then is a final "insufficient data" and later data is not read.
  *Trade-off:* a capability whose volume is lower than assumed gets no verdict rather than a late one;
  a new window needs `start --force` and is not merged with the old.
- **R17 (learning). A 14-day usage window and 2 approved skills.** "Used in ≥ 2 sessions" is counted
  within 14 days of approval (was 30), and the minimum is 2 approved skills with a closed window (was
  3). With a 42-day cap, a 30-day window would only count approvals from the first 12 days.
  *Trade-off:* a skill that is useful but rare (monthly) reads as unused.

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

## Revision (2026-09-30): reachable within one user's usage

The first version of this ADR was correct but out of reach: at the owner's measured activity (roughly
190–350 engine sessions a week including subagent and routine sessions; planned conservatively as
~100 real top-level sessions a week) trim and selection needed 698 sessions per arm, skill suggestion
1,562 judged decisions per arm and anchors 252 compacted sessions per arm — months to a year of use
for one analysis. The owner set the budget: with `holdout.fraction` 0.5 the window must fit in about
four weeks, so no live minimum above 150 sessions per arm (and matching numbers for decisions,
detections and compactions). What changed, each lever named:

- **One-sided tests (R12):** α = 0.05 one-sided, 90% CI; power stays 0.8.
- **Variance reduction (R13):** log scale (ratio of geometric means) and CUPED by project for the
  heavy-tailed session sums; implemented in the report (`stats.ts` `cuped`, the `geometric` measure)
  and tested.
- **Larger MDEs (R14):** skill suggestion, loop warnings and the predictive model are powered for
  clearly visible effects only.
- **Replay as primary evidence (R15):** tool-output trim, per-step selection and compaction anchors
  are decided by a paired replay (`report --replay <report.json>`); their live arm reads guardrails
  and safety stops within the budget.
- **Window (R16):** the later of 14 days and the minimum sample, capped at 6 weeks, then "insufficient
  data". `status` prints an ETA per counter from the pace since `start`.
- **Learning (R17):** 14-day usage window, 2 approved skills.

Kept unchanged: the unit (session), intention to treat, the guardrails and their margins, the safety
stops, the decision order, the single analysis and no peeking, the criteria frozen at `start`.
Superseded, and marked so in §9: R2's 95% CI (by R12), R6's USD primary source and R10's instrument
(by R15), R7's tool-call threshold (by R13/R14), R11's 30-day window and 3 skills (by R17). The old
§5 table is kept under the new one.

**What may still not be reachable.** The budgets are assumptions, and `status`'s ETA is how the owner
checks them:

- **Predictive model, per-episode kinds** (`completion`, `failure`): one decision per episode or per
  loop, so 97 judged disagreements per kind and provider are unlikely within six weeks (at ~1
  decision per session, 20% disagreement and 60% judged, about 36). They will read "insufficient
  data", and the VOI gate's auto-pause stays their default. Per-turn kinds (`skillRelevance`,
  `contextItem`) are the ones the 0.35-per-session assumption describes.
- **Loop warnings** rest on ~0.15 judged detections per session (22 per arm against a minimum of 16);
  if loops are rarer than that the evaluation ends "insufficient data" at the cap.
- **Learning** rests on ~3 decided proposals a week and ~20% approved; the 2-skill minimum equals its
  budget, with no margin.
- **Replay corpus:** 22 fixtures with large tool outputs, and 19 that compact, have to exist; the
  README aims for 30 fixtures but does not guarantee these kinds.

**Open question for the owner (not changed here).** The guardrails (R3) and safety stops are read on
the point estimate, which the brief says to keep. At 150 sessions per arm that reading is noisy:
assuming ~60% of sessions have a known outcome and a 70% completion rate, the SE of the completion
difference is about 7 pp, so a capability with **no** effect breaches "completion Δ ≥ −1 pp" about
44% of the time and would be retired; the −5 pp safety stop at 30 sessions per arm fires on noise
about 37% of the time per look (about 23% at 150). Together with the error-rate and p95 guardrails, a
harmless capability passes all live guardrails only about a third of the time. The same problem
existed at 698 per arm (about 37% for completion alone). A reading that keeps the guardrails but
retires only on evidence of harm — "retire when the point estimate breaches the margin **and** the 90%
CI excludes zero on the harmful side" — would bring the false-retire rate to at most 5% per guardrail,
at the price of letting a small real harm (below about 17 pp of completion) through, bounded by the
safety stops. That is a policy choice for the owner before `start`.

## Consequences

- The report can only say what these rules say, and it says it with a CI; "it seems to work" is not a
  result (§14.3).
- Most capabilities will need more than two weeks at one person's volume. The window is "14 days or
  the minimum sample, whichever is later" on purpose, capped at six weeks (R16).
- Three capabilities are decided by replay (R15), which spends model money and depends on the corpus;
  the live holdout still guards them.
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
  the report says "insufficient data" instead. The revision lowers them to what **four weeks** can
  deliver only through the named levers (R12–R17), each with a stated assumption, never by shrinking
  the MDE below what the budget can detect.
- **Extending the window until the sample arrives.** Open-ended waiting invites a look "just to see";
  rejected in favour of the 6-week cap (R16).

## Out of scope

- The decision itself and the default changes (AH-G03, its own ADR).
- The context plan acting (`context.apply`) and the frozen kinds (audit §11): not candidates here.
- Changing any setting: `start` prints a checklist and changes nothing.

## Approval

To accept: the owner reviews §3, §5, §7, §8 and §9, changes any number in `criteria.ts` (and
regenerates §8 with `bun run eval:live -- table`), decides the open question on the guardrail reading
(see "Revision"), sets **Status: Accepted** with the date, and only then runs
`bun run eval:live -- start`. The replays for trim, selection and anchors run **after** `start`.
