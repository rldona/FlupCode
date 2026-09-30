/**
 * The skill curator: the one thing that promotes a proposal into a learned skill (FH-041), and the
 * one thing that ages learned skills (FH-042) and accounts their use (FH-043).
 *
 * It is deliberately the only public door to the learned-skill store. A proposal arrives validated
 * (FH-033), but the trust rule lives in the writer, so the curator re-runs the lint against the live
 * roster before writing: a human skill is never touched, a learned name is never overwritten, and
 * `merge`/`drop` are refused with a reason because 3b defers them (FH-044). The heavy writing — the
 * marker, the atomic temp + rename, the snapshot, the ledger — is the store's; the curator owns the
 * decisions above it.
 *
 * Usage is opportunity-relative and never wall-clock: `load` is recorded from a `skillRelevance`
 * selection, `patch` from a promotion that wrote a new version, `view` from the harness re-reading a
 * body to prepare a patch (the only seam 3b has; ADR-0019 §5), and `opportunities` advances for every
 * learned skill in the roster that was offered.
 */

import { basename } from "node:path"
import { skillReport } from "../../skills"
import type { DraftLimits } from "../learning/draft"
import type { ProposalRejection, SkillProposal } from "../learning/proposal"
import { validateProposal } from "../learning/proposal"
import type { LearnedStore, LearnedWriteRejection, LedgerEvent, SkillState, SkillUsage } from "./learned-store"
import type { LifecycleConfig, LifecycleReason } from "./lifecycle"
import { DEFAULT_LIFECYCLE_CONFIG, nextSkillState } from "./lifecycle"
import { bumpUsage, recallRate as rateOf, sameUsage } from "./usage"

export type SkillRosterEntry = {
  name: string
  description: string
  learned: boolean
  state?: SkillState
  usage?: SkillUsage
}

export type PromoteRejection = ProposalRejection | LearnedWriteRejection

export type PromoteResult =
  | { ok: true; path: string; state: "probation"; version: number }
  | { ok: false; reason: PromoteRejection }

export type SkillStateChange = { name: string; from: SkillState; to: SkillState; reason: LifecycleReason }

export type SelectionInput = {
  projectID: string
  /** The roster the `skillRelevance` decision was offered. */
  roster: readonly SkillRosterEntry[]
  /** The names the decision selected (`answer.load`). */
  loaded: readonly string[]
  /** The episode the selection belongs to; with it, a repeated report of one episode counts once. */
  episodeID?: string
}

export type SkillCurator = {
  /** Human and learned skills as the model would see them; learned carry their sidecar state. */
  roster(projectID: string): SkillRosterEntry[]
  /**
   * Validates (FH-033) and promotes a proposal; the only path that creates or patches a learned skill.
   * A caller that already read the roster may pass it, so one read serves the reflection and the write;
   * the store keeps checking collision and the marker live, so the roster is only the lint's fast-fail.
   */
  promote(proposal: SkillProposal, at?: number, roster?: readonly SkillRosterEntry[]): PromoteResult
  /** Records one `skillRelevance` opportunity, and a `load` for each skill it selected; once per episode. */
  recordSelection(input: SelectionInput): void
  /** The body a `patch` will improve, read from disk; the re-read is counted as a `view`. */
  readExisting(projectID: string, name: string): { name: string; description: string; body: string } | undefined
  /** Re-evaluates every learned skill and applies the lifecycle; returns the transitions made. */
  recompute(projectID: string, at?: number): SkillStateChange[]
  /**
   * Detects reverse collisions (a human skill created after a learned one with the same name) and
   * archives the learned one through the single writer with reason `human-name-collision`. Returns
   * what it reconciled. A security repair, so it runs even with learning off (ADR-0022 §4).
   */
  reconcile(projectID: string, at?: number): Array<{ name: string; reason: "human-name-collision" }>
  /** Moves a learned skill to the archive; `true` when it moved. */
  archive(projectID: string, name: string, reason: string): boolean
  /** `load / opportunities` from creation, or 0 when the skill has no sidecar yet. */
  recallRate(projectID: string, name: string): number
}

