# ADR-0024: Per-step selection only where the prompt cache is already cold

- **Status:** Accepted (PoC, off by default). Amended 2026-09-30: §7 resolves the A11 follow-up
  (the relevance line is pinned per user turn and rides on the turn's user message).
- **Date:** 2026-09-30
- **Related:** ADR-0016 (harness boundary), ADR-0018 (context selection over summarization),
  ADR-0021 (skill relevance acting), ADR-0022 (loopback auth), `docs/V2-HOOKS.md` (AH-D05),
  `docs/ADAPTIVE.md` ("Tool output trim", "Compaction anchors", "Per-step selection"), engineering
  audit 2026-09-30 §10.4, §12 (AH-D03) and §14

## Context

AH-D03 asks for a PoC of per-step selection in `experimental.chat.messages.transform`. The PoC may
trim only old tool-call/result pairs, and only whole pairs. It must be deterministic and make no
network call inside the hook. The stable prefix up to the prompt-cache breakpoint is untouchable. The
acceptance is a **negative Δ in USD**, not in tokens, in the replay, with 0 requests rejected.

The USD criterion exists because of prompt caching. Removing tokens from a request can make it cost
more. So this ADR starts with how the engine builds a request and where the cache breakpoints fall.

### Where the hook runs

The legacy runner (`packages/opencode/src/session/prompt.ts`) runs these steps on every step of a turn:

1. It reloads the session's messages from storage (`msgs`, the engine's `{ info, parts }` list).
2. It fires `experimental.chat.messages.transform` with `{ messages: msgs }` (`prompt.ts:1255`). A
   plugin acts by mutating that array in place. The mutation is **not persisted**: the next step
   reloads the history from storage and fires the hook again.
3. It converts the list with `MessageV2.toModelMessagesEffect` (`session/message-v2.ts`). A `tool`
   part becomes one `tool_use` block plus its `tool_result` block. A completed part whose
   `state.time.compacted` is set is sent as `[Old tool result content cleared]` without attachments.
4. `LLMRequestPrep.prepare` (`session/llm/request.ts:56`) builds the system messages, fires
   `experimental.chat.system.transform`, and folds the result into at most two system messages:
   `[header, rest]`.
5. `ProviderTransform.message` (`provider/transform.ts:465`) calls `applyCaching`
   (`transform.ts:358`) for Anthropic-family models. That function marks the **first two system
   messages and the last two non-system messages** with an ephemeral cache breakpoint.
   - Anthropic's default TTL is 5 minutes. The engine sets no `ttl`.
   - For `anthropic` and Bedrock the mark is message-level; for others it goes on the last content
     part.

Compaction fires the same hook on a clone of the head it summarises (`session/compaction.ts:379`).
That call serialises the messages into a text prompt, so caching does not apply to it.

### How the breakpoints move

- Every request moves the two conversation breakpoints to its own last two messages. The provider
  writes a cache entry at each breakpoint.
- On the next request, the provider looks back a bounded number of content blocks (about 20 for
  Anthropic) from each new breakpoint. It reads the longest prefix it already holds. In an agent loop,
  that prefix is the previous request's end.
- So at step *k*, the whole conversation up to the end of step *k − 1* is read at the cache-read
  price. Only what step *k − 1* added (its assistant output and tool results) is new, and it is
  written at the cache-write price.
- Entries at older positions are not read again, so they expire when their TTL runs out. The only
  entries that last are:
  - the system breakpoints, which are shared by every request of the same agent, model and project;
  - the previous request's own breakpoints.

### Why a change before the breakpoint raises the cost

The cache is a prefix. If one byte changes at position *p*, nothing after *p* can be read from the
cache. Every token after *p* is sent again and **written** at the cache-write price.

Let *p* be the base input price. For Anthropic, a cache write is *w* = 1.25*p* for the 5-minute
cache and 2*p* for the 1-hour cache. A cache read is *r* = 0.1*p*.

Take a request that trims *T* tokens from a pair older than the lookback window. Let *C* be the
conversation's cached tokens, *T* included. The request then falls back to the system breakpoint.

- **Cost of the trim step:** it writes *C − T* where it would have read *C*:
  Δ = *w*(*C − T*) − *rC* = (*w − r*)(*C − T*) − *rT*.
- **Savings afterwards:** each of the *R* later warm steps saves *rT*.
- **Net:** Δ = (*w − r*)(*C − T*) − *rT*(*R* + 1).

It pays back only when **R + 1 > (w − r)/r · (C − T)/T**. That is **11.5 · (C − T)/T** for the
5-minute cache and 19 · (C − T)/T for the 1-hour cache.

