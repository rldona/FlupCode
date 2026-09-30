# ADR-0019: Learned skill lifecycle and provenance

- **Status:** Accepted
- **Date:** 2026-09-29
- **Related:** ADR-0016 (harness boundary), ADR-0017 (Jev egress and governance), ADR-0018 (context selection seam), ADR-0020 (learning persistence, cadence and egress), `flupcode-adaptive-harness-plan.md` §8 / §9 / §11 / §13 / §14 / §19, `fh-phase3b-design.md`

## Context

Phase 3b writes skills of its own for the first time. That is the highest-consequence write in the
Adaptive Harness: the engine loads skills from disk, a name collision silently changes which skill
the model sees, and human-authored skills share the same directory tree. The plan fixes the
constraints before the fact: **only the curator writes learned skills**, only into a learned root,
only with a `self-authored` marker, and human skills are never modified, moved or deleted (§8.2). The
permission ceiling is not negotiable either — a learned skill may never create, widen or bypass a
permission (ADR-0012 precedence, enforced at the writer per `flupcode-adaptive-harness-plan.md` §11).

Two properties of the engine's scanner decide where the root can live. `ConfigPaths.directories()`
returns the global config directory, the project `.opencode`, `~/.opencode` and `OPENCODE_CONFIG_DIR`
(`packages/opencode/src/config/paths.ts:23`), and each is scanned with the pattern
`{skill,skills}/**/SKILL.md` and `dot: false` (`packages/opencode/src/skill/index.ts:23-25`,
`:208`). The scanner was run against the repository's own glob over a test `.opencode`, not assumed:
`<project>/.opencode/skills/**/SKILL.md` **is** scanned, `.versions/old.md` is **not**, and a
directory outside `skills/` is **not**. A hidden directory inside `skills/` (`.foo`) is skipped by
`dot: false`, so it would be invisible to the engine while the harness's own `skillReport` — which
walks hidden directories with `markdownIn` (`packages/harness-server/src/skills.ts:88`) — would still
list it. That asymmetry rules out a hidden root and any `.md` snapshot under `skills/`.

A second engine fact is a hazard: `add()` normalises to `state.skills[name] = …` so **the last
definition wins**, and the scan fans out with unbounded concurrency
(`packages/opencode/src/skill/index.ts:126-135`). Duplicate names are therefore order-fragile, which
means the guard against collision cannot live in the reader; it must live in the single writer.

This ADR is step 0b of Phase 3b (`fh-phase3b-design.md` §12–§13), after
[ADR-0020](0020-learning-persistence-and-egress.md), and blocks all learned-skill code. It settles
plan §14's "self-authored marker, sole writer, probation/mature/stale/archive, usage accounting,
merge semantics, archive-not-delete, and the permission ceiling".

## Decision

### 1. One project-scoped learned root, verified scannable by the real engine

The learned root is a dedicated, **non-hidden** subdirectory inside the skills folder the engine
already scans, so a learned skill loads like any other:

```
<project>/.opencode/skills/flupcode-learned/<name>/SKILL.md
<project>/.opencode/skills/flupcode-learned/<name>/.sidecar.json
<project>/.opencode/skills/flupcode-learned/<name>/.ledger.jsonl
<project>/.opencode/skills/flupcode-learned/<name>/.versions/<contentHash>.txt
```

The archive and the auxiliary roots live **outside `skills/`**, siblings of the learned root, so the
engine never re-loads them:

```
<project>/.opencode/flupcode-learned-archive/<name>/...
```

Roots are resolved by an injectable function, with environment overrides for tests: the learned root
is overridden by `FLUPCODE_ADAPTIVE_LEARNED_ROOT` (mandatory for test isolation) and the archive by
the optional `FLUPCODE_ADAPTIVE_LEARNED_ARCHIVE`. Global scope is **out of 3b**: nothing is derived
from `configDirectory()`, and if the project directory is not an absolute, existing, writable path
(for example the literal `"local"` of a session with no run) the curator rejects with `no-project`
rather than inventing a relative folder. This is what makes cross-project leakage impossible by
construction; the global layer is Phase 11 and needs the same explicit human promotion (ADR-0020 §8).