export function createSkillCurator(deps: {
  store: LearnedStore
  /** The lifecycle numbers; the curator falls back to the conservative defaults. */
  config?: () => LifecycleConfig
  /** The learning switch: with it off, a selection records no usage (the kill switch stops the write). */
  enabled?: () => boolean
  /** Shape limits the lint applies; the curator falls back to the `DRAFT_LIMITS` defaults. */
  limits?: () => Partial<DraftLimits>
  now?: () => number
}): SkillCurator {
  const now = deps.now ?? Date.now
  const config = (): LifecycleConfig => ({ ...DEFAULT_LIFECYCLE_CONFIG, ...deps.config?.() })

  /**
   * The names a human file claims: a non-learned `SKILL.md` the loader understood (`reason`
   * undefined) or skipped only because another skill already took the name (`shadows` set), whether
   * `skillReport` marks it loaded or shadowed. `skillReport` resolves first-wins over its root order,
   * while the engine scanner normalises an order-fragile "last wins" (ADR-0019 §Contexto), so the
   * human claim is read from the file's existence rather than from who won the report's race.
   *
   * A malformed `SKILL.md` — one whose frontmatter could not be read or is not settings — is
   * deliberately **not** a claim: its `reason` is neither absent nor a shadowing one, so it can never
   * archive a healthy learned skill. This is fail-closed in the unsafe direction only (it may fail to
   * exclude a learned skill a malformed human meant to shadow), never the reverse.
   */
  const humanClaimedNames = (report: ReturnType<typeof skillReport>): Set<string> =>
    new Set(
      report
        .filter(
          (file) =>
            file.name &&
            file.learned !== true &&
            basename(file.path) === "SKILL.md" &&
            (file.reason === undefined || file.shadows !== undefined),
        )
        .map((file) => file.name!),
    )

  const roster = (projectID: string): SkillRosterEntry[] => {
    const report = skillReport(projectID, projectID)
    const humans = humanClaimedNames(report)
    return report
      .filter((file) => file.loaded && file.name && !(file.learned === true && humans.has(file.name)))
      .map((file) => {
        const learned = file.learned === true
        const sidecar = learned ? deps.store.readSidecar(projectID, file.name!) : undefined
        return {
          name: file.name!,
          description: file.description ?? "",
          learned,
          ...(sidecar ? { state: sidecar.state, usage: sidecar.usage } : {}),
        }
      })
  }

  /**
   * The durable half of the reverse-collision rule: a learned skill a human file now claims a name
   * for is moved out of `skills/` through the single writer, so the engine's own scanner can no
   * longer pick it by "last wins". Archive is a move, never a delete, and the store records
   * `state: archived` and the reason in the ledger.
   *
   * It is **not** gated by the learning switch: a reverse collision is a security repair (the human
   * must win on disk), not a learning write (ADR-0022 §4). A move that fails is logged with its
   * reason and never retried in a loop; the read-time exclusion already protects every surface.
   */
  const reconcile = (projectID: string, at?: number): Array<{ name: string; reason: "human-name-collision" }> => {
    const report = skillReport(projectID, projectID)
    const humans = humanClaimedNames(report)
    const reconciled: Array<{ name: string; reason: "human-name-collision" }> = []
    for (const file of report) {
      if (file.learned !== true || !file.name || !humans.has(file.name)) continue
      const archived = deps.store.archive({
        projectID,
        name: file.name,
        reason: "human-name-collision",
        security: true,
        ...(at !== undefined ? { at } : {}),
      })
      if (!archived.ok) {
        console.warn(`[flupcode] could not archive shadowed learned skill "${file.name}": ${archived.reason}`)
        continue
      }
      reconciled.push({ name: file.name, reason: "human-name-collision" })
    }
    return reconciled
  }

  /** One usage counter advanced on disk, with a ledger line for the counters the audit cares about. */
  const bump = (projectID: string, name: string, kind: "load" | "view" | "patch", at?: number): void => {
    const sidecar = deps.store.readSidecar(projectID, name)
    if (!sidecar) return
    const usage = bumpUsage(sidecar.usage, kind)
    deps.store.updateSidecar({
      projectID,
      name,
      usage,
      events: [{ at: at ?? now(), event: "usage", kind, total: usage[kind] }],
      ...(at !== undefined ? { at } : {}),
    })
  }

  const promote = (proposal: SkillProposal, at?: number, providedRoster?: readonly SkillRosterEntry[]): PromoteResult => {
    // Fail-closed by construction: the kill switch is checked here too, so a caller that skips its own
    // gate cannot install a skill with learning off. The store checks it again on the write path.
    if (deps.enabled?.() === false) return { ok: false, reason: "disabled" }
    // One roster read, split into the two lists the lint needs; the store still checks collision live.
    const current = providedRoster ?? roster(proposal.projectID)
    const learnedSkills = current.filter((entry) => entry.learned).map((entry) => entry.name)
    const humanSkills = current.filter((entry) => !entry.learned).map((entry) => entry.name)
    const validation = validateProposal(proposal, { learnedSkills, humanSkills, ...(deps.limits ? { limits: deps.limits() } : {}) })
    if (!validation.ok) return { ok: false, reason: validation.reason }
    const valid = validation.proposal
    // A patch updates the skill it named; anything else creates the name it drafted.
    const name = valid.intent === "patch" ? valid.targetSkill! : valid.name

    const written = deps.store.write({
      projectID: proposal.projectID,
      name,
      description: valid.description,
      body: valid.body,
      source: {
        ...(proposal.episodeID ? { episodeID: proposal.episodeID } : {}),
        ...(proposal.decisionID ? { decisionID: proposal.decisionID } : {}),
      },
      evidenceRefs: proposal.evidenceRefs,
      ...(proposal.modelVersion ? { modelVersion: proposal.modelVersion } : {}),
      reason: "reflection",
      ...(at !== undefined ? { at } : {}),
    })
    if (!written.ok) return { ok: false, reason: written.reason }
    if (valid.intent === "patch") bump(proposal.projectID, name, "patch", at)
    return { ok: true, path: written.path, state: "probation", version: written.version }
  }

  const recordSelection = (input: SelectionInput): void => {
    // The kill switch stops the loop's writes; the shadow still reads the roster for its decisions.
    if (deps.enabled?.() === false) return
    const selected = new Set(input.loaded)
    for (const entry of input.roster) {
      if (!entry.learned) continue
      const sidecar = deps.store.readSidecar(input.projectID, entry.name)
      if (!sidecar) continue
      const counted = sidecar.countedEpisodes ?? []
      if (input.episodeID !== undefined && counted.includes(input.episodeID)) continue
      const chosen = selected.has(entry.name)
      const usage: SkillUsage = {
        ...sidecar.usage,
        opportunities: sidecar.usage.opportunities + 1,
        load: sidecar.usage.load + (chosen ? 1 : 0),
      }
      const events: LedgerEvent[] = chosen
        ? [{ at: now(), event: "usage", kind: "load", total: usage.load }]
        : []
      deps.store.updateSidecar({
        projectID: input.projectID,
        name: entry.name,
        usage,
        events,
        ...(input.episodeID !== undefined ? { countedEpisodes: [...counted, input.episodeID] } : {}),
      })
    }
  }

  /**
   * The body a `patch` is about to improve, so the draft can build on it instead of overwriting it
   * blind. Reading the body is the one thing 3b can call a `view`: the harness itself re-read it, and
   * the counter is incremented here (ADR-0019 §5).
   */
  const readExisting = (projectID: string, name: string): { name: string; description: string; body: string } | undefined => {
    const current = deps.store.read(projectID, name)
    if (!current) return undefined
    bump(projectID, name, "view")
    return current
  }

  const recompute = (projectID: string, at?: number): SkillStateChange[] => {
    // Reverse collisions first, and regardless of the switch: repairing a human-name collision is a
    // security move (ADR-0022 §4), not a learning write. An archived learned skill leaves the learned
    // root, so the lifecycle below only ever sees the skills that are still the harness's to age.
    reconcile(projectID, at)
    // Fail-closed like `promote`: with learning off the lifecycle writes nothing even if called directly.
    if (deps.enabled?.() === false) return []
    const changes: SkillStateChange[] = []
    for (const entry of roster(projectID)) {
      if (!entry.learned) continue
      const sidecar = deps.store.readSidecar(projectID, entry.name)
      if (!sidecar) continue
      const decision = nextSkillState({
        state: sidecar.state,
        usage: sidecar.usage,
        since: sidecar.since,
        config: config(),
      })
      if (!decision.changed) {
        // Activity slid the window without changing state; persist only when it actually moved.
        if (!sameUsage(decision.since, sidecar.since)) {
          deps.store.updateSidecar({
            projectID,
            name: entry.name,
            since: decision.since,
            ...(at !== undefined ? { at } : {}),
          })
        }
        continue
      }
      if (decision.to === "archived") {
        // Archive is a move, never a state write: the ledger gets its `archived` event.
        const archived = deps.store.archive({
          projectID,
          name: entry.name,
          reason: decision.reason,
          ...(at !== undefined ? { at } : {}),
        })
        if (archived.ok) changes.push({ name: entry.name, from: decision.from, to: decision.to, reason: decision.reason })
        continue
      }
      const updated = deps.store.updateSidecar({
        projectID,
        name: entry.name,
        state: decision.to,
        since: decision.since,
        events: [
          { at: at ?? now(), event: "state", from: decision.from, to: decision.to, reason: decision.reason },
        ],
        ...(at !== undefined ? { at } : {}),
      })
      if (updated.ok) changes.push({ name: entry.name, from: decision.from, to: decision.to, reason: decision.reason })
    }
    return changes
  }

  return {
    roster,
    promote,
    recordSelection,
    readExisting,
    recompute,
    reconcile,
    archive: (projectID, name, reason) => {
      // The kill switch also gates the direct archive, so learning off cannot move a skill.
      if (deps.enabled?.() === false) return false
      return deps.store.archive({ projectID, name, reason }).ok
    },
    recallRate: (projectID, name) => {
      const sidecar = deps.store.readSidecar(projectID, name)
      return sidecar ? rateOf(sidecar.usage) : 0
    },
  }
}
