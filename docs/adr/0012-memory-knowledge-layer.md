# ADR-0012: Memory as a first-class knowledge primitive

- **Status:** Accepted
- **Date:** 2026-09-14

## Context

An agent keeps rediscovering the same operational knowledge: how a project deploys, which package
manager it uses, which directories are generated, how its CI runs, what the user asked it never to
do. In a new session that knowledge is gone, so the harness spends tokens, latency, and attention
re-deriving it, and repeats mistakes that were already solved.

FlupCode already has several knowledge layers:

- **Instructions** (`AGENTS.md`, `config.instructions`, `agent.system`): human-authored, versioned,
  always-on, authoritative.
- **Permissions/policies**: hard rules enforced by the runtime.
- **Skills**: human-authored procedural knowledge, loaded on demand through the `skill` tool.
- **Commands / MCP / references**: invocable or external capabilities.
- **Session history**: the durable conversation, compacted over time.

None of them can hold _learned_ knowledge with provenance, confidence, and a lifecycle. A single
`memory.md` included whole in every prompt would grow without bound and dilute the context; keeping
memory only in conversation history loses it at the next session.

## Decision

Memory is a **first-class core primitive** with its own store, retrieval, lifecycle, API, and UI.
It is a _retrieved_ layer, never an always-on dump.

### Knowledge model

Two axes matter more than topic: **provenance** (human-authored vs harness-learned) and **loading**
(always-on vs selected-on-demand).

| Layer                | Author         | Loading             | Authority             | Storage      |
| -------------------- | -------------- | ------------------- | --------------------- | ------------ |
| Permissions/policies | human          | always-on, enforced | highest (hard)        | config       |
| Instructions         | human          | always-on           | high (explicit rules) | files/config |
| Skills               | human          | on-demand           | high (procedural)     | files        |
| Commands             | human          | on-demand           | high                  | config/files |
| MCP                  | external       | on-demand           | medium                | external     |
| **Memory**           | harness + user | relevance-retrieved | evidence-based        | SQLite       |
| Session history      | runtime        | epoch/compaction    | n/a                   | SQLite       |

Rules:

- Memory **informs**; it never overrides a permission or a current instruction. Conflicts are
  surfaced, not silently merged.
- Repository knowledge is project memory anchored by directory. There is no separate repository
  layer.
- Session memory shares the store with `scope=session` but is never auto-promoted.

### Scopes

`global` (the user), `project` (the repository/worktree), `agent` (`projectID:agentID`), and
`session`. Global and project are shared by every agent; agent memory is private; the retriever
includes only the current agent's private memory.

### Store

SQLite tables `memory` and `memory_use`. A memory carries `scope`, `kind`, `title`, `content`,
`tags`, `source`, `source_ref`, `status`, `confidence`, `importance`, `created_by`, `directory`,
`fingerprint`, `validation`, `superseded_by`, timestamps, and `use_count`. `fingerprint` gives
idempotent dedupe per scope: a repeated discovery merges evidence, raises confidence/importance, and
refreshes the timestamp instead of inserting a duplicate.

### Capture

- **Explicit** (`source=explicit_user`): a deterministic parser captures `remember that…`,
  `don't forget…`, and Spanish equivalents at the next safe provider-turn boundary, independently of
  model execution. Scope is inferred from cues (this project → project, I prefer → global, the X
  agent → agent).
- **Agent tool** (`source=agent_tool`): the `memory` tool lets the model add, update, forget, and
  list memories with correct attribution.
- **Implicit** (`source=agent_discovery`): after an idle drain, a background pass sends the bounded
  recent transcript to the configured small model, validates the JSON candidates, and stores them as
  `status=candidate` for review. It never blocks or fails a session, is skipped when no small model
  is configured, and is rate-limited.

### Retrieval

Retrieval is deterministic and local: candidates are filtered by scope and status, ranked by lexical
overlap (title/tags weighted above content), scope priority, importance, confidence, and recency
within a token budget, then rid of superseded and contradictory entries. No embeddings, no network
call, no model. Embeddings can later implement the same retrieval interface.

### Injection

Relevant memories are appended to the provider turn as a bounded `<memory>` system part, after the
selected agent's system prompt and the context-epoch baseline. This is deliberately **not** a
`SystemContext` source: memory relevance depends on the pending prompt, which the runner promotes
after baseline initialization, and per-prompt reconciliation would emit durable mid-conversation
messages on every turn. Usage is recorded in `memory_use` and exposed through the memory inspector.

### Validation, decay, and conflicts

- Anchors (files, directories, commands, URLs) are extracted from content and re-checked on demand
  or opportunistically. A missing anchor marks the memory `stale`.
- Confidence decays with age since last validation/use; stale memories are demoted and injected only
  as a warning when nothing else matches.
- Contradiction is a conservative same-scope, shared-tag, differing-tool/polarity heuristic. The
  older/discovered memory is marked `superseded_by`; two contradictory active memories are never
  injected together. Instruction-vs-memory conflicts are shown to the user, and memory never edits
  files.

### UI and API

The `server.memory` group exposes list/get/create/update/remove/verify/used over the public
`HttpApi`, surfaced through the generated client. The harness adds a Memory manager (search,
filters, edit, delete, verify, approve candidates, provenance and usage) and a session Memory
inspector in the context panel.

## Consequences

- A new session can retrieve procedures and preferences without rediscovering them, while memory
  stays bounded to a handful of top-ranked entries.
- Memory is inspectable, editable, and deletable; a candidate is never silently promoted.
- Automatic extraction adds background cost only when a small model is configured.
- Multi-agent propagation, embeddings/hybrid retrieval, confidence analytics, and generating skills
  from memories remain future work behind the same seams.
- `docs/ARCHITECTURE.md` stock upstream packages are extended in practice for this primitive;
  keeping the diff contained to memory modules, one config module, one tool, one protocol group, one
  handler, and the runner injection point limits upstream merge conflicts.