The choice is forced by the verified scanner. A **global** root would learn across projects and
violate project scope; a root inside the human `skills/` tree would sit beside files the curator must
never touch; a **hidden** root (`dot: false`) would not load; and a hidden snapshot or archive inside
`skills/` would be invisible to the engine but visible to `skillReport`, producing an incoherent
catalogue.

### 2. A single writer with a realpath guard, a marker, and name-collision rejection

`SkillCurator` promotes; `SkillStore.write` is the **only** function that writes a learned file, and
it applies these guards in order:

1. **Name** must match the same shape the human store uses
   (`packages/harness-server/src/skills.ts:60` `NAME = /^[a-z0-9][a-z0-9._-]*$/i`) or the write is
   rejected `invalid-name`.
2. **Realpath containment**: the final path must resolve inside the learned root, comparing real
   paths with the technique already used in `config-files.ts` (`safeRealpath` `:434`,
   `escapesRepo` `:466`) so an intermediate symlink cannot escape. Failure is `path-escape`.
3. **Never human**: if `SKILL.md` already exists and its frontmatter does **not** carry
   `self-authored: true`, the write is rejected `not-self-authored`. A human skill is never
   overwritten, moved or deleted.
4. **No name collision**: `skillReport(projectID)` must not load any skill **outside** the learned
   root with the same `name`; if it does, the write is rejected `name-collision`. This is the only
   real defence against the engine's "last wins" normalisation, and it is why the guard is at the
   writer, not the reader. `skill-store` reuses `skills.ts` (`skillReport`, `NAME`) rather than
   re-implementing the collision formula.
5. **Only under the root**: the final path is always `join(learnedRoot, name, "SKILL.md")`; the
   archive only ever moves from the learned root to the archive root.
6. **Every file, not just the folder** (AH-A03): a skill folder, or its `.versions/`, holding a
   symlink, a special file or a hard-linked file is refused whole (`unsafe-entry`). Temps are random
   names created with `wx` and the ledger is opened with `O_NOFOLLOW`, so no write goes through a
   link a repository committed.
7. **Harness-verified provenance** (AH-A03): the marker is committable, so it only says "learned".
   A patch, a sidecar update or an archive (including the reverse-collision repair) requires the
   sidecar's `provenance` — an HMAC over the folder name and `contentHash` under the
   per-installation key — to verify; otherwise it is rejected `unverified` and the skill is
   read-only.

The marker is written into frontmatter as `self-authored: true`
(`serialiseFrontmatter({ fields: { name, description, "self-authored": true }, prompt: body })`).
The engine's `isSkillFrontmatter` only requires `name` and treats `description` as optional, so the
extra field is safe, and `learned` is derived from the marker rather than the path so it survives a
move. Because the engine does not expose its loaded state to `harness-server`, the guard is local:
this is the ADR-0016 §3 rule that the invariant lives at the writer.

### 3. Provenance on disk: sidecar, ledger, snapshots, atomic install

Each learned skill is self-describing and portable without opening SQLite:

- **`.sidecar.json`** carries the derived state the curator reads and writes: `name`, `version`,
  `contentHash` (sha256 of the serialised `SKILL.md`), `provenance` (§2.7), `state`, `createdBy`, timestamps, the
  `source` (`projectID`, `episodeID`, `proposalID`, `decisionID`), `evidenceRefs`, `modelVersion` and
  the `usage` counters.
- **`.ledger.jsonl`** is append-only, one JSON event per line: `created`, `patched` (from/to hash),
  `usage`, `state` (from/to, with a reason) and `archived`. A failed append is logged and the write
  continues — the skill is not rolled back because audit failed, exactly as `adaptive_decision`
  behaves.
- **Versions/snapshots** are written to `.versions/<oldContentHash>.txt` **before** a patch. The
  extension is `.txt`, not `.md`, because `markdownIn` would otherwise list them as unloaded
  catalogue noise. At most `SNAPSHOT_KEEP = 5` are retained per skill (config
  `learning.snapshotKeep`).

