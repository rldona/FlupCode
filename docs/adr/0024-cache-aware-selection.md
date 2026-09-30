# ADR-0024: Per-step selection only where the prompt cache is already cold

- **Status:** Accepted (PoC, off by default)
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

- **Readers.** A11 (`RELEVANCE_PLUGIN`) and D04 (`COMPACTION_ANCHORS_PLUGIN`) read only user text
  parts in this hook. Selection writes only completed tool outputs in assistant messages and returns
  every user message as the same object.
- **Order.** The engine loads plugin files in glob order, so `flupcode-cache-selection.js` runs first.
  The result does not depend on the order: the readers see identical input either way.
- **The relevance line.** It does interact with the cache, but through `system.transform`, not
  through this hook.
  - It is pushed into the second system message. That message carries a breakpoint and sits before
    the conversation.
  - Whenever the line differs from the previous request's, the conversation after the first system
    message is written again. This happens with a new objective, a timeout or an open breaker that
    drops the line, or a retry hint that silences it.
  - Selection never changes bytes at a warm step, so with both on, the cache is busted no more often
    than with relevance alone.
  - Making the line cache-stable is a follow-up for A11: latch it per user turn, or move it after the
    cached prefix. It is not part of this ticket.

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
| Change the relevance line in this ticket | It is a separate behaviour with its own tests and acceptance. It is recorded above as a follow-up. |

## Out of scope

- A V2 seam. There is none (`docs/V2-HOOKS.md`).
- Cold starts inside a turn, and cold starts caused by a model switch or a compaction.
- Making the A11 relevance line cache-stable.
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