- **Worked example:** trim 10k tokens from a 60k-token conversation. The trim pays back only after
  about 58 more steps in the same warm cache, with no other change. Old pairs are, by definition,
  followed by most of the conversation.
- **Per step:** at every warm step, trimming makes the next request cost roughly 11 times the tokens
  it removes.
- **Near the end:** a pair close to the end has a small *C − T*, but those are the recent turns this
  PoC keeps. The latest outputs are the only content "after the cached prefix that would be re-sent
  uncached". That window belongs to D02: its trim acts in `tool.execute.after`, before the output is
  ever sent, so it never busts anything.
- **OpenAI:** caching is automatic and has no write premium, but a cached token costs *c* of the
  input price (0.1 to 0.5, depending on the model). The same argument gives
  R + 1 > (1 − c)/c · (C − T)/T. That is 9 · (C − T)/T at *c* = 0.1.

### Where trimming is free

When the cache has already expired, the next request writes the whole conversation again no matter
what. Trimming *T* tokens then saves:

- *wT* on that request;
- *rT* on every later warm step;
- *wT* again at every later cold start.

That is a strict saving in provider tokens, provided later steps never undo the trim (see §2).

The hook does not know the current time of the request. The list does carry timestamps, though. A
user message created more than the cache TTL after the previous assistant message **completed** is
sent at least that long after the last request that touched the cache. So nothing it trims was
cached.

**Using `completed` is conservative:**

- The cache was last refreshed no later than that request's end.
- The measured gap can only undercount.
- A step that ran a 10-minute tool without a user message in between is a real cold start that this
  rule misses. The list does not carry the time of the current request, and a rule based on the
  clock would not be reproducible at the next step.

## Decision

### 1. Trim only at a cold boundary, never at a warm step

- **Definition.** A **cold boundary** is a user message such that:
  - the message right before it is an assistant message with a completion time;
  - the gap from that completion to the user message's creation is more than `coldGapMs`.
- **When the trimmed set changes.** Only at the step whose list ends with a cold boundary, which is
  the first step of that turn. At every other step, the output is byte-identical to the previous
  step's output on the shared prefix.
- **Queued messages.** A user message queued behind another user message is never a boundary, and
  neither is one that follows an unfinished step. So a race between a queued prompt and a running step
  cannot move the set.
- **The default gap is 65 minutes.** That is past Anthropic's 1-hour TTL and past OpenAI's longest
  in-memory retention, so the rule stays safe under any TTL the engine may configure. With the
  engine's own 5-minute Anthropic breakpoints, 6 minutes is enough; the replay measures that value.

### 2. The trimmed set depends only on history, so each step reproduces it

`selectForCache(messages, policy)` computes the trimmed set as the union, over every cold boundary
*b* in the list, of the candidates of the history before *b*.

- **What `b` can trim.** Every completed tool output in assistant messages before the last
  `keepRecentTurns` turns preceding *b*, subject to these conditions:
  - the tool is not exempt (`skill`, `task`, `todowrite`, `todoread`);
  - the output is not already compacted by the engine's prune;
  - the output has at least 1,024 characters.
- **Floor.** If the new candidates at *b* would save fewer than `minSavingsTokens` (4 characters a
  token, the engine's own estimate), *b* trims nothing.
- **Placeholder.** The replacement depends only on the part: the tool name, the output length and, when
  D02 stored the output, `evidence_read` with its ref (from `metadata.evidenceRef`, or the
  `evidence:<ref>` in a digest). So every later step renders the same bytes.
- **Why later steps match.** Boundaries are a property of the history. A longer list adds boundaries
  only at its new messages. So the selection of a longer list, with no boundary in between, renders
  the shorter list's prefix byte for byte. A property test checks this over generated sessions
  (`packages/remote/src/cache-selection.test.ts`).

### 3. Pairs cannot break

- **What changes.** Only `state.output` of a `completed` tool part is replaced. Attachments are
  cleared with it, as the engine's own prune does.
- **What stays.** The part keeps its call id, tool, input and status, and no message or part is added
  or removed. So every `tool_use` still has its `tool_result`, and the order is unchanged.
- **What is never touched:**
  - the system prompt, which is not in the list;
  - user messages, including the first one;
  - text and reasoning parts, including signed thinking;
  - errored and interrupted calls;
  - everything from the last boundary on.

Pair breakage is impossible by construction, and exhaustive property tests assert it.

### 4. No network in the hook; the policy is latched per session

- **The plugin.** `CACHE_SELECTION_PLUGIN` (`flupcode-cache-selection.js`) fetches
  `GET /harness/adaptive/selection` with the adaptive bearer. It does so when the plugin loads and then
  every 30 s on an unreferenced timer. The hook reads only that cached policy. A policy older than
  5 minutes, a malformed one, or no answer at all means off.
- **Latching.** The policy a session runs under is **latched** and replaced only at a cold step. So a
  switch flipped while a session's cache is warm (or the runtime probe moving from `unknown` to
  `legacy`) takes effect at that session's next cold boundary. Nothing is rewritten mid-cache.
