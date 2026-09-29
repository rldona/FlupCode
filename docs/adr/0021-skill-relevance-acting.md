# ADR-0021: Skill relevance injection

- **Status:** Accepted
- **Date:** 2026-09-29
- **Related:** ADR-0016 (harness boundary), ADR-0017 (Jev egress and governance), ADR-0018 (context selection seam), ADR-0019 (learned skill lifecycle), ADR-0020 (learning persistence, cadence and egress), `flupcode-adaptive-harness-plan.md` §6 / §9 / §11 / §13 / §15 / §19, `fh-phase4-design.md`, `poc-1b-runtime-hooks.md`

## Context

Phase 4 is the first **acting** decision of the Adaptive Harness. Until now every decision was shadow
only: it was recorded and explained, never acted upon (ADR-0016 §4). The `skillRelevance` kind already
exists and is deterministic-first with a Jev layer and an episode shadow
(`adaptive/providers/deterministic.ts:56-62`, `adaptive/providers/jev.ts:186-199`,
`adaptive/shadow.ts:24`). Phase 4 adds a live turn: the harness suggests, at the start of a turn, which
skills might be relevant, and an installed engine plugin injects that suggestion as a non-coercive
`<skill_relevance>` line. The engine's own skill loading is untouched; the line only suggests.

The plan chose skill relevance as the first acting decision because it is the lowest-risk and
cookbook-validated one (`flupcode-adaptive-harness-plan.md` §11, §6.2): a wrong suggestion can be
ignored by the model, and the selection claim it acts on is already measured offline (ADR-0020 §9).

The substrate is reused, not duplicated: `DecisionService.predict` with a deterministic baseline, an
optional Jev layer, a gate and audit (`adaptive/decision-service.ts:77`); `EgressGuard` as the single
outward serialization; `curator.roster(projectID)` returning human and learned **loaded** skills
(`adaptive/skills/curator.ts:53`, `:85`); `SkillRelevanceAnswer = { load: string[] }`
(`adaptive/decision.ts:102`); `decisionID(kind, scopeID)` (`adaptive/decision-record.ts:15`); the
runtime probe and its capability set (`adaptive/runtime.ts:50-53`, `:159-162`); the composed adaptive
config with a kill switch (`adaptive/config.ts:74`); the bearer route pattern of
`/harness/browser/*` and `/harness/actions/*` (`api.ts:418-421`); and the raw-string plugin pattern
`WEB_ACTIONS_PLUGIN` with `harnessBaseURL()` and `readToken()`
(`packages/remote/src/engine-plugins.ts:798`, `:926`, `:938`).

Two engine facts decide the seam, verified by trace and schema in PoC-1b (not by running the real
engine with the plugin):

- **Order and payload.** In the main turn, `experimental.chat.messages.transform`
  (`packages/opencode/src/session/prompt.ts:1255`) fires **before**
  `experimental.chat.system.transform` (`packages/opencode/src/session/llm/request.ts:70`), in the same
  turn fiber. The `input` of `messages.transform` is `{}`; the objective and its ids are read from
  `output.messages[i].info` (`id`, `sessionID`, `role`) and the non-synthetic text parts.
  `system.transform` carries `sessionID` and `model`, but **no `agent` and no `small`**, so it cannot
  discriminate a normal turn from a title, a compaction or `Agent.generate`
  (`packages/opencode/src/session/agent.ts:402`, no `sessionID`) — it fires on **every** LLM request.
- **The hook blocks the turn.** `Plugin.trigger` awaits each hook
  (`packages/opencode/src/plugin/index.ts:291-296`), so a plugin `fetch` makes the turn wait; there is
  no fire-and-forget if the line must be in the prompt. Bounding is `AbortSignal.timeout`: an absent
  server rejects almost immediately (`ConnectionRefused`, ~1 ms) and a mute server times out. A hook
  that throws fails `trigger` and the turn.

`PoC-1b` did not run the real engine with the plugin injected; the order and payload are verified by
trace and by the schema, and the live behaviour is validated by PoC-3 before promotion.

