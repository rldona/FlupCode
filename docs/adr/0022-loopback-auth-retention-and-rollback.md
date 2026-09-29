# ADR-0022: Acting promotion — loopback auth, retention, isolation, reverse-collision and rollback

- **Status:** Accepted
- **Date:** 2026-09-29
- **Related:** ADR-0016 (harness boundary), ADR-0017 (Jev egress and governance), ADR-0018 (context
  selection seam), ADR-0019 (learned skill lifecycle), ADR-0020 (learning persistence and egress),
  ADR-0021 (skill relevance acting), `flupcode-adaptive-harness-plan.md` §11 / §13 (E9) / §15 / §19 /
  §20, `fh-promotion-design.md`

## Context

Phase 4 made skill relevance the first **acting** decision: an installed engine plugin injects a
non-coercive `<skill_relevance>` line, and one `shadow: false` row is audited per turn (ADR-0021).
Promoting that acting feature is not "flip the flag": ADR-0021 itself records the debts that must be
settled first, and the plan's promotion decisions of 2026-09-29 fix the posture. Five concrete gaps
remain.

1. **The loopback peer is unauthenticated.** `RELEVANCE_PLUGIN` reads its token with the same
   `readToken()` as `WEB_ACTIONS_PLUGIN` — `FLUPCODE_BROWSER_TOKEN` from the desktop, else the
   `browser-token` file (`packages/remote/src/engine-plugins.ts:1526-1535`). The server guards
   `/harness/adaptive/relevance` with the same `options.token` and only when it exists:
   `if (options.token && !tokenMatches(...))` (`packages/harness-server/src/api.ts:485-496`). With no
   token configured the route is open on the loopback, and a process that holds — or races for — the
   harness port could answer the relevance `POST` and capture a bearer that also opens
   `/harness/browser/*`, `/harness/actions/*` and `/harness/artifacts`. The plugin's strict
   names-only validation removes the *injection* risk, not the token exposure. ADR-0021 states that a
   dedicated token or a local socket is required before the relevance is activated.
2. **The audit has no retention.** `adaptive_decision` gains one row per turn, and the plan's §19
   follow-up (retention, purge) is still open. A store that only grows is a real cost, but purging
   adaptive data must not remove pending proposals, live evidence, ledgers or rows another row
   references. There is no purge for the adaptive tables today: only `removeExpiredArtifacts()`
   (artifacts) and `evictEvidence()` (evidence) exist, driven by the hourly sweep
   (`packages/harness-server/src/index.ts:57-62`).