- **After a restart.** A session first seen mid-way, for example after an engine restart, takes the
  current policy. If that policy differs from the one before the restart, this costs at most one
  rewrite.
- **Composition.** The pure function is inlined into the plugin from `CACHE_SELECTION_SOURCE`, so the
  tests evaluate the exact text the engine runs.
- **Gate.** The server's answer folds in the kill switch and the probe gate (`canTransformMessages`,
  see `docs/V2-HOOKS.md`). On the V2 runner the hook never fires, and the full history goes out.

### 5. Off by default, not a UI switch, measured by replay

- **Config.** `adaptive.selection`:
  - `enabled: false`;
  - `keepRecentTurns: 2`;
  - `minSavingsTokens: 4096`;
  - `coldGapMs: 3_900_000`.
- **Writable only for the replay.** `selection.enabled` (guarded by the adaptive token, warning
  `evaluation-gated`) and `selection.coldGapMs` are writable through the settings surface only so a
  replay variant can set them. The settings panel draws no control for either.
- **Acceptance (§14.3).** Promotion needs:
  - Δ USD per task < 0, cache effect included;
  - completion ≥ −1 pp;
  - 0 rejected requests (`turnErrors`).

### 6. Composition with the other `messages.transform` plugins

- **Readers.** D04 (`COMPACTION_ANCHORS_PLUGIN`) reads only user text parts in this hook. A11
  (`RELEVANCE_PLUGIN`) reads the non-synthetic user text and, since §7, appends one synthetic text part
  to the user messages whose turn got a line. Selection writes only completed tool outputs in assistant
  messages and returns every user message as the same object, so neither write touches the other.
- **Order.** The engine loads plugin files in glob order, so `flupcode-cache-selection.js` runs first.
  The result does not depend on the order: the readers see identical input either way.
- **The relevance line.** Until §7 it went through `system.transform` and could bust the cache at
  any step; §7 moves it into this hook, after every other writer, and makes it byte-stable. Selection
  never changes bytes at a warm step, so with both on the cache is busted no more often than with
  either alone.

### 7. The relevance line is pinned per user turn and rides on that turn's user message

This resolves the A11 follow-up left open here.

#### What changed the injected text before

The line was pushed into `system` by `experimental.chat.system.transform`. The system array holds
one string, so the push made the line a **second system message**. `applyCaching` marks that message
too, and it sits before the whole conversation. Any request whose line differed from the previous
request's — present, absent or different — made the provider write every conversation token again.

The plugin asked the harness on **every provider request** (every step, plus the title and compaction
requests of the same session). Between two consecutive steps of one turn, the text could differ when:

1. **The fetch failed on one step and not the other.** A timeout (500 ms plugin deadline), a refused
   connection, a non-200 or malformed JSON drops the line on that step only. A slow harness event
   loop is enough: the server's hot deadline is under the plugin's, but its answer can still land late.
2. **The breaker opened.** Three consecutive failures, from **any** session (the breaker is
   module-wide), silence every session for 60 s. The half-open probe admits one request, so a
   concurrent step of another session gets no line.
3. **A retry hint was set.** An inert answer carrying `retryAfterMs` (feature off, master switch,
   runtime not `legacy`) silences every session for up to 10 min. The line then comes back mid-turn
   when the hint expires and the feature is on.
4. **The plugin's capture expired or was evicted.** The capture lives 5 min from the last
   `messages.transform`, so a step after a long tool run (or a title/compaction request after a gap)
   saw no objective. Past 500 sessions the oldest capture is evicted.
5. **The harness decision cache missed.** Its TTL is 10 min (`DECISION_TTL_MS`) and it holds 500
   entries across all sessions. A long turn, or a busy engine, decided again; a new decision can rank
   differently (Jev answer, degraded fallback, a roster changed by an installed or retired skill).
6. **An error was not cached.** A throw in `suggest` returns `reason: "error"` without caching it, so
   the next step decided again and could return a line.
7. **The session override changed (AH-E02).** A pause returned no line from the very next step and a
   resume decided afresh; a changed exclusion list decided again.
