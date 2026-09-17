# ADR-0014: Memory handoff and guarded capture

- **Status:** Proposed
- **Date:** 2026-09-18
- **Related:** ADR-0012 (complementary; it keeps the store, scopes, and candidate lifecycle, and narrows retrieval to reviewed entries)

## Context

ADR-0012 makes memory a first-class retrieved primitive, and it is implemented: a SQLite store with
scopes and provenance (`packages/core/src/memory.ts`), a candidate lifecycle reviewed in the harness
Memory manager, an agent `memory` tool, deterministic capture of explicit user cues, interval-gated
background extraction with a small model, lexical retrieval injected as a bounded `<memory>` block,
the `server.memory` API, and the session Memory inspector.

That layer answers "what have we learned about this project". It does not reliably answer "what was
the previous session doing", which is the question a new session actually starts with:

- Session-scoped memories are deleted with their session, so work-in-progress state does not cross
  the boundary users hit most often: today's session continuing yesterday's task.
- Background extraction sees only a bounded transcript. It has no ground truth about what changed in
  the worktree, and it runs on the same interval whether a session moved the project or only
  answered a question.
- Candidate knowledge is review-gated by ADR-0012, but retrieval currently selects `candidate` rows
  too, so unreviewed knowledge is injected as if it were accepted.
- The write path has no deterministic secret check, and `memory forget` hard-deletes rows, leaving
  no history to audit.

A previous proposal (written without filesystem access, before ADR-0012 was known) described a
parallel memory system: Markdown files under `.flupcode/memory/`, a `proposed/` queue, a generated
index, a CI file validator, and a V1 `experimental.session.compacting` plugin. This ADR keeps
ADR-0012's store and decides only session-boundary capture and write-path guards.

## Decision

### 1. Deterministic evidence precedes any extraction call

At a session boundary (run idle) and at a compaction boundary, the harness collects evidence
without tokens: `git status` / `diff --stat` / `HEAD` for the session worktree, files edited,
commands executed and test outcomes, time since the last capture, and explicit user cues.

The evidence produces a capture score. The exact formula is implementation detail; the properties
are fixed:

- Below the threshold there is exactly zero model spend and nothing is written.
- Above the threshold, at most one bounded extraction call runs, with the evidence included as
  ground truth; the transcript stays bounded by the existing `serializeRecent` limits.
- The existing `extract_interval` becomes a safety net, not the primary gate.

Evidence collection is best-effort and location-scoped: outside a repository, or when git is
unavailable, the transcript-only path remains.

### 2. Session handoff is one project-scoped memory entry

When the evidence indicates unfinished work, extraction may produce at most one **handoff entry**:

- scope `project`, kind `issue`, tag `handoff`, `source=agent_discovery`, with `sourceRef.sessionID`.
- status `active`, not `candidate`: a handoff is operational _state_, not reviewed knowledge, and it
  expires instead of being promoted.
- at most one live handoff per project; writing a new one archives the previous.
- `memory.handoff_ttl_days` (default 7): expired handoffs are archived and never injected again.

The live handoff is injected at the first provider turn of a new session, labeled as state, ahead of
relevance-retrieved memories, within the existing injection budget. Later turns rely on the
conversation itself.

### 3. Candidate knowledge is not injected before review

Retrieval selects `active` entries only. This corrects the current behavior of selecting `candidate`
rows and restores the review gate ADR-0012 and `docs/MEMORY.md` describe. The handoff entry of
decision 2 is the single deliberate exception: it is written `active` and expires.

### 4. Extraction also runs at compaction boundaries

Before a compaction summary replaces session history, the same evidence-gated capture runs over the
pre-compaction context. Knowledge and work state in the compacted portion leave the bounded recent
window that idle extraction reads, so this boundary is the last cheap moment to capture them.

The V2 core compaction summary already preserves objective, decisions, work state, blockers, next
move, and relevant files for within-session continuation
(`packages/core/src/session/compaction.ts`). No `experimental.session.compacting` plugin hook is
added: it belongs to the V1 path and would not run.

### 5. Write-path guards

- **Secrets never persist.** Every write path (explicit capture, agent tool, extraction) passes a
  deterministic secret check before `create`/`update`; credentials, tokens, private keys, and
  obvious environment values are rejected. The extraction prompt already instructs the model to
  exclude secrets; this makes the rule enforceable.
- **Memory is data, not instruction.** Instructions, permissions, and Skills keep precedence over
  memory, and the injected block keeps its "may be outdated; verify" framing. Memory never edits
  configured files.
- **Forget archives.** `memory forget` sets `status=archived` instead of deleting the row. Explicit
  purge remains a separate action in the Memory manager. The `archived` status already exists.
- **Agent writes stay in their lane.** The agent may create only candidate knowledge entries and the
  single project handoff; nothing else is model-writable.

### 6. Invariants