This ADR is step 0 of Phase 4 and blocks all Phase 4 code (`fh-phase4-design.md` §0, §"Plan de
implementación"). It is accepted from the start, as ADR-0016–ADR-0020 were.

## Decision

### 1. The acting seam is a thin-proxy plugin over a loopback harness endpoint

Two hooks in one plugin (`RELEVANCE_PLUGIN` in `packages/remote/src/engine-plugins.ts`), the same
installed plugin that already carries `RUNTIME_PROBE_PLUGIN`, `WEB_ACTIONS_PLUGIN` and
`EPISODE_EVENTS_PLUGIN` (`engine-plugins.ts:1468-1473`):

1. **Capture** (`experimental.chat.messages.transform`): read the last `role === "user"` entry of
   `output.messages`, take its `sessionID`, `id` and non-synthetic text, and store
   `Map<sessionID, {messageID, objective, at}>` in module memory. No I/O.
2. **Injection** (`experimental.chat.system.transform`): with `input.sessionID`, read the capture; if
   there is none or it is stale, do nothing; otherwise `POST /harness/adaptive/relevance` and, only if
   the response carries a non-empty line, `system.push(line)`.

**The server is the only policy.** The plugin holds no product state, decides nothing and computes
nothing: it captures, calls, and injects a string. Any `!response.ok`, malformed JSON, empty `line` or
exception is inert, and the whole hook is wrapped so it **never throws** — a throw would fail the turn
(`plugin/index.ts:291-296`). The plugin is registered only when it resolves base and token, the
fail-closed posture of `WEB_ACTIONS_PLUGIN` (`engine-plugins.ts:938`, `:1487`).

The endpoint is `POST /harness/adaptive/relevance`, under the same bearer as `/harness/browser/*` and
`/harness/actions/*` (`api.ts:418-421`); a Node/Bun `fetch` sends no `Origin`, so the CSRF check at
`api.ts:414` does not apply. The body carries
`{projectID, sessionID, messageID, objective}`; the response carries
`{line, decisionID, source, degraded, reason, latencyMs}` — the skill-name list is **not** on the wire,
since the plugin reads only `line` and the list would be an enumeration surface. `reason` distinguishes
`disabled` / `runtime-not-legacy` / `no-roster` / `no-match` / `ok`.

**The plugin is the last line of trust.** A process that holds the loopback port is not authenticated
(see consequences), so the plugin does not push whatever it answers: it injects only a `line` that is
**exactly** the fixed names-only box (`SKILL_LINE_PREFIX` + 1–3 `NAME` tokens joined by `, ` +
`SKILL_LINE_SUFFIX`). Any other body — free text, a foreign tag, a name that is not `NAME`, more than
three names — is inert and `system` stays byte-identical.

**The plugin registers whenever base+token resolve, even with the feature off**: the server is the
single point of policy, so the kill switch is instantaneous in both directions and no restart is
needed to enable the feature. The accepted cost is one loopback `POST` per turn returning `line: null`.
The client bounds its `fetch` with a constant (500 ms by default) strictly greater than the server's
`timeoutMs`, and the server **clamps** `adaptive.relevance.timeoutMs` to
`RELEVANCE_TIMEOUT_MS_CEILING` (450 ms) so raising the server value cannot make the server answer after
the plugin has already aborted. The timeout is a defence against a hung server, not product policy.

### 2. The objective is captured in `messages.transform`, and the capture is not consumed

`system.transform` does not expose the objective; capturing it with `client.session.messages()` would
add an engine round-trip inside the hot hook, and `messages.transform` already hands over the exact
turn messages with no I/O. A title runs on another fiber and its `system.transform` may interleave
before or after the turn's `messages.transform`, so **reading the capture does not delete it**
(PoC-1b §3): otherwise a title that read it first would leave the real turn with no line. The capture is
per-session with a TTL and is overwritten by the next turn. The accepted consequence is that a
title/compaction within the TTL may receive the line; it is harmless because the line is names-only,
non-coercive, and the server dedupes by decision id.

### 3. The line is a fixed, names-only, non-coercive `<skill_relevance>` block

The rendered line is a **fixed template**, frozen by a golden test, whose only variable content is
skill **names** joined by `, `:

```
<skill_relevance>Possibly relevant skills: alpha, beta, gamma. Consider loading one only if it clearly applies; otherwise ignore.</skill_relevance>
```

`rankSkills` is a pure function that **only orders and truncates** the candidate set `answer.load`
against the roster; it never re-matches the objective against the whole roster, so the deterministic
lexical baseline (`lexicallyRelevant`, `deterministic.ts:56-62`) and the Phase 2/3a/3b fixtures stay
byte-intact. `renderSkillLine` returns `undefined` for an empty list, so an empty selection is inert.

**Inertness guarantee: `system` is byte-identical** whenever the feature is off, the master kill switch
is on, the runtime is not `legacy`, there is no fresh objective, no roster, no candidates, a null or
empty line, an absent server, a timeout, a non-200, invalid JSON or an exception. In all of those cases
no `system.push` happens, the array is neither reordered nor reassigned, and the turn is exactly as it
is today.

### 4. Roster and rank reuse the curator; only valid names are ever emitted

`RelevanceService` reuses `curator.roster(projectID)` (`curator.ts:85`), which already returns human
plus learned **loaded** skills (a reverse-collision/shadowed file is marked without `loaded` by
`skillReport`, `packages/harness-server/src/skills.ts:148-154`). On top of it:

- a **server-side roster cache with TTL** per `projectID`, so a turn does not `readdir`/`readFile` on
  the hot path; the cache is also **size-bounded** (LRU eviction), so iterating project ids cannot grow
  it without bound;
- a **defensive dedupe by name** (first-wins): if a learned skill shares a name with a non-learned
  loaded skill — a reverse collision the ADR-0019 writer prevents but a hand-made file could cause —
  the learned one is dropped from the relevance roster;
- the roster is the **only** whitelist: `rankSkills`/`renderSkillLine` never emit a name outside it, and
  every emitted name is validated against the roster and against `NAME` (`skills.ts:62`).

The answer type is **kept as `SkillRelevanceAnswer = { load: string[] }`** (`decision.ts:102`). Order
and top-N are derivable from `(answer.load, roster, probabilities)` by a pure function, so the Jev
interpreter (`jev.ts:186-199`) and the existing eval fixtures are untouched. `answer.load` remains the
canonical selection that feeds `curator.recordSelection` and the `load` counter.

### 5. One audited decision per turn, `shadow: false` when acting

- `scopeID = `${sessionID}:${messageID}``, so `DecisionService` writes
  `decisionID("skillRelevance", scopeID)` (`decision-record.ts:15`): one row per user turn; a title or
  a compaction that fires `system.transform` with the same capture converges to the same id.
- `sessionID` and `projectID` travel in the row (supported by `DecisionRequest`,
  `decision.ts:245-246`).
- `predict` gains a **`shadow` flag with default `true`**:
  `predict(request, mode?, shadow = true)`. Today the service hardcodes `shadow: true` at
  `decision-service.ts:284`; acting calls `predict(request, "hot", false)`, writing one acting row per
  turn. The default preserves the episode shadow byte-for-byte and keeps the current fixtures green.
- `RelevanceService` keeps a **turn-long decision cache** by `decisionID` (`DECISION_TTL_MS`, 10 min,
  and a size cap): the hook fires per step of the loop, and a turn with slow steps must still reuse the
  same row instead of spending Jev again and rewriting the audit. The cap, not the clock, is what
  bounds an engine that never restarts.

### 6. Config and kill switch: opt-in, off by default

`adaptive.relevance` is a new slice with conservative defaults, resolved like the others (a malformed
value falls back to the default, never guessed):

```
adaptive.relevance { enabled: false, maxSkills: 3, rosterTtlMs: 5000, timeoutMs: 400 }
```

`maxSkills` is capped at 3 (`RELEVANCE_MAX_SKILLS_CEILING`) and `timeoutMs` at 450
(`RELEVANCE_TIMEOUT_MS_CEILING`): the first keeps the writer in step with the plugin's three-name box,
the second keeps the server's deadline below the plugin's fetch timeout.

| Condition | Effect |
| --- | --- |
| `FLUPCODE_ADAPTIVE_DISABLED=1` or `flupcode.adaptive.enabled=false` | inert (`disabled`); the episode shadow also stops |
| `adaptive.relevance.enabled=false` (default) | inert; a loopback `POST` per turn returns `line: null` |
| `adaptive.relevance.enabled=true` + Jev off | the **deterministic lexical line is injected** (Phase 4 decision) |
| `adaptive.relevance.enabled=true` + Jev on + project/kind allowlisted | Jev-ranked line, lexical on degradation |
| project absent from `egress.projects` or `egress.kinds.skillRelevance=false` | Jev is not attempted; lexical line |
| runtime ≠ `legacy` | inert (`runtime-not-legacy`) |
| `adaptive.shadow=false` | does not affect relevance |

Two clarifications fix the composition. **With the feature on and Jev off, the lexical line is still
injected** (Phase 4 decisions, plan §11): the lexical path is the fallback the plan asks for, and
turning relevance off — not Jev — is what restores the previous behaviour. And the engine→harness
loopback is **local, not egress**: because the call stays on the loopback interface it is not a
crossing of the ADR-0017 egress boundary, which governs state leaving the machine (Jev, the draft
model). The relevance endpoint therefore does not add a new egress condition.

### 7. Measurement is an offline gate, not a live claim

The merge gate is an **offline evaluation**, reproducible with no network and no real model:
`relevance-eval.test.ts` over `fixtures/relevance/*.json`, comparing the deterministic line against a
**recorded Jev answer** replayed through the real `DecisionService` + `JevClient` + `EgressGuard`. It
asserts:

1. **recall** — the `good` skills appear in the line;
2. **wrong-load** — zero `wrong` names appear (the acceptance metric of the gate);
3. **determinism** — same input ⇒ byte-identical line (stable tie-break by name);
4. **inertness** — off / no objective / no roster / no candidates / server error / timeout ⇒
   `line === null` and `system` unchanged;
5. **one request** — one `predict` call; with Jev off, **zero** Jev calls; with Jev on, **one** Jev
   request (batched `noul` gates) and the repeated `decisionID` reuses the cache;
6. **trust** — only roster names; an answer that injects unknown names or instructions produces no
   hostile line.

**Live improvement is validated by PoC-3 before promotion**, not built behind the flag (Phase 4
decisions). The learning session-start report (§8.2 rule 8) is out of Phase 4.

## Consequences

Positive:

- The first acting decision reuses the whole Phase 2–3b substrate — decision service, audit, egress
  guard, curator roster, runtime probe — and adds supervision, not a second decision path.
- With the feature off, the off-by-default posture and the byte-identity guarantee mean an idle turn is
  exactly today's turn; the accepted cost is one local `POST`.
- The line is non-coercive and names-only, so a false positive cannot remove a skill or widen a
  permission; the model may always ignore it.
- Acting is audited one row per turn with `shadow: false`, so "what the harness suggested live" is
  explainable and reversible by turning the flag off.

Negative / accepted costs:

- **The hook blocks the turn**, bounded only by `AbortSignal.timeout`; the budget is real and the
  server's deadline must fire before the plugin's. This is an accepted architectural limit, not
  removable with the current hook surface.
- **`system.transform` fires on every request and cannot discriminate the type.** A title, a compaction
  or a memory-extract within the capture TTL may receive the line; it is harmless by construction, and
  a request without a capture (`Agent.generate`, no `sessionID`) is inert.
- The `unknown` runtime on the first turn after the engine starts classifies fail-closed and stays
  inert; the following turns act. Accepted and validated by PoC-3.
- Jev on the hot path adds latency and cost; bounded by the 400 ms deadline, the lexical fallback and
  the per-`decisionID` cache.
- The plugin is registered even when the feature is off, so every turn pays a loopback round trip.
- **The loopback peer is not authenticated.** The plugin sends the browser/vault bearer to
  `127.0.0.1`; a process that holds — or races for — the harness port could answer the relevance
  `POST` and capture that bearer. The plugin's strict names-only validation removes the *injection*
  risk, but not the token exposure. A **dedicated token or a local socket is required before the
  relevance is activated**; it is not built here (see out of scope).
- **Retention of `adaptive_decision` is still pending.** The in-process caches are bounded here, but
  the audit table itself has no purge; that is the plan §19 follow-up, out of scope.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| Capture with `client.session.messages()` inside the hook | Adds an engine round-trip on the hot path and more surface (SDK/auth); `messages.transform` already delivers the turn messages without I/O. |
| Inject in `messages.transform` (add a message) | Changes the conversation and injects as a turn, not as system; "system byte-identical" would be harder to prove. |
| Use `chat.message` to capture | Gives explicit ids but does not cover compaction and does not correlate with the following `system.transform`. |
| Let the plugin decide without the server | Duplicates roster, decision, Jev and audit in untyped JS; breaks "one policy authority" and ADR-0016. |
| Gate the runtime in the plugin | The plugin does not know the probe; the server is the only policy point. |
| Include descriptions or imperative language in the line | Leaves names-only and raises injection risk; the model already sees `<available_skills>`, and a false positive must not coerce. |
| Cap `answer.load` to top-3 in the baseline | Would break the Phase 2/3a/3b fixtures and conflate selection with projection; the truncation belongs at the line, not the decision. |
| Enrich the answer with `{load, ranked, scores}` | Touches the Jev interpreter, `decisionFromRow` and fixtures with no benefit: the ranking is recomputable. |
| `scopeID = sessionID` | One row per session would collapse every turn's decision; `sessionID:messageID` is the "one acting decision per turn" granularity. |
| Derive `shadow` from `mode` | Mixes two axes (hot/batch latency vs acting); an explicit flag keeps the episode shadow unchanged. |
| `enabled: true` by default | Acting without a metric; the plan requires a flag and an evaluation gate. |
| Gate the plugin by config at load | Couples the plugin to the config and needs a restart; the server already decides. |
| Give the plugin a timeout equal to the server's | Overhead would abort before the server answers and the line would vanish at random. |

## Out of scope

- The learning session-start report (§8.2 rule 8); it is a learning follow-up.
- Acting context selection on live sessions (Phase 9) and model/agent routing, guardrails and
  failure/loop intervention.
- Any engine core change; the seam is the legacy hook surface, and a migration to the V2 runtime makes
  it inert by design.
- Changes to Protocol/HttpApi, the SDK, `packages/harness`, `packs.ts`, `runner.ts` or `scheduler.ts`.
- A dedicated relevance UI (decision inspector); Phase 4 is backend plus plugin.
- Authentication of the loopback relevance peer (a dedicated token or a local socket); until it lands,
  the plugin's names-only validation is the only defence and the feature stays off by default.
- Retention and purge of adaptive data (plan §19).

## Implementation plan

Phase 4 is the "Skill relevance (first acting decision)" phase of
`flupcode-adaptive-harness-plan.md` §11, with the file map, step order and verification commands in
`fh-phase4-design.md` §"Plan de implementación". This ADR is step 0 and blocks the code:
`adaptive/skill-line.ts` (pure rank/render), the `shadow` flag in `predict`, the `RelevanceConfig`
slice, `adaptive/relevance.ts`, `adaptive/relevance-routes.ts` plus the route and capability, the
wiring in `packages/harness-server/src/index.ts`, `RELEVANCE_PLUGIN` in `packages/remote`, and the
`relevance-eval.test.ts` deliverable. Acceptance: with the feature off the `system` is byte-identical
and there is no useful `POST`; with it on and Jev off the lexical line is injected; with Jev on the
ranked line is injected and one `shadow: false` row is audited per turn; the offline eval reports
wrong-load and recall against the recorded Jev answer; and PoC-3 validates the live behaviour before
promotion.