8. **The config or the probe changed.** Relevance or the master switch toggled, `maxSkills` or
   `holdout.fraction` changed (the arm moves between control and treatment), or the runtime probe
   moved between `unknown` and `legacy`.
9. **A process restarted.** A harness restart dropped every cached decision; an engine restart dropped
   the plugin's captures and breaker.

Between two turns, the text differs whenever the new objective ranks differently, which is the
normal case, plus all of the above. The title and compaction requests fetched too, but their prefixes
differ from the turn's anyway (their own agent prompt), so they only cost a harness call each.

#### Options and their cost

Let *C* be the conversation already cached at a turn boundary (everything after the system prompt),
*t* the tokens a turn adds (its user message, outputs and tool results), and *w* and *r* the write and
read prices above.

| Option | Within a turn | At a new turn |
| --- | --- | --- |
| **A.** Keep the line in `system`, pinned per turn | 0 | (*w − r*)·*C* whenever the line differs from the previous turn's, on→off and off→on included |
| **B1.** Append it to the latest user message only | 0 | (*w − r*)·*t*<sub>prev</sub> whenever the previous turn had a line: the line leaves that message |
| **B2.** Append each turn's line to its own user message, and keep it there | 0 | 0 |

- **A grows with the session.** A different ranking per turn is the normal case, so *f*, the share of
  turns whose line changes, is high. Turn *k* then costs about *f*(*w − r*)·*k*·*t*, which is quadratic
  over the session.
- **Worked example.** A 60k-token conversation with 8k-token turns (5-minute cache):
  - A costs about 1.15 × 60k ≈ 69k input-token equivalents at every turn whose line changes;
  - B1 costs about 1.15 × 8k ≈ 9k at every turn after one with a line;
  - B2 costs nothing beyond writing the ~50-token line once, as part of the new message.
- **Minimising changes in A would defeat the feature.** A line that does not follow the objective is
  the wrong hint, so A cannot avoid the change cost without dropping the feature.
- **B1 is the engine's own pattern.** The plan-mode reminder (`session/reminders.ts`) is pushed on the
  latest user message only, and it pays exactly that cost.

#### Decision

B2, with the decision pinned per turn:

- **One decision per turn.** The plugin asks the harness once, at the first step of a user turn: the
  step whose request ends with that user message. It records the turn as decided **before** it asks,
  so the outcome is pinned whatever it is: a line, or no line on a timeout, an open breaker, a retry
  hint, a holdout control arm, a paused session or no match. No later step of the turn asks again.
- **Byte-identical rendering.** On every request the plugin appends, to each user message with a
  pinned line, one synthetic text part built only from the message's ids and the pinned string. It
  goes after the parts the engine put there, and `messages.transform` mutations are not persisted, so
  every step renders the same bytes and an earlier turn's line never moves.
- **A failure never removes a line.** A timeout or an open breaker at the start of a turn only means
  that turn carries no line. The previous turns keep theirs, so the model still has the last valid
  hint in context, and nothing already cached is rewritten.
- **No system prompt.** The plugin no longer registers `system.transform`. The system prompt is
  byte-identical in every case, and title and compaction requests no longer call the harness.
- **Only a turn it saw start.** A turn is decided only while its user message is the newest message of
  the request and was created less than 5 min ago. A session first seen mid-turn (after an engine
  restart) or a compaction's copy of an old head therefore never pins a line onto a message the
  provider already cached without one.

#### Bounded state

- Per session: the id of the last decided user message and the lines pinned to message ids.
- A session idle for 65 min is forgotten. That is past the longest prompt-cache TTL, so its next
  request is a cache write anyway, and dropping its lines costs nothing.
- **At most 500 sessions, 200 lines per session and 5,000 lines overall** (1.5 MB at the 300-character
  line cap).
  - Past a bound, the least recently active session goes, or a session's oldest line.
  - That costs the session at most one rewrite from that message on, and usually none: by then the old
    turns have been compacted away.
- An engine restart forgets every pin. It costs a still-warm session one rewrite from its first line,
  the same bound §4 accepts for the selection latch.

#### Behaviour changes

- **The line is user-channel text.** It is a synthetic part of the turn's user message, not a system
  message. The engine's own reminders use the same channel, and the box stays names-only and
  non-coercive.
- **Earlier lines stay in the history.** The model sees each earlier turn's hint where it was given.
  That is at most about 50 tokens per turn, and it is what the model was actually told.
- **A pause or an exclusion (AH-E02) now lands on the next user turn, not the next step.**
  - The model has already read the current turn's line at its first step, so dropping it later would
    not un-suggest anything.
  - Dropping it would still be a deliberate cache write of the turn so far.
  - Lines of earlier turns are history and stay.
  - The harness still reads the override on every call, and a paused turn is still recorded as
    `session-paused`.
