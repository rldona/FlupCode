# Adaptive Harness

> **Status.** Phase 1 (observability) is **done** (FH-000–007, PR #368). Phase 2 (decision
> foundation) is **done** ([ADR-0016](adr/0016-adaptive-harness-boundary.md) /
> [ADR-0017](adr/0017-jev-egress-and-governance.md)). Phase 3a (selection seam) is **done**
> ([ADR-0018](adr/0018-context-selection-seam.md)). Phase 3b (learning loop) is **done**: its
> decisions are [ADR-0020](adr/0020-learning-persistence-and-egress.md) and
> [ADR-0019](adr/0019-learned-skill-lifecycle.md). Phase 4 (skill relevance, the first **acting**
> decision) is **in progress**; its decision is
> [ADR-0021](adr/0021-skill-relevance-acting.md), and the **promotion of the acting line** —
> loopback auth, retention, hot/batch isolation, reverse-collision and rollback, with PoC-3 as its
> offline gate — is in progress under [ADR-0022](adr/0022-loopback-auth-retention-and-rollback.md).
> The **cockpit** (E8, FH-070–074) is landed: the settings switches and the read-only
> decisions/plan/learned inspectors live in `packages/harness`, and the write contract is
> `PATCH /harness/adaptive/config` — see [The cockpit (E8)](#the-cockpit-e8). A drafted skill is
> installed only when a person approves it (AH-A04, see [Human approval](#human-approval)); editing,
> merging and archiving from the UI (FH-035/FH-046) stay deferred. The read surfaces are
> `GET /harness/adaptive/proposals` and `/harness/adaptive/learned-skills`.
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
- **Claimed before it spends.** A pass first inserts the episode's `pending` job (insert-if-absent)
  and reflects only if it created it, so a restart mid-draft or two harness processes on one database
  never classify or draft the same episode twice. The claim carries `claimed_at` and a 10-minute lease:
  a `pending` job older than that belongs to a process that died, and the sweep takes it over
  (`attempts` counts the claims) instead of leaving it `pending` forever.
- **Jev classifies; the small model drafts.** A dedicated `skillReflection` decision answers
  *reusable?*, *which intent?* (`add`/`patch`; `merge`/`drop` are rejected with a reason) and *which
  existing skill?*. Its deterministic baseline is **inert** (`reusable: false`), so with Jev off
  there is no proposal. The draft text is generated by the configured small model through the engine
  — `adaptive.learning.model`, falling back to the global `small_model`; with neither, the job is
  `no-model` and the engine is not called. The transcript is bounded to `learning.maxInputChars` and
  the drafted `name`/`description`/`body` are redacted and bounded before they are stored. The
  `contains-secrets` lint reads the draft **before** redaction: a draft carrying a secret (a pattern
  or a known literal) is stored redacted with status `rejected`/`contains-secrets` and is never
  installed.
- **Draft timeout.** The draft session waits up to `learning.draftTimeoutMs` (default 120 s, not the
  `skillReflection` decision deadline); past it, or on any failure, the session is interrupted and the
  job is `draft-failed`. The throwaway "Skill draft" session is deleted whatever the outcome.
- **Persisted, reviewable, idempotent.** Two additive tables hold the state: `reflection_job`
  (primary key `episode_id`, one per episode) and `skill_proposals` (id `proposal:<episodeID>`). A
  proposal stores its `body` redacted and bounded **and** its `body_hash`, because it exists for
  human review before promotion; storing only the hash would force a second draft to inspect it.
- **Nothing installs without approval.** The manager lints a draft against the roster and stops: a
  clean one is stored as `proposed` (job `done`, reason `proposed`), a failing one as `rejected` with
  the lint reason, and nothing is written under `skills/` either way — `patch` proposals included.
  See [Human approval](#human-approval).

### Human approval

The draft is built from an episode's objective and evidence, and evidence can carry untrusted tool
output (a web page, a README, an issue). A skill installed from it unreviewed would be a prompt
injection that persists into every later session of the project, so the only path from `proposed`
to `skills/` is a person (AH-A04).

- **`POST /harness/adaptive/proposals/:id/approve`** with `{ "confirm": true }` installs the proposal
  through the curator → store (the single writer, which signs the provenance) and marks it
  `promoted`. Without `confirm: true` it is a `422 confirmation-required`.
- **`POST /harness/adaptive/proposals/:id/reject`** marks it `rejected` with reason `human-rejected`.
- **Bearer.** Both require the artifacts bearer, like `PATCH /harness/adaptive/config`: with no token
  configured they are an ordinary `404`, and a wrong or missing bearer is a `403`. The capability
  `adaptive-proposals-review` is announced only when that bearer exists.
- **Idempotent.** Approving a `promoted` proposal, or rejecting a `rejected` one, is a `200` no-op
  (`changed: false`). Approving a `rejected` one, or rejecting a `promoted` one, is a
  `409 not-proposed`; an unknown id is a `404`.
- **Re-validated at approval time.** The lint runs again against the live roster (a human skill with
  the same name that appeared since the draft, a `patch` target that is gone, contains-secrets, …) and
  the stored body must still match its `body_hash`. A failure is a `409` with the reason as `code`,
  and the proposal is closed as `rejected` with that reason. Only `disabled` (learning off),
  `no-project` and `write-failed` leave it `proposed` to try again later.
- **In the app.** The Skills screen's **Learned** section shows **Approve** / **Reject** on each
  `proposed` row when the capability is announced; Approve opens a confirmation with the skill's
  name, description and full body.
- **Egress is opt-in and off by default.** The `skillReflection` classification needs
  `adaptive.jev.enabled` **and** the project in `adaptive.egress.projects` **and**
  `adaptive.egress.kinds.skillReflection`. The draft needs `adaptive.learning.enabled` **and**
  `adaptive.egress.enabled` **and** the project in `adaptive.egress.projects`; its text is passed
  through `EgressGuard.redact` and bounded. Learning is therefore project-scoped and inert until a
  person opts in.
- **The draft leaves by a different door than Jev.** `adaptive.egress.enabled` mirrors
  `adaptive.jev.enabled`, but the draft itself (up to `learning.maxInputChars` of the redacted
  objective and evidence) goes to the **small model's provider** through the engine, not to Jev. So
  turning `learning.enabled` on needs its own `confirm: true`, the write travels the warning
  `learning-draft-egress`, and the config view names the resolved model in `learningDraft.model`
  (`provider/model`, or `null`). A dedicated egress consent for the draft is a later change.
- **Redaction.** `adaptive/redaction.ts` deletes known literals first — the environment's
  secret-named values, the browser and adaptive bearers and every vault credential (decrypted on each
  call, so a credential saved after startup is covered), in the raw, HTML-escaped and URL-encoded
  shapes `redact.ts` also covers — then sweeps credential shapes: bearer and `Authorization: Basic`,
  JWTs, Anthropic/OpenAI-style `sk-`, Stripe `sk_/rk_` live/test, Google, AWS, GitHub `gh*_` and
  `github_pat_`, Slack `xox*-`, npm `npm_`, URL credentials and query secrets, private-key blocks,
  `.env`/YAML/JSON assignments to secret-named keys (the key is kept), and 40+-character tokens mixing
  upper case, lower case and digits. Lower-case hex (git SHAs, sha256, the HMAC opaque ids), UUIDs
  and engine ids are left alone.
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
- **Kept out of git.** Before an install makes a skill visible, the store appends
  `/.opencode/skills/flupcode-learned/` to `<project>/.git/info/exclude` if it is not there already, so
  `git add .` does not commit and share what this machine learned. The user's `.gitignore` is never
  touched. Only a real `.git` directory counts: outside git, with a symlinked `.git`, `.git/info` or
  `exclude`, or with a `.git` file (a worktree or submodule, whose exclude lives in the common git
  dir) nothing is written. A failure here never fails the install.
- **Only the curator writes, and never a human skill.** Every write passes a realpath containment
  guard, must carry the `self-authored: true` marker, and is rejected if any skill **outside** the
  learned root already uses the name — the only real defence against the engine's order-fragile
  "last wins". A human skill is never modified, moved or deleted.
- **Containment covers every file, and provenance is the harness's.** A repository can commit a
  learned-looking folder, so nothing inside it is trusted. A skill folder (or its `.versions/`) that
  holds a symlink, a special file or a hard-linked file is refused whole (`unsafe-entry`); temps get a
  random name created exclusively, and the ledger is opened with `O_NOFOLLOW`, so no write ever goes
  through a planted link. The `self-authored` marker only says "learned": the sidecar's `provenance`
  (an HMAC over the folder name and `contentHash` under the per-installation key) proves the harness
  wrote it. Patch, sidecar updates, archive and the reverse-collision `reconcile` act only on a skill
  whose provenance verifies; anything else is read-only (`unverified`), carries no state in the
  roster and is logged when `reconcile` skips it. Skills written before provenance existed, or whose
  sidecar is lost or lags the body after a crash, are read-only too, not rebuilt.
- **Provenance and rollback on disk.** Each skill carries `.sidecar.json` (state, version,
  `contentHash`, `provenance`, source, evidence refs, usage) and an append-only `.ledger.jsonl`; patches snapshot
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
  still means "unknown", not "unused". A selection counts **once per episode**: the shadow never runs
  two passes of one episode at a time, and the sidecar remembers the last 32 episodes it counted
  (`countedEpisodes`), so a startup sweep racing a close cannot count an opportunity twice.
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
  whenever base+token resolve, so the kill switch is instantaneous. Phase 4 guarded the endpoint with
  the same bearer as `/harness/browser/*` and `/harness/actions/*`; the acting promotion replaces it
  with a dedicated `adaptive-token` (see [Acting promotion](#acting-promotion-in-progress)) so a
  squatted loopback port cannot capture a broader credential. The engine→harness call is **local, not
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
  **blocks the turn**, bounded only by the timeout. Both are kept cheap: an answer inert because the
  feature or master switch is off or the runtime is not `legacy` carries `retryAfterMs` (60 s, the
  probe's cadence), and the plugin skips the call until it expires (capped at 10 min), so turning
  relevance back on reaches turns within about a minute. Three consecutive failures (timeout,
  network, non-200, invalid JSON) open a plugin-side breaker for 60 s; then one half-open request
  closes it on success or reopens it on failure.
- **Relationship to ADR-0016/0017.** The seam stays inside the
  [ADR-0016](adr/0016-adaptive-harness-boundary.md) boundary: only `packages/harness-server` and
  `packages/remote` change, the plugin observes and injects over the legacy hook surface, the runtime
  probe gates it, and no core is touched. Relevance adds **no new egress condition** on top of
  ADR-0017: the Jev call it may make is the existing one (`adaptive.jev.enabled` +
  `egress.projects` + `egress.kinds.skillRelevance`), redacted and bounded by the same guard.
- **Measurement.** The merge gate is an **offline** evaluation comparing the deterministic line against
  a recorded Jev answer — wrong-load and recall, determinism, inertness, one request and trust. Live
  behaviour is validated by PoC-3 before promotion; outcome improvement is not claimed here.

## Acting promotion (in progress)

Promoting the acting line is not a flag flip: [ADR-0022](adr/0022-loopback-auth-retention-and-rollback.md)
fixes the debts [ADR-0021](adr/0021-skill-relevance-acting.md) recorded, and the code lands as this
promotion. The plan's promotion decisions of 2026-09-29 set the posture; the sections below describe
what the promotion fixes and, where it is not landed yet, what stands today.

- **Loopback auth of the relevance.** The acting endpoint stops sharing the browser/artifacts/actions
  bearer. A **dedicated** secret `<configDir>/adaptive-token` (0600) is created by the harness at its
  entrypoint and read by `RELEVANCE_PLUGIN` from the same config directory; `WEB_ACTIONS_PLUGIN` and
  the shared bearer are untouched. `POST /harness/adaptive/relevance` requires that bearer
  **unconditionally** — fail-closed: a missing or wrong bearer is a 403, and with no token resolved the
  route and the `adaptive-relevance` capability are simply absent (404), never an open loopback.
  Off-loopback (`127.0.0.1`, `::1`, `localhost`) the feature is inert: no token, no route. The
  endpoint requires the dedicated bearer and `RELEVANCE_PLUGIN` reads only `adaptive-token`, while the
  shared bearer keeps guarding `browser/*`, `actions/*`, `credentials/*`, `artifacts` and `events` as
  before.
- **Retention (`adaptive.retention`).** Off by **default**: nothing expires until a person opts in,
  consistent with archive-not-delete. When on, one transactional purge covers only the four adaptive
  audit tables (`adaptive_decision`, `adaptive_plan`, `reflection_job`, `skill_proposals`) with a
  window per state, judged by `updated_at`. **Never purged**: proposals in `proposed` or `promoted`,
  `pending` reflection jobs, any row referenced by a surviving row
  (`decision_id`/`proposal_id`), and — outside retention entirely — episodes, evidence, artifacts and
  every on-disk artifact (`.ledger.jsonl`, `.versions/`, `.sidecar.json`, the archive). Execution is
  at startup and on the existing hourly sweep, fail-safe; with retention off no query runs.
- **Hot/batch isolation.** The single-flight key is scoped per mode (`hot`/`batch`), so a live turn
  never joins an in-flight background batch and waits for the adaptive limiter; breaker, budget and
  limiter stay shared, and the hot path keeps its own deadline (ADR-0017 §4). The accepted cost is
  that one identical question hot and one batch no longer collapse into a single call.
- **Retries, feedback and budget.** A hot call makes a single attempt and never sleeps on a
  `Retry-After`; a batch retry waits at most `maxDelayMs` (the `Retry-After` is capped, the limiter
  still pauses for all of it) and the wait ends when the caller aborts. The governor records each
  flight's outcome once, so joiners of one failed call count one breaker failure and one limiter
  back-off. Every attempt reserves its estimate (a retry the budget cannot cover is not made), an
  open breaker refuses before the budget is touched, and the budget limits are read from the live
  config, so a `budget.monthlyTokens` change is enforced without a restart.
- **Reverse-collision: the human wins.** If a loaded human skill and a learned skill share a name, the
  learned one is excluded from the curator roster (fail-closed: never offered, selected, counted or
  proposed for a patch) and reconciled durably — archived through the single writer with reason
  `human-name-collision`, so the human wins on disk too. The repair is the one curator write that runs
  **even with learning off**, treated as a security move (a reversible `move`, not a learning write):
  the engine's own scanner can no longer load the shadowed body over the human. A malformed human
  `SKILL.md` is not a claim and never archives a healthy learned skill.
- **Rollback and kill switches.** Nothing is deleted — data, learned skills, sidecars, ledgers,
  snapshots and the archive persist, and archiving is a move. Reproducible drills assert byte-identity
  (relevance off leaves `system` unchanged; `context.apply=false` leaves the run prompt byte-identical),
  zero new rows/proposals when a switch is off, and lossless restore of a previous `.versions` snapshot
  or of the archived pool.

| Control | What it stops | What it does not touch | Decision |
| --- | --- | --- | --- |
| `adaptive.enabled=false` / `FLUPCODE_ADAPTIVE_DISABLED=1` | decisions, shadow, Jev, relevance (`disabled`), learning, context plan | episodes, evidence, base harness, already-written rows and skills | ADR-0017 |
| `adaptive.relevance.enabled=false` | the line (`system.push`; a `POST` per turn returns `line: null`) | the rest of decisions/shadow | ADR-0021 |
| `adaptive.learning.enabled=false` | reflection, classification, draft, and every curator write **except** the reverse-collision security repair | skills already on disk (they keep loading), shadow | ADR-0020 |
| `adaptive.context.apply=false` | the run-prompt filtering (prompt byte-identical) | the shadow plan (`applied=0`) | ADR-0018 |
| `adaptive.shadow=false` | episode decisions/plans | relevance (has its own flag) | ADR-0017 |
| `adaptive.jev.enabled=false` | any Jev attempt; learning stays inert | the lexical line when relevance is on | ADR-0017 |

- **PoC-3 is the promotion gate.** It is built **offline** now — a curated labelled set, recorded Jev
  answers, and a threshold (wrong-load zero on every fixture, recall@3 ≥ 0.80, precision ≥ 0.60,
  degradation without wrong-load and recall at least the baseline, cost within
  `adaptive.budget.monthlyTokens`). The **live** PoC (real Jev, a real engine with the plugin,
  measured latency/cost) is **blocked on `TYPESAFE_API_KEY`** and environment; its procedure is
  documented and it is a prerequisite before the feature is ever recommended as default-on. The
  threshold gates the offline set, not the default: relevance stays opt-in.

## Guardrails

E7 (FH-060–063, [ADR-0023](adr/0023-failure-loop-guardrails.md)) detects a **failing or looping**
session and records an **advisory** intervention. It never pauses, blocks or mutates a turn: the
engine plugin only reports, the server decides, and the app shows a dismissible **`warn` banner**
while the loop is live. Nothing is paused — the turn keeps running — and the reader may open the
decisions or dismiss the banner.

- **Off by default.** `adaptive.guardrails.enabled=false` (the default) makes `observe` return
  `{ verdict: "continue", reason: "disabled" }` **before** touching any state and **without** writing
  a row. On a non-legacy runtime it returns `runtime-not-legacy` and likewise writes nothing.
- **Delivery.** `POST /harness/adaptive/guardrails`, guarded unconditionally by the dedicated
  `adaptive-token` ([ADR-0022](adr/0022-loopback-auth-retention-and-rollback.md)); with no token the
  route and the `adaptive-guardrails` capability are absent (404). `GUARDRAILS_PLUGIN` reads the same
  `adaptive-token` file, hashes each call's arguments (or the tool's error message) with a canonical
  `sha256`, and `POST`s **only the digest** fire-and-forget. It never blocks the tool path, never
  reads the verdict and never mutates `output`.
- **Detection is pure.** `guardrails-detector.ts` counts the **consecutive identical** tail of a
  per-session ring, so a changed argument, an interleaved error or an observation outside the window
  breaks the streak: a normal retry is never a false positive. `failure` intervenes when
  `repeatedCalls` or `repeatedErrors` reaches its threshold (default `3`, aligned to the engine's
  `DOOM_LOOP_THRESHOLD` but an independent config value).
- **State is in memory and bounded.** A ring per session (a `windowMs` window, `maxObservations`
  entries) and at most `maxSessions` rings; a restart forgets them. `agent.steps` is **not**
  supported: `stepsUsed` is `0`, no `stepsBudget` is sent and the answer reports `steps:
  "unsupported"`.
- **The notice is the audit.** No new table: a detected loop writes one `adaptive_decision` row with
  `kind: "failure"`, `shadow: 0`, a deterministic id (`failure:${sessionID}:${keyDigest}`) and the
  `failure` and `toolRisk` decisions. A persistent loop is cached within the window, so it does not
  re-spend Jev or rewrite the row; the audit is `/harness/adaptive/decisions` and `explain`.
- **The advisory banner (FH-062).** While a session is selected, the cockpit reads
  `GET /harness/adaptive/guardrails/status?sessionID=` under the artifacts bearer (read-only, no
  acting token) and paints a dismissible banner over the conversation when the same in-memory ring
  crosses a threshold. It carries only opaque state — reason, counts, tool, `decisionID`, risk and
  time — never content, and it clears itself when the streak breaks, the window expires or the
  feature is off. The dismissal is per `decisionID` and in memory: a new loop arms it again and a
  session change forgets it. It is a warning only, and the turn is never stopped.
- **`toolRisk` is raise-only.** `clampLearned` caps any learned score at `CONFIRM` and
  `elevateRisk(native, learned)` returns the most restrictive of the native floor and the clamped
  score, so a learned policy can only raise confirmation and can never reach `DENY` unless the native
  floor already is. The deterministic baseline is exactly `state.native ?? "ALLOW"` and never
  elevates.
- **Coexistence.** E7 neither consumes nor modifies the engine's own `doom_loop`; it only observes.
  `shadow.ts` is untouched: guardrails is a separate hot route, not a shadow kind.

| Control | What it stops | What it does not touch | Decision |
| --- | --- | --- | --- |
| `adaptive.guardrails.enabled=false` | the ring, the decisions and every row (returns `disabled`) | the turn, the tool path, any other adaptive surface | ADR-0023 |
| a non-legacy runtime | the ring and the decisions (returns `runtime-not-legacy`) | the turn, the tool path | ADR-0023 |
| the advisory banner (`warn`) | nothing — it warns and is dismissible, it never stops the turn | the turn, the tool path, `doom_loop` | ADR-0023 |

## Session metrics

The cost baseline every later phase is measured against (AH-B01). Nothing measured what an ordinary
chat turn spent: the usage screen only knows runs, and the engine only keeps session totals.

- **Capture.** `SESSION_METRICS_PLUGIN` (`flupcode-session-metrics.js`) reads the engine's own events —
  each provider step's usage and cost (`step-finish` on the legacy runtime, `session.next.step.ended`
  on V2), each finished tool, each compaction and each `skill` load — and `POST`s them fire-and-forget
  to `/harness/adaptive/metrics`. Only counts, ids, timings and model/tool/skill names travel: no
  prompt, argument or output. A slow or absent harness never delays a turn; a lost observation is a
  gap in the baseline.
- **Storage.** `session_metrics` keeps one row per turn — the user message that opened it — with the
  provider requests, uncached input, output, reasoning, cache read/write tokens, USD, time in model
  steps, time to first output, tool calls, errors and output bytes (overall and per tool), compactions
  and the skills loaded. Every session is covered, interactive or run, because the engine emits the
  same events for both. `session_metric_seen` makes each observation count once and is pruned after
  two days.
- **Access.** The `POST` takes the dedicated `adaptive-token`; without one it is a 404 and the
  `adaptive-metrics` capability is absent. `GET /harness/adaptive/metrics?sessionID=` returns one
  session's turns to the browser under the artifacts bearer.
- **Summary (AH-B02).** `GET /harness/adaptive/metrics/sessions?since=&directory=&limit=` adds every
  session's turns up in one read, under the same artifacts bearer: tokens by kind, USD, the cached
  share (`cacheRead / (input + cacheRead + cacheWrite)`), nearest-rank p50/p95 of the turn duration
  (`endedAt - startedAt`) and of the time to first token, and the tools ranked by output bytes. A turn
  counts when it ended inside the window (`since`, epoch ms) and belongs to the project (`directory`,
  the metrics' project id). Sessions come newest first, cut to `limit` (50 by default, 200 at most);
  the totals cover them all. The arithmetic is the pure `summariseSessions` in
  `adaptive/session-summary.ts`.
- **Where it shows.** The **Cost** screen draws a **Sessions** block under the runs, sharing their
  window and project filter. It asks only when `/harness/health` lists `adaptive-metrics`, says so
  when the server does not, says so when nothing was measured in the window, and reports a failed
  read inline with **Try again**.

## Holdout

Each acting capability leaves a share of sessions alone, so its effect can be measured against a
control arm instead of assumed (AH-B05, audit §14.2).

- **Assignment.** `armFor(sessionID, capability, fraction)` hashes `capability:sessionID` with
  `sha256`: a session keeps its arm across turns and restarts, and each capability draws its own.
  `holdout.fraction` sets the control share: 0.2 by default, anything from 0 to 0.5 is accepted, and
  0 turns the holdout off.
- **Control arm.** The decision is still made and audited with `arm: "control"`, but it is not
  applied. The relevance line is withheld (`reason: "holdout"`). A guardrail loop answers `continue`,
  and its status is never shown to the browser.
- **Where it shows.** `adaptive_decision.arm` holds it, and the Decisions screen marks a held-out row.
  `session_metrics.arms_json` stores the session's arms when a turn is first heard of, so costs can be
  split by arm.

## Replay corpus and runner

The offline half of the validation strategy (AH-B04): the same work, asked again, so a change is
measured against numbers rather than impressions. `packages/harness-server/src/replay/`.

- **Corpus.** `bun run replay:export -- --session <id>` writes one redacted fixture to
  `packages/harness-server/fixtures/replay/`: the user's prompts in order, agent, model, project folder
  (home written as `~`), git commit and an optional `--verify` command. No assistant or tool output is
  kept. Prompts pass through the shared redaction plus a home-path sweep. The folder is git-ignored
  apart from its README and one synthetic example; a fixture is committed only after review.
- **Runner.** `bun run replay -- --variants <file> --repeat 3 --yes` replays each fixture × variant ×
  repetition in a throwaway session inside a fresh engine worktree (`--in-place` opts out), then runs
  the verify command there. A variant may override the model or agent, point at another engine, or
  patch `flupcode.adaptive` through the settings surface (restored afterwards).
- **Report.** `report.json` and `report.md`: uncached input, cached and output tokens, USD and wall
  time per repetition (from `session_metrics`, else the engine's transcript), verification, and mean,
  p50 and spread per fixture × variant. The engine takes no sampling seed, so the report records
  `seed: null` and pins the model on every prompt; "reproducible" is every repetition within ±5% of
  the mean in total tokens and USD.
- **Cost.** Without `--yes` it only prints the plan; under `CI` it refuses. Tests use a stub engine.

## The cockpit (E8)

E8 makes the opt-ins visible and movable from the app, and nothing more. It does not add acting
behaviour: the switches it exposes are the ones the engine already reads, and turning a switch off is
always safe.

- **Where it is.** A dedicated **Adaptive** group in Settings (`AdaptiveSettingsPanel`), a
  **Context plan** block in the Context screen (FH-072), a **Decisions** screen (FH-071) and a
  **Learned** section in the Skills screen (FH-073). None of them changes the engine; the one write in
  the Learned section is approving or rejecting a staged proposal ([Human approval](#human-approval)).
- **When a read fails.** A non-2xx on any of those routes (a rotated token, a purged decision, a
  restarting sidecar) is said inline where the list or explanation would be, with **Try again**; the
  rest of the app keeps working. Each of those screens also has its own render boundary, mounted only
  while it is open.
- **What the app may write.** Only the switches in the allowlist below; every other field of
  `flupcode.adaptive` is read-only in E8. The server's `writable` list is the whole contract, and the
  UI draws a control only from it, so a field the server does not list is never offered. While a
  write is in flight every control is disabled, so a double click cannot send two patches built from
  the same view, and an unsaved budget draft survives a write to another switch.

  | Writable leaf | Type | Guard before it can be set | Confirmation |
  | --- | --- | --- | --- |
  | `enabled` | boolean | `env-disabled` when `FLUPCODE_ADAPTIVE_DISABLED=1` | — |
  | `shadow` | boolean | — | — |
  | `context.enabled` | boolean | — | — |
  | `context.apply` | boolean | warning `evaluation-gated` ([ADR-0018](adr/0018-context-selection-seam.md)) | — |
  | `learning.enabled` | boolean | egress allowlist: a project **and** `egress.kinds.skillReflection` ([ADR-0020](adr/0020-learning-persistence-and-egress.md)); warning `learning-draft-egress` | **yes**: the draft goes to the small model's provider |
  | `relevance.enabled` | boolean | a resolved `adaptive-token` ([ADR-0021](adr/0021-skill-relevance-acting.md)) | — |
  | `guardrails.enabled` | boolean | a resolved `adaptive-token` ([ADR-0023](adr/0023-failure-loop-guardrails.md)); shown as "Loop warnings" | — |
  | `jev.enabled` | boolean | egress allowlist: a project and a kind | **yes** |
  | `egress.projects` | string[] | — | **yes** when it widens |
  | `egress.kinds` | boolean-map | validated against `isDecisionKind` | **yes** when it widens |
  | `retention.enabled` | boolean | — | **yes** ([ADR-0022](adr/0022-loopback-auth-retention-and-rollback.md)) |
  | `budget.monthlyTokens` | number > 0 | — | — |

  Read-only in E8: `runtime.*`, `episode.*`, `decisions.*`,
  `jev.{endpoint,model,timeoutMs,maxInputTokens}`, `budget.hotReserveFraction`,
  `context.{keepThreshold,dropThreshold,budget}`, `learning.{minToolCalls,snapshotKeep,maxInputChars,
  maxBodyChars,draftTimeoutMs,probationSample,staleAfter,archiveAfter,model}`, `relevance.{maxSkills,rosterTtlMs,
  timeoutMs}` and `retention.*Days`. `TYPESAFE_API_KEY` stays **environment-only**; the panel reports
  whether it is present and never edits it ([ADR-0017](adr/0017-jev-egress-and-governance.md)).
- **Provenance and precedence.** The panel shows each switch's effective value and where it comes
  from — `env > block > default`, the same precedence the resolver applies
  ([ADR-0017](adr/0017-jev-egress-and-governance.md)) — so a value forced by the environment looks
  forced, not editable. When `FLUPCODE_ADAPTIVE_DISABLED=1`, the master switch is drawn **off and
  disabled** with the reason, and a direct `enabled=true` is rejected with `env-disabled`; the API is
  honest even when someone skips the UI.
- **The kill switch, said honestly.** `adaptive.enabled=false` (and
  `FLUPCODE_ADAPTIVE_DISABLED=1`) stops decisions, shadow, Jev, relevance, learning, the loop
  warnings and the context plan, per the [ADR-0022](adr/0022-loopback-auth-retention-and-rollback.md) table. It **does not**
  unload learned skills: they are ordinary files on disk and the engine keeps loading them, because
  there is no seam in the engine to stop that. The panel says so and never promises a total stop.
  With the master off, each switch it stops (every boolean switch except retention, which
  sweeps regardless) keeps its own value but is marked "inactive: the master switch is off". The Jev row also
  says when `TYPESAFE_API_KEY` is missing, since decisions then fall back to the built-in rules. The
  same is true of a successful write to `enabled`: it travels the warning `skills-still-load`.
- **Write contract.** `PATCH /harness/adaptive/config` with `{ "patch": { … }, "confirm": false }`.
  The patch is **nested**, mirroring `flupcode.adaptive`, and carries only allowlisted leaves; a key
  whose segment carries a dot is refused with `unsupported-field`, because it would be written as one
  literal key the resolver never reads. `null` on a leaf deletes it (back to default); `confirm: true`
  is required by the confirmation rows above. It answers `200` with the resulting `GET` view plus
  `warnings`, or an error with a closed `code` (`unsupported-field`, `invalid-value`,
  `confirmation-required`, `env-disabled`, `guard:no-adaptive-token`,
  `guard:egress-allowlist-required`, `invalid-config`, `config-unreadable`) and, where useful,
  `fields`/`missing`. A body that is not JSON or lacks a `patch` object is a `400 bad_request`; an
  unreadable target file is a `500 config-unreadable`. A patch with no leaves is a read: it answers
  the view and neither creates nor rewrites the file. The writer only ever touches the
  `flupcode.adaptive` leaf and shares the config write queue with the rest of the harness, so comments
  and neighbouring keys are preserved.
- **Deleting is local to the writer's file.** A `null` leaf is removed from the file the writer chose
  (`OPENCODE_CONFIG_DIR`, or XDG), so a value present in **another** layer (XDG when the writer
  targets `OPENCODE_CONFIG_DIR`, or the reverse) survives and the effective value is not necessarily
  the default again. The panel says so and does not present deletion as an absolute guarantee of
  restoring the default.
- **Open decision, non-blocking.** The egress allowlist UI offers only the **four kinds the server
  ships** — `completion`, `skillRelevance`, `contextItem`, `skillReflection`. A kind the writer would
  accept but the product does not implement yet is not rendered, so the panel never promises an
  allowlist entry that would do nothing. Widening the set is additive when a kind lands.

## Decisions

_Landed in Phase 2. Documents the seven decision kinds, the audit and `explain`, and the shadow
mode that records decisions without acting on them
([ADR-0017](adr/0017-jev-egress-and-governance.md)). Phase 3b adds the `skillReflection` kind
(eight in total), whose deterministic baseline is inert — see [Learning](#learning)._

- **Confidence is the probability of the answer chosen.** The `DecisionService` calibrates it once,
  for every provider, from the provider's `probabilities`: for a distribution (`completion`,
  `failure`, the choice and score kinds) it is the top label's probability, so `p(complete) = 0.05`
  is a 0.95-confident `not_complete`; for the gate kinds (`skillRelevance`, `skillReflection`), each
  gate counts `max(p, 1 − p)` and the answer is as certain as its least certain gate, so every skill
  at `0.02` is a confident "load nothing" while one gate at `0.5` degrades the whole set. A provider
  may also report its own confidence in the chosen answer; the recorded confidence is the weaker of
  the two. It must clear `minConfidence`, and the chosen probability must clear `minProbability`;
  otherwise the baseline answers with `low-confidence`.
