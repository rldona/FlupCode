# ADR-0023: Failure/loop guardrails — deterministic detection, advisory intervention and raise-only tool risk

- **Status:** Accepted
- **Date:** 2026-09-29
- **Related:** ADR-0016 (harness boundary), ADR-0017 (Jev egress and governance), ADR-0019 (learned
  skill lifecycle), ADR-0021 (skill relevance acting), ADR-0022 (loopback auth, retention, rollback),
  `flupcode-adaptive-harness-plan.md` §13 (E7, FH-060–063), `fh-promotion-design.md`

## Context

Phase 8 (E7) is the first adaptive slice that reacts to a **failing or looping** session rather than
to a completed one. The plan asks for three things: detect repeated identical tool calls and repeated
identical errors (FH-060), feed them to a `failure` decision that is deterministic first and can be
refined by Jev (FH-061), and score `toolRisk` so a learned policy may only **raise** confirmation
above the engine's own floor (FH-063). FH-062 asks for intervention, but its original shape — a pause
with a session banner — is not available here:

1. **There is no hook to pause on.** `permission.ask` is only typed in `packages/plugin/src/index.ts`
   and is never dispatched on this runtime; the only native loop guard is the engine's own
   `doom_loop` service (`processor.ts`). Any "pause" the harness could implement would be a second,
   competing guard that the engine does not know about.
2. **The engine already has a native loop guard.** `doom_loop` aborts a turn after a fixed number of
   identical calls. E7 must not consume, emit or modify it; it coexists and only observes.
3. **A failing session is the hottest path there is.** Spending Jev on every tool call is not
   affordable, and shipping raw arguments or messages to any model is not acceptable (the trust
   invariant: learned knowledge never widens a permission and never leaks content).
4. **The `failure` and `toolRisk` kinds already exist** in the decision seam (`decision.ts`) and
   answer safe defaults today; the audit table already stores them. No new table is needed.

The phase rule still holds: every acting decision ships behind a deterministic fallback, is audited,
and is off until a person opts in.

## Decision

### 1. Advisory, never a pause; delivered over the loopback

E7 does not pause, block or mutate a turn. The detector runs on the server, and the engine plugin
that feeds it is a **thin proxy**: it hashes the tool call (or the error) into an opaque digest,
`POST`s it to the loopback harness, and ignores the answer for its own execution. The `failure`
verdict and the raised `toolRisk` are recorded for a human to read; the session banner of FH-062 is
deferred and no new UI ships in this block.

### 2. Delivery is a dedicated loopback route with the `adaptive-token`

`POST /harness/adaptive/guardrails` is guarded by the **same dedicated bearer** as the relevance route
(`adaptive-token`, ADR-0022 §1) and exists only when the service and the token were both resolved; with
no token it is an ordinary 404 and the `adaptive-guardrails` capability is not announced. The installed
plugin `GUARDRAILS_PLUGIN` reads the token from the same `adaptive-token` file and only registers when
base and token resolve; every failure is inert (`void request(...).catch(() => {})`) and never touches
the tool path.

### 3. The detector is pure and deterministic; the state is an in-memory ring of opaque digests

`guardrails-detector.ts` is a pure module: `appendObservation` maintains a per-session ring bounded by
a TTL window and a maximum count, `detectLoop` counts the **consecutive identical** tail of the ring,
and `failureState` maps the signal to a `FailureState`. Only `sha256` digests of canonicalised JSON
travel: no arguments, no messages, no tool output ever leaves the plugin or is stored. A different
argument, an interleaved error or an observation outside the window breaks the streak, so a normal
retry is never a false positive.

### 4. `stepsUsed`/`stepsBudget` are unsupported; zero core diff

The plan's "near-exhaustion of `agent.steps`" is **not** supported: the server has no truthful step
counter and the plan tip-toes around `packages/core`. `FailureState.stepsUsed` stays `0`, no
`stepsBudget` is sent, and the answer's `steps` field is the literal `"unsupported"`. The block makes
**no change** to `packages/core`, `packages/opencode`, `packages/plugin`, Protocol/HttpApi or the SDK.

### 5. `toolRisk` is raise-only

`risk.ts` fixes the order `ALLOW < CONFIRM < REVIEW < DENY`. `clampLearned` caps any learned score at
`CONFIRM`, and `elevateRisk(native, learned)` returns the most restrictive of the native floor and the
**clamped** learned score, so it can never return `DENY` unless the native floor is already `DENY`. The
deterministic `toolRisk` baseline is exactly `state.native ?? "ALLOW"` and never elevates; the Jev
adapter caps its own score with `clampLearned` before the service ever sees it. A learned policy can
therefore only raise confirmation, never allow or deny past `permission.ts`.