- **The Context screen no longer shows the line in the system prompt.** It never was part of the
  prompt the engine assembles.
- **A compaction's summary input may include pinned lines.** The copy of the head it serialises can
  carry them. They are part of what the model was told, and the summary replaces them.

Tests (`packages/remote/src/engine-plugins.test.ts`, `RELEVANCE_PLUGIN`) cover these cases:

- every step of a turn renders the same bytes across failure, breaker, holdout, pause, a changed
  answer and a clock past the decision TTL, with no second request;
- a "no line" pin holds when the harness recovers mid-turn;
- a new turn can change the line while every earlier request is a byte prefix of the next;
- a turn the plugin did not see start is never decided;
- the three bounds hold.

## Consequences

Positive:

- The trim can only save provider tokens: it acts where the whole conversation is written anyway, and
  every later step reproduces it. The analysis is falsifiable by replay.
- It is deterministic, local and fail-open. It never breaks a tool pair, and it never touches the
  system prompt, a user message or the recent turns.
- The same measure-first path as D02 and D04 applies: off, then replay, then promote or kill.

Negative / accepted costs:

- **Rare.** It acts only when someone comes back after the gap. With the 65-minute default that means
  after a long break. With 6 minutes (Anthropic's default TTL) it is more often, but still once per
  return. Sessions driven without pauses are never trimmed.
- **Modest.**
  - The saving is about *wT* once per cold start, plus *rT* per later step.
  - Example: a 150k-token conversation with 100k of old tool output. The first request after the
    break writes about 50k instead of about 150k, which saves roughly 125k input-token equivalents at
    that step and about 10k per step after it.
- **Information loss.** The agent may re-run a tool it needed. The recent turns, the exempt tools and
  D02's `evidence_read` pointer limit this. Completion in the replay is the guardrail.
- **Missed cold starts.** Cold starts inside a turn (a long tool run) are missed by design, because
  the list does not carry the current request's time.
- **One possible rewrite.** A policy change followed by an engine restart can cost one rewrite in a
  session that is still warm.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| Trim old pairs at any step once the context is large | Each such step rewrites the whole conversation at 1.25× (§Context). It pays back only after 11.5·(C − T)/T warm steps, which almost never happens. |
| Trim at a warm step when the payback math says so | The hook cannot know the remaining steps R. A wrong guess rewrites the cache, and every later adjustment rewrites it again. |
| Drop whole tool parts (call and result) | This can leave an assistant message empty or with signed reasoning next to nothing, which the provider may reject. Replacing the output keeps every pair and every block. |
| Set `state.time.compacted` and let the engine clear the output | It is pair-safe, but the fixed engine text drops D02's `evidence_read` pointer. It also reads like the engine's own prune, which makes the two harder to tell apart in the replay. |
| Decide from `Date.now()` in the hook | The next step could not reproduce the decision. A borderline gap would flip the trimmed set between steps and rewrite the cache each time. |
| Put the trim decision in the harness per request | That is a network call in the hook, which the ticket rules out, and it adds latency to every step. |
| Change the relevance line in the selection ticket | It was a separate behaviour with its own tests; it was resolved as §7 (the A11 follow-up). |

## Out of scope

- A V2 seam. There is none (`docs/V2-HOOKS.md`).
- Cold starts inside a turn, and cold starts caused by a model switch or a compaction.
- A per-session holdout arm, and a recall-miss metric for placeholders that are later re-fetched.

## Implementation plan

- `packages/remote/src/engine-plugins.ts`: `CACHE_SELECTION_SOURCE` (the pure selection) and
  `CACHE_SELECTION_PLUGIN`. Tests are in `packages/remote/src/cache-selection.test.ts`: property tests
  for pair consistency, prefix stability, determinism and no input mutation, plus plugin tests for no
  network in the hook, latching and failing open.
- `packages/harness-server`:
  - `adaptive.selection` in `config.ts`;
  - the two writable leaves in `config-surface.ts`;
  - `GET /harness/adaptive/selection` and the `adaptive-selection` capability in `api.ts`, with the
    probe gate in `index.ts`;
  - `idleMs` on replay variants.
- `fixtures/replay/variants/selection.json`: the acceptance measurement. Both arms pause 6.5 minutes
  between prompts, so each turn starts cold.
- `fixtures/replay/variants/selection-warm.json`: the falsification arm. It trims at warm steps, and
  this ADR predicts a positive Δ USD for it.
