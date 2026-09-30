# ADR-0017: Jev egress and governance

- **Status:** Accepted
- **Date:** 2026-09-28
- **Related:** ADR-0012 (deterministic secret check and precedence), ADR-0014 (redaction, candidate gating, invariant that memory is data), ADR-0016 (harness boundary), `docs/CONFIGURATION.md`

## Context

The Adaptive Harness uses **Jev** (TypeSafe, `POST /v1/systemone`) as an optional decision engine: it
answers typed `choice`/`score`/`noul` questions with probabilities and confidence. Jev is **not an
LLM** (`flupcode-adaptive-harness-plan.md` §6): it does not stream text, call tools or hold a
conversation, and it is never the reasoning model. Text generation stays with the configured
`small_model`, exactly as memory extraction already works. Removing Jev must leave every feature
working at reduced quality (`flupcode-adaptive-harness-plan.md` §5.1, principle 3).

Phase 1 was local-only: it wrote episodes and evidence to SQLite with no model call. The learning loop
is the first place observed content would reach a model, so redaction and an explicit egress posture
are prerequisites, not a hardening phase (`flupcode-adaptive-harness-plan.md` §11, "Three rules gate
every phase"). This ADR settles pending decisions #3 and #4 of the Top 10 — the Jev egress posture and
the budget/timeout policy — and Open Question #5.

With Jev disabled, the harness must behave exactly as it did before Jev existed: the same deterministic
answers, no network call, no audit row of a Jev call.

## Decision

### 1. Egress is opt-in per project; Jev is off by default

Three independent conditions must all be true before any state can leave the process
(`fh-phase2-design.md` §7.1):

- `adaptive.jev.enabled` — global, **off by default**;
- the `projectID` is listed in `adaptive.egress.projects` — **opt-in per project**;
- `adaptive.egress.kinds[kind]` is true — an allowlist per decision kind, **all false by default**.

`TYPESAFE_API_KEY` comes from the environment, never from the config block (amended 2026-09-30: the
key may also come from the encrypted vault, see the Amendment below). The project list lives in
the global config; reading a project-local `.opencode` override is out of scope for Phase 2.

### 2. Redaction and the egress guard are a rule at the writer

There is **one** function that serializes state outward, `EgressGuard.prepare`
(`adaptive/egress.ts`), and the Jev provider calls `allows` and throws
`DecisionUnavailable("egress-denied")` **before** it builds any body. No other code path issues a
`fetch` to Jev.

`prepare` bounds the state to `maxInputTokens`, applies `redactSecrets` against known values, and
sweeps deterministic patterns (Bearer tokens, `sk-…` keys, AWS keys, PEM blocks, `password=` /
`api_key=` in URLs), then returns the redacted body, its hash and a structured summary. This follows
ADR-0014's deterministic secret check and its invariant that observed content is data, never an
instruction. The harness does not build a separate `Guardrail` component in the MVP; the invariant is
a rule at every writer that injects learned content (`flupcode-adaptive-harness-plan.md` §11).

### 3. Audit stores a redacted summary, never raw state

`adaptive_decision` stores `inputs_hash` plus `state_summary_json`: a bounded, redacted summary built
by `DecisionService` (counters, ids, digests, bounded fragments). It **never** stores raw state,
prompts, file contents or tool output. `answer_json`/`baseline_answer_json` carry labels, ids and
scores only; the episode payload stays in `episode_evidence` and `explain` walks to it by
`evidence_refs` (`fh-phase2-design.md` §4.1). The audit therefore never retains what egress would not
let out.

### 4. Batching: `predictOne` on the hot path, `predictMany` for batch

- **`predictOne`** answers one state with a strict timeout on the hot path. It **never queues**: it
  respects only the circuit breaker and the budget, so a background batch cannot delay a live turn.
  The hot-path `timeoutMs` is 400 ms by default (`fh-phase2-design.md` §1.2
  `DEFAULT_DECISION_POLICY`), tunable.
- **`predictMany`** serves batch and background work (reflection backlog, re-scoring, fan-out). It
  runs behind an **adaptive limiter** (AIMD: concurrency halves on 429/529 and respects
  `Retry-After`, recovering one slot every `restoreEvery` successes), with **single-flight** dedupe by
  `(kind, inputsHash, modelVersion)` and answer **assembly by question id**, never by arrival order.
- A second request is issued only when the first answer changes the evidence (for example, a skill
  shortlist).

### 5. Circuit breaker and monthly budget: soft cap disables Jev, never refuses the session

Both modes share one circuit breaker and one monthly token budget (`fh-phase2-design.md` §3). The
breaker opens after consecutive failures and lets one half-open probe through after a cooldown. The
budget is per UTC month, persisted in `adaptive_usage` so it survives restarts, and reserves a
fraction for the hot path so a batch cannot spend what the live turn needs. Jev does not report
input usage, so the estimated cost is reserved (persisted) before the call and that reservation **is**
the spend: there is no reconciliation, so a call that fails after sending is conservatively
over-counted rather than under-counted. For a soft cap, the safe direction is to count too much, not
too little.

When the budget is exhausted, Jev is **disabled and logged** for the rest of the month; the harness
**never refuses a session**. The budget value is configuration with a conservative default; this ADR
fixes the policy, not a number.

### 6. Version pin and deterministic fallback

Each decision records the versioned `model` returned by Jev; thresholds are tuned against a pinned
version (`jev-1.13.0` in the plan's audit) and re-tuned on upgrade. `DecisionRequest` is versioned in
code, not data.

Every prediction point has a non-Jev path. Any failure — timeout, network, 429/529, 401, malformed
body, low confidence, egress denied, breaker open, budget exhausted — returns the deterministic answer
with `degraded: true` and a `DegradedReason`. The deterministic baseline is stored alongside the
answer so `explain` never re-executes and never spends.

## Consequences

Positive:

- The user controls whether any state leaves the machine, per project and per decision kind; the
  default is no egress at all.
- With Jev off, the harness is exactly the deterministic harness: no network, no cost, no behavioral
  change.
- Every decision is auditable and explainable from stored rows alone, without replaying a call.
- Cost and rate limits are bounded by a persisted budget and an adaptive limiter rather than a fixed
  pool.

Negative / accepted costs:

- Redaction cannot be complete; pattern sweeps can over-redact legitimate technical text, so patterns
  are conservative and tested against technical content.
- Jev does not report input usage, so the budget relies on a token estimate; the default is
  conservative and `onLog` makes the spend auditable.
- Thresholds are per-decision and risk-scaled, which means recalibration is needed when the pinned
  model version changes.
- The audit store deliberately keeps only a redacted summary, so some explanation context lives in the
  episode and is reached indirectly.

## Amendment (2026-09-30): the key may also come from the encrypted vault

The settings panel could only report whether `TYPESAFE_API_KEY` was set, so a reader who wanted the
predictive model had nowhere to put its key. The key may now also come from the harness's encrypted
credential vault (`vault.ts`, AES-256-GCM under the vault key):

- It is stored as the credential `typesafe-api-key`, bound to the **origin of `jev.endpoint`**, so a
  key saved for one host is never sent to another after the endpoint changes.
- The **environment keeps precedence**: when `TYPESAFE_API_KEY` is set it is the key, and the panel
  only reports it. It is **never** read from the config block.
- The Jev client asks for the key **on every request** (environment first, then the vault), so a key
  saved or removed takes effect without a restart.
- `PUT`/`DELETE /harness/adaptive/model-key` write it behind the settings writer's bearer and
  require `confirm: true`; `GET` answers `{ source: "env" | "stored" | "none", storable }`. No answer
  ever carries the key, and the capability `adaptive-model-key` is announced only with that bearer.
- A stored key is among the egress redaction secrets (every vault value is, decrypted on each call),
  as is the environment's key.
- Without a vault key nothing can be stored; the panel says so and points to the environment variable.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| Global opt-in only (no per-project list) | Violates the "opt-in per project" posture the plan fixes for Phase 2. |
| Jev on by default with a kill switch | Any default-on posture sends bounded state without an explicit per-project decision; the plan requires opt-in. |
| A separate `Guardrail` service | The plan defers the component; the invariant is enforced at the writer, which is the only place that can guarantee no unredacted body is built. |
| Rely only on `redactSecrets` of known values | Does not catch a secret that is not on the list; hence the deterministic pattern sweep. |
| Send raw state and redact the response | The data has already left the process. |
| A fixed concurrency pool for batch | Breaks under 429/529 without backpressure; the plan explicitly rejects it. |
| One `run` entry with an internal queue | The hot path would sit behind batch work, adding head-of-line latency to the live turn. |
| In-memory budget | It resets with the process and lets spend escape the monthly cap. |

## Out of scope

- Acting guardrails and tool-risk enforcement (`flupcode-adaptive-harness-plan.md` §17, excluded from
  the MVP).
- Model and agent routing (FH-051–053).
- Any egress of state that has not been redacted by the writer.
- A project-local `.opencode` override for the egress allowlist.
- Concrete budget numbers: the value is config with a conservative default.