3. **The single-flight is shared between the hot and batch paths.** `governor.run` dedupes by
   `governorKey(kind, inputsHash, model)` for both modes
   (`packages/harness-server/src/adaptive/providers/governor.ts:123`), so a `runHot` can join an
   in-flight `runBatch` and wait for the adaptive limiter — violating ADR-0017 §4 ("the hot path
   never queues").
4. **Reverse-collision is unhandled.** The single writer rejects a learned skill when a human skill
   already uses the name (`collides()`, `packages/harness-server/src/adaptive/skills/learned-store.ts:397,446`),
   but a human skill created *afterwards* with the same name is not reconciled. The engine scanner
   normalises "last wins" with unbounded concurrency, so the reader cannot be trusted to keep the
   human skill.
5. **Rollback is unproven and the live evaluation is blocked.** FH-083 asks for documented, tested
   restore, and PoC-3 (Jev quality/latency/cost) is blocked on `TYPESAFE_API_KEY` and environment, so
   only an offline, reproducible evaluation can gate promotion now.

The trust invariant (learned knowledge never creates, widens or bypasses a permission, and never
silently modifies human instructions) remains a rule at the writer. The phase rule stands: evaluation
is a deliverable, not an optional test.

## Decision

### 1. A dedicated `adaptive-token`, a mandatory bearer, and a loopback-only route

The acting loopback peer uses a **dedicated** secret, `<configDir>/adaptive-token` (0600), a sibling
of `browser-token` in the same directory resolved by `flupcodeConfigDir()`
(`packages/harness-server/src/browser-token.ts:15-24`). The harness creates it at its entrypoint
(never the desktop, never through an environment variable); the relevance plugin reads the same file
through the same config directory. `WEB_ACTIONS_PLUGIN` and the browser/artifacts/actions bearer are
unchanged.

`/harness/adaptive/relevance` requires that bearer **unconditionally**: the route exists only when the
service *and* the token are configured, and a missing or wrong bearer is a 403 (or a 404 when no token
was resolved, so the route is simply absent and the `adaptive-relevance` capability is not announced).
There is no "no token ⇒ open loopback" fallback. When the configured hostname is not loopback
(`127.0.0.1`, `::1`, `localhost`), no token is resolved and neither the route nor the capability is
built: the feature is inert off-loopback, even though the harness host is configurable
(`packages/harness-server/src/index.ts:252`).

### 2. Retention is off by default and never purges a live or referenced row

A new `adaptive.retention` slice defaults to `enabled: false`: nothing expires until a human opts in
at activation, consistent with archive-not-delete. When enabled, a single transactional purge covers
only the four adaptive audit tables — `adaptive_decision`, `adaptive_plan`, `reflection_job`,
`skill_proposals` (`packages/harness-server/src/repository.ts:309-403`) — with a window per state:
shadow vs acting decisions, applied vs shadow plans, terminal reflection jobs, and rejected
proposals. A row is judged by `updated_at`, because a deterministic upsert keeps `created_at`.

Hard exemptions are enforced in SQL, not by the caller:

- `skill_proposals` in `proposed` (awaiting human review) or `promoted` (the on-disk sidecar's
  provenance) are never purged;
- `reflection_job` in `pending` is never purged;
- a row referenced by a surviving row is never purged (`adaptive_plan.decision_id`,
  `reflection_job.decision_id`, `skill_proposals.decision_id`, `reflection_job.proposal_id`); this
  protects the on-disk sidecar reference without scanning the filesystem;
- `session_episodes`, `evidence`, `episode_evidence`, `artifacts`, `checkpoints`, `findings` and every
  on-disk artifact (`.ledger.jsonl`, `.versions/`, `.sidecar.json`, the archive) are outside retention
  entirely.

Execution is at startup and on the existing hourly sweep, fail-safe: a purge that throws is logged
and never fails the server, and with retention off no query runs. A malformed value falls back to the
default, never guessed, like the other adaptive slices; a non-positive window falls back to its
default.

### 3. The single-flight is isolated per mode; breaker, budget and limiter stay shared

`governor.run` scopes the single-flight key by mode (`hot`/`batch`), so a live turn can never join an
in-flight background batch and wait for the adaptive limiter (ADR-0017 §4). The circuit breaker, the
monthly budget and the limiter remain shared, and the hot path keeps its own `timeoutMs` deadline.
The accepted cost is that two genuinely identical questions, one hot and one batch, no longer collapse
into one outbound call.

### 4. Reverse-collision: the human wins, through the single writer

When a loaded human skill and a learned skill share a name, the learned skill is **excluded from the
curator roster**: it is never offered by relevance, never selected, never counted as usage, and never
proposed for a patch. Exclusion is fail-closed and lives in the one roster every consumer reads,
rather than in each consumer.

The durable reconciliation runs in `curator.recompute` / `curator.reconcile` (the sweep in
`packages/harness-server/src/adaptive/learning/manager.ts` calls `recompute` when learning is on and
`reconcile` when it is off): it detects the collision from the raw skill report and archives the
learned skill through `store.archive` with reason `human-name-collision`, which makes the human win
on disk too (the learned folder leaves `skills/`, so the engine scanner can no longer pick it by
"last wins"). The move is archive-not-delete and reversible; the sidecar records `state: archived`
and the ledger records the reason. Nothing is written outside the single writer.

The reverse-collision repair is the **one write that runs with learning off**. It is a security move
(a `move` of a self-authored skill out of the scanned tree), not a learning write: `store.archive`
accepts an explicit `security` flag for it, and `curator.reconcile` is not behind the switch. Every
other write — create, patch, sidecar and usage — stays fail-closed with learning off. This closes the
latent hole where the read-time exclusion protected the harness surfaces but the engine's own scanner
could still load the shadowed learned body while learning was off; the human now wins on disk too.
`humanClaimedNames` only counts a human claim whose frontmatter parsed cleanly (or was skipped only
for a name collision), so a malformed human `SKILL.md` can never archive a healthy learned skill.

### 5. Rollback drills prove "back to off without residue"

A kill-switch matrix fixes what each switch stops and states that **nothing is deleted**: data,
learned skills, sidecars, ledgers, snapshots and the archive all persist, and archiving is a move.
Reproducible `bun:test` drills assert:

- **byte-identity**: with relevance off the system prompt is unchanged; with `context.apply=false` the
  run prompt is byte-identical to the unselected one;
- **zero new rows/proposals**: with relevance off no decision is written; with learning off no job or
  proposal is written and no learned file appears; with the master switch off no decision or plan is
  written while episodes are still captured;
- **restore**: a previous skill version is restored through the single writer from its `.versions`
  snapshot, and an archived skill's folder is byte-preserved so moving it back is lossless.

### 6. PoC-3 is offline now; the live evaluation is blocked and documented

Promotion is gated by an **offline** evaluation over a curated labelled set
(`fixtures/relevance/*.json`, ~20 technical English objectives) with recorded Jev answers replayed
through the real `DecisionService` + `JevClient` + `EgressGuard`, no network and no model. It reports
recall@3, wrong-load, precision, degradation, simulated latency and estimated cost for both the
deterministic baseline and the recorded Jev answer, and asserts a threshold: wrong-load zero on every
fixture, recall@3 ≥ 0.80, precision ≥ 0.60, degraded fixtures still wrong-load zero with recall at
least the baseline, and a projected monthly cost within `adaptive.budget.monthlyTokens`. The
threshold gates the offline set, not the default: relevance stays opt-in.

The **live** PoC — real Jev, a real engine with the plugin, measured latency/cost and a human-labelled
sample — is blocked on `TYPESAFE_API_KEY` and environment. The exact procedure is documented and is a
prerequisite before the feature is ever recommended as default-on.

## Consequences

Positive:

- The acting line no longer exposes the browser/artifacts bearer; the dedicated secret is loopback-only
  and fail-closed, so a squatted port cannot capture a broader credential.
- Retention is opt-in and cannot delete a pending proposal, a live row, a referenced row, evidence or
  any on-disk provenance; when off, the store behaves exactly as today.
- A live turn is provably isolated from background Jev work, restoring the ADR-0017 §4 guarantee.
- A human skill always wins a reverse collision, on the harness surfaces and on disk, with an
  auditable, reversible record and no second writer.
- Promotion is backed by reproducible drills and an offline metric; "back to off" is a verified state,
  not a claim.

Negative / accepted costs:

- Two identical questions (hot and batch) no longer dedupe into one call; the extra call is bounded by
  the shared breaker and budget.
- The dedicated token needs both processes to resolve the same config directory; a mismatch leaves the
  feature inert (the plugin does not register), which is the fail-closed posture, not a silent open.
- Retention is a new storage policy to operate; its windows are configuration with conservative
  defaults and it stays off until opted in.
- The live Jev quality/latency/cost claim is still unproven; the offline threshold is explicitly not a
  live result.
- The reverse-collision repair is one deliberate exception to "nothing writes with learning off": a
  reversible `move` that makes the human win on disk, while every other write stays fail-closed.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| Keep the browser/artifacts bearer for `/relevance` | A squatted port captures a credential that opens far more than the line. |
| A local socket instead of a token file | More invasive on both the plugin and the server; the 0600 file matches the existing token pattern. |
| An `FLUPCODE_ADAPTIVE_TOKEN` env injected by the desktop | The desktop must not know or propagate the secret; the shared file keeps it out of the children's env. |
| Leave the route open when no token is configured | That is the exact hole; fail-closed means 404. |
| One retention window for everything | Treats a live acting decision like a bulk shadow row and risks deleting referenced rows. |
| `ON DELETE CASCADE` | Requires a schema migration and changes the existing data model; explicit `NOT EXISTS` guards are contained. |
| Purge episodes or evidence too | That is the live evidence the plan forbids purging, and it would break `explain`. |
| One shared single-flight for hot and batch | A live turn waits for the limiter a batch holds; violates ADR-0017 §4. |
| Separate single-flight maps | Equivalent, but duplicates state and tests; a mode-scoped key is one line. |
| Mark shadowed and filter in each consumer | Fragile; a missed filter offers the shadowed skill. Exclusion in the roster is one fail-closed rule. |
| Archive the learned skill at read time | Writes on the hot path and while learning is off; reconciliation belongs to the sweep. |
| Let the learned skill win (reader first-wins) | The engine's scanner is order-fragile "last wins"; the human is the source of truth. |
| A rollback mode that undoes writes | Needs a compensation journal; archive-not-delete already gives reversibility. |
| Measure the live PoC now | Blocked on `TYPESAFE_API_KEY` and environment; the plan conditions it explicitly. |
| A single-metric gate (wrong-load only) | Cannot tell "suggests nothing" from "suggests well"; recall and precision complement it. |

## Out of scope

- The live PoC (real Jev, a real engine with the plugin): blocked on `TYPESAFE_API_KEY` and
  environment; only its procedure is documented.
- FH-044 (merge) and FH-045 (revive): still deferred; the pool restore is a documented, file-level
  tested manual move.
- FH-080 (trust-boundary tests) and FH-082 (egress/cost audit) as their own tickets; only the
  estimated cost of PoC-3 touches FH-082.
- The global scope and cross-project promotion (FH-081); isolation already holds by construction and a
  cross-project roster test covers the leakage evaluation.
- UIs (FH-025/FH-035/FH-046), the cockpit (FH-070…074), routing (FH-050…053), failure/loop guardrails
  (FH-060…063) and live-session compaction acting (Phase 9).
- Retention of episodes, evidence, artifacts or any on-disk artifact, and any change to `packs.ts`,
  `runner.ts`, `scheduler.ts`, `packages/harness`, Protocol/HttpApi or the SDK.
- Concrete retention windows and PoC-3 thresholds: they are configuration with conservative defaults;
  this ADR fixes the policy, not the numbers.

## Implementation plan

The promotion is the six decisions above, with the file map, step order and verification commands in
`fh-promotion-design.md` §"Plan de implementación". Acceptance: `/relevance` requires the dedicated
bearer and does not exist without it or off-loopback; retention off expires nothing and on purges only
out-of-window, unreferenced rows; a hot call never waits for a batch; a human skill created afterwards
wins and the learned one is archived with a reason; the drills prove byte-identity, zero new rows and
restore; and the offline PoC-3 reports its metric against the threshold while the live evaluation
stays documented as blocked.