**Install is atomic via temp + rename**: on create the directory is made, the sidecar and ledger are
written (temp + rename), and `SKILL.md` is written to a random, exclusively created temp then `renameSync`d into place —
**the rename is what makes the skill visible**. An interruption before it leaves a directory with no
`SKILL.md` (ignored by both scanners) and a non-`.md` temp file. A patch snapshots the current body
first, then renames the new temp over `SKILL.md`; a new `version` and `contentHash` follow. An
archive is `mkdirSync(archiveDir, { recursive: true })` plus a `renameSync` of the skill directory,
on the same filesystem (`<project>/.opencode`), then the archived sidecar is updated. A learned
skill found without a verifying sidecar (missing, corrupt, lagging the body after a crash, or written
before provenance existed) is read-only: it is no longer reconstructed as PROBATION v1, because
signing whatever body is on disk would adopt a skill a repository committed (AH-A03).

### 4. Lifecycle: probation is not evictable; graduation only without load or view

`SkillState = "probation" | "mature" | "stale" | "archived" | "merged"`. `NEW` is **not** a state
observable on disk: it is the state of a *proposal* before install (`proposal.status = "proposed"`),
and the curator installs directly into `probation`. `merged` exists in the type but 3b **never
reaches it** — merge is deferred (FH-044).

A pure `recompute` over usage and config drives:

```
install                                                    → probation
probation & opportunities >= probationSample & load >= 1   → mature   (graduation)
probation & opportunities >= probationSample & load == 0   → stale
mature    & no load and no view in the last staleAfter opportunities → stale
stale     & no load and no view after archiveAfter opportunities     → archived
patch (new version)                                        → probation (re-evaluated)
archive (explicit)                                         → archived
```

Two rules from the plan are enforced here. **PROBATION is not evictable**: 3b has no capacity sweep
(merge/FH-044 is deferred), and the stale sweep only acts from `mature`/`stale`, never from
`probation` before the sample. **Graduation archives only a skill with no load and no view**: the only
age-based archive leaves `stale`, which by definition had no recent use, so a used skill never
archives itself. `probationSample`, `staleAfter` and `archiveAfter` are config with conservative
defaults.

### 5. Usage accounting is opportunity-relative, never wall-clock

Four counters live in the sidecar:

- **`load`** (recall/selection) — the skill appeared in `answer.load` of a `skillRelevance` shadow
  decision. This is the signal 3b measures.
- **`view`** — **reserved in 3b**. There is no seam to observe that the model opened a skill; that
  would be core (Phase 9). It is incremented only when the harness itself re-reads the body, for
  example while preparing a `patch`. `view == 0` therefore does **not** mean "unused" in 3b.
- **`patch`** — the curator wrote a new version from a proposal or an edit.
- **`opportunities`** — one per `skillRelevance` decision whose roster included the skill; that is,
  every time it could have been chosen. The roster is `skillReport` plus learned entries.

The rate is opportunity-relative:

```
recallRate(projectID, name) = usage.load / max(usage.opportunities, 1)
```

The selection is recorded after the shadow's `skillRelevance`: the curator increments
`opportunities` for every skill in the roster and `load` for the selected ones, one best-effort
sidecar write per affected learned skill. This is the metric ADR-0020 §9 makes falsifiable offline.

### 6. The permission ceiling is a rule in the writer

A learned skill cannot create, widen or bypass a permission. `SkillStore.write` requires the marker,
enforces the path guard and never writes outside the learned root; a learned skill is at most one
more skill, evaluated by the engine through `permission.effect("skill", name)` like any other. The
content is redacted and bounded before it is persisted or egressed (ADR-0020 §2, §5). The curator has
no capability to edit `permission`, `instructions` or human files, so the trust invariant is
enforced by construction at the single writer rather than by a service (plan §11).

## Consequences

Positive:

- A learned skill loads through the engine's own scanner with no engine change, and because the root
  is project-scoped, learning cannot leak across projects.
- Human skills are provably never touched: the realpath guard, the marker and the collision rejection
  are checked before any write, and a byte-identity test proves it.