### 6. Off by default; no row unless the feature acts

`adaptive.guardrails.enabled` defaults to `false`. With it off, `observe` returns
`{ verdict: "continue", reason: "disabled" }` **before** touching the ring and **without** writing a
row. On a non-legacy runtime it returns `runtime-not-legacy` and likewise writes nothing. Only when the
threshold is crossed does the service run the `failure` and `toolRisk` decisions hot and `shadow: false`,
which is the audit row: the notice is an `adaptive_decision` row with `kind: "failure"`, `shadow: 0`.
The `decisionID` is deterministic (`failure:${sessionID}:${keyDigest}`) and cached, so a loop that
persists neither re-spends Jev nor rewrites the row. Audit is the existing `/harness/adaptive/decisions`
route and `explain`.

### 7. Coexistence with `doom_loop`; `shadow.ts` is untouched

E7 neither reads nor writes the engine's `doom_loop`. The default `repeatedCalls: 3` is aligned to
`DOOM_LOOP_THRESHOLD = 3` but it is an **independent** configuration value, not a shared constant.
`shadow.ts` keeps `SHADOW_KINDS = [completion, skillRelevance]`: guardrails is a separate **hot** route,
not a shadow kind.

## Consequences

Positive:

- A looping or failing session is detected with no model, no network and no new table; the audit is the
  table that already exists.
- Nothing raw leaves the process: only `sha256` digests of canonicalised calls and errors travel, and
  the detector's state is an in-memory ring that a restart clears.
- A learned policy can only raise confirmation; the engine's permission floor is untouched by
  construction and pinned by an exhaustive table test.
- The block is a zero diff on `core`, `opencode`, `plugin`, Protocol/HttpApi and the SDK.

Negative / accepted costs:

- The intervention is advisory only: the turn is not stopped, so the value depends on a human reading
  the audit. The session banner of FH-062 is deferred.
- The ring is process-local and in memory: a restart forgets a loop, and two servers would not share it.
  That is the deliberate price of not adding durable per-observation storage, and it matches the
  "advisory, best-effort" posture.
- `stepsUsed`/`stepsBudget` are unsupported; a steps-based loop is invisible to E7 until a truthful
  counter exists.
- `repeatedCalls` and `DOOM_LOOP_THRESHOLD` are aligned by value, not by a shared constant, so a
  future engine change must be mirrored deliberately.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| Pause the session through `permission.ask` | The hook is never dispatched on this runtime; it would be a second, competing guard. |
| Consume or re-emit the engine's `doom_loop` | The plan and ADR-0016 keep E7 out of core; `doom_loop` is the engine's own guard. |
| A durable observations table | New storage and a new retention problem for an advisory signal; an in-memory ring is enough. |
| Send raw arguments to Jev | Violates the trust invariant and egress posture; only opaque digests travel. |
| A shared `DOOM_LOOP_THRESHOLD` constant | Couples E7 to core internals; the value is aligned deliberately, not imported. |
| Let learned `toolRisk` return `DENY`/`REVIEW` | A learned policy must never exceed the human permission floor (ADR-0019). |
| Write a row on every observation | The audit would grow with the loop; one deterministic row per detected loop is enough. |
| A session banner in this block | FH-062's UI is deferred; no new UI ships with E7. |

## Out of scope

- A real pause/intervention and its session banner (FH-062): the intervention is advisory only.
- `agent.steps` awareness (`stepsUsed`/`stepsBudget`): unsupported, reported as `"unsupported"`.
- Any change to the engine's `doom_loop`, `packages/core`, `packages/opencode`, `packages/plugin`,
  Protocol/HttpApi or the SDK.
- Durable or cross-process loop state.
- Retention of guardrail rows beyond what `adaptive.retention` already covers for `adaptive_decision`.

## Implementation plan

The block lands as the file map and step order in `fh-promotion-design.md` §"Plan de implementación"
(E7 section): the pure detector and risk module, the `failure`/`toolRisk` handlers, the guardrails
config, the service, the loopback route and capability, the installed `GUARDRAILS_PLUGIN`, and an
offline evaluation with fixtures. Acceptance: with `guardrails.enabled=false` no ring is touched and no
row is written; a detected loop writes one `failure` row and is cached; `risk` is `clampLearned` +
`elevateRisk` and never `DENY` unless the native floor is; and `core`, `opencode`, `plugin`,
Protocol/HttpApi and the SDK are byte-identical.