- I1. The agent writes only candidate knowledge entries and the single live project handoff; every
  other write path is human or deterministic capture.
- I2. Instructions, permissions, and Skills take precedence over memory; memory is data and never
  edits files.
- I3. Every entry keeps provenance (`source`, `sourceRef`, `createdBy`, timestamps); the handoff
  carries the session that produced it.
- I4. No write path persists a secret.
- I5. No model call happens without evidence above the threshold.
- I6. At most one live handoff exists per project; expired ones are archived.
- I7. `forget` archives; no automatic path hard-deletes a row.
- I8. Injected entries are `active` entries plus the live handoff; candidates are not injected.

## Consequences

Positive:

- A new session whose predecessor ended mid-task receives the work state on the first prompt.
- Extraction spend is tied to evidence: quiet sessions cost zero tokens.
- Secrets cannot land in the store by accident; forgotten memories keep provenance.
- The candidate queue stays a queue: unreviewed knowledge no longer leaks into prompts.
- Handoffs are self-cleaning: one live entry per project, expired by TTL.

Negative / accepted costs:

- One more background pass and one config knob to maintain.
- Handoff quality depends on the small model. A bad handoff is injected until it expires or is
  corrected; the TTL bounds the damage and the manager allows correction.
- Archive-first means the database only grows unless the manager purge is used.
- Evidence is richer inside a git worktree; sessions elsewhere fall back to transcript-only capture.

## Alternatives considered

| Alternative                                                                             | Why it is not adopted                                                                                                                                                        |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown files under `.flupcode/memory/` with `proposed/`, a generated index, and a CI validator | Duplicates ADR-0012's store, retrieval, and candidate review with a second source of truth. No repo files means no merge conflicts and no CI budget to enforce; provenance and `archived` cover the audit need. |
| A dedicated `current.md` handoff file                                                   | A third store to keep in sync with the database; a project-scoped entry already has retrieval, provenance, expiry, and UI.                                                   |
| Handoff in session scope                                                                | Deleted with its session, which is exactly the failure this ADR addresses.                                                                                                   |
| Handoff as `candidate`                                                                  | Candidates are review-gated; state must be available on the next first prompt or it does not solve the problem.                                                              |
| LLM summary on every idle                                                               | Cost and frequency are unacceptable for continuous use; evidence gating removes the need.                                                                                    |
| V1 `experimental.session.compacting` plugin                                             | The active runtime compacts in V2 core and never triggers it.                                                                                                                |
| Soft-delete through git history                                                         | Memory lives in the engine database, not the repository, so git cannot recover a purge.                                                                                      |
| Embeddings or a vector store                                                            | ADR-0012 already rejects premature semantic retrieval; evidence and lexical retrieval validate the concept first.                                                            |

## Implementation plan

1. **Evidence collector (core).** Deterministic, location-scoped collection of git status/diff/HEAD,
   files edited, commands and test outcomes, time since last capture, and explicit cues. Unit tests.
2. **Score gate and evidence-aware extraction.** Extend `MemoryExtract` to accept evidence and to
   skip the model below the threshold; keep the `serializeRecent` bounds. Tests for zero calls below
   the threshold and at most one call above it.
3. **Handoff entries.** Extraction emits at most one `handoff`-tagged entry for unfinished work;
   creation archives the previous live handoff; add `memory.handoff_ttl_days` to `Config.memory`.
4. **First-turn injection.** Include the live project handoff in the first provider turn of a
   session, labeled as state, within `max_injected`/`max_tokens`.
5. **Retrieval gate fix.** Restrict retrieval to `active` entries; adjust `docs/MEMORY.md` if its
   wording needs it.
6. **Write-path guards.** Secret check at the `create`/`update` choke point; `memory forget`
   archives; manager purge is explicit.
7. **Harness.** Handoff and archived states in `MemoryPanel`/`MemoryInspector` with i18n strings.
8. **Verification.** Cover invariants I1–I8 and confirmations C1–C6 with core and harness tests, then
   `bun typecheck` and `bun test` from the owning packages.

## Confirmation

- C1. Quiet sessions (no evidence) cause zero extraction calls; busy sessions stay at ≤ 1 call per
  interval in p50.
- C2. A session that ended mid-task leaves a live handoff that appears in the next session's first
  provider turn.
- C3. At most one live handoff exists per project; expired handoffs are never injected.
- C4. No memory row contains a secret pattern after the write-path test suite.
- C5. The injected block stays within `max_injected`/`max_tokens`.
- C6. `memory forget` archives; no automatic path hard-deletes a row.

## Out of scope

- Changing ADR-0012's store, scopes, kinds, or API shape.
- Embeddings, hybrid retrieval, or cross-device sync.
- Generating Skills from memories; learned procedures remain memory entries until a human promotes
  them to a Skill or an instruction.
- Extending the handoff beyond repository sessions; those fall back to transcript-only capture.