- Every write is atomic and every change is append-logged; a crash leaves either a complete skill or
  nothing visible, and `archive` is reversible because it is a move.
- The lifecycle makes a new skill visible without letting it be evicted before it had a fair sample,
  and no used skill is archived by age alone.
- Provenance and usage travel with the skill in the sidecar and ledger, so the library is auditable
  without opening the database.

Negative / accepted costs:

- `view` is unobservable in 3b, so the "recall value vs survival" distinction the plan draws (§8.1)
  is only half implemented; `load/opportunities` is the real metric and `view=0` is documented as
  unknown, not unused.
- Merge and capacity are absent, so the library can only grow in 3b; `PROBATION` not being evictable
  is intentional but means a bad draft stays until a human archives it.
- Worktrees: `episode.projectID` is `run.directory`, which with `worktrees: true` can be a temporary
  worktree; a learned skill could land there and disappear. 3b requires an absolute existing
  directory but does not resolve the canonical project root — accepted, documented, and a Phase 11
  combination.
- The root lives under `.opencode`, so a project that does not persist that directory loses its
  learned skills; that is the same storage the rest of the project config uses.

## Alternatives considered

| Alternative | Why it is not adopted |
| --- | --- |
| A global learned root | Always writable, but learns across projects; violates project scope and FH-081 isolation. |
| Reuse `writeSkill`/`pathFor` from `skills.ts` (the human root) | That is exactly the tree the curator must never touch, and `pathFor` knows neither the marker nor the sidecar. |
| A hidden root inside `skills/` | `dot: false` hides it from the engine (it would not load) while `markdownIn` still lists it in the harness; incoherent. |
| Archive inside `skills/flupcode-learned/.archive` | The engine ignores it but `skillReport` lists its `SKILL.md` files, and a mis-filtered candidate list would offer them as available. |
| `.md` snapshots in `.versions/` | `markdownIn` would list them as unloaded noise and they are reachable by the scanner pattern. |
| Guarding collisions in the reader | The engine's "last wins" and unbounded concurrent scan make the reader order-fragile; the guard must be at the writer. |
| Writing `SKILL.md` without temp + rename | A crash mid-write leaves a truncated frontmatter the engine tries to parse. |
| A ledger in SQLite instead of a per-skill file | The plan asks for a per-skill ledger beside the skill; sidecar + ledger keep it portable and auditable without the DB. |
| Auto-graduation by age alone | Contradicts "graduation only without load and no view". |
| Evicting PROBATION by capacity | Forbidden by the plan (rule 5); there is no capacity sweep in 3b. |
| Counting `view` as `load` in 3b | Would falsify the metric; `view` is declared reserved. |
| A wall-clock rate (loads/day) | The plan explicitly rejects it; the rate is opportunity-relative. |
| `NEW` as an on-disk state | It would force a non-loadable or transient state with no value; `NEW` is the proposal's state. |

## Out of scope

- Merge and capacity eviction (FH-044) and archive/revive (FH-045); `merged` is declared but never
  reached in 3b.
- Global scope and cross-project promotion (FH-081, Phase 11).
- Observed `view` via a core seam (Phase 9).
- The Learned Skills UI (FH-046): 3b ships the route and the `adaptive-skills` capability only.
- Retention and purge (plan §19).
- Any change to core, Protocol/HttpApi, the SDK, `packages/harness`, `packages/remote` or the engine
  scanner; the root is chosen to fit the existing scanner, not to change it.

## Implementation plan

Phase 3b is FH-040…FH-046 in `flupcode-adaptive-harness-plan.md` §13, with the file map, step order
and verification commands in `fh-phase3b-design.md` §10, §13 and §14. This ADR is step 0b, after
[ADR-0020](0020-learning-persistence-and-egress.md), and blocks the learned-skill code
(`skill-store.ts`, `skill-curator.ts`). Its acceptance: the root is scannable by the real engine, a
human skill is byte-identical after any curator run, PROBATION is not evictable, archive is a move,
and the lifecycle is auditable from the sidecar and ledger.
