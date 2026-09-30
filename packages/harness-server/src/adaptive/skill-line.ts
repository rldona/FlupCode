/**
 * The line the engine receives when the harness suggests skills (FH-04, ADR-0021 §3).
 *
 * Two jobs, both pure and both content-free apart from skill names. `rankSkills` only **orders and
 * truncates** the candidate set the decision already chose (`answer.load`); it never re-matches the
 * objective against the whole roster, so the deterministic lexical baseline and the Phase 2/3a/3b
 * fixtures stay byte-intact. `renderSkillLine` writes the fixed `<skill_relevance>` box, names-only
 * and non-coercive, so a false suggestion cannot remove a skill or widen a permission.
 *
 * The trust invariant lives here, at the writer: the roster is the only whitelist and every emitted
 * name is validated against it and against `NAME`, so an answer that smuggled instructions or
 * unknown names cannot reach the prompt.
 */

import { NAME } from "../skills"
import { words } from "./context"

/** The only thing the writer knows about a skill: its name and the text the objective is scored on. */
export type SkillCandidate = {
  name: string
  description: string
  /** A learned skill; a learned entry never displaces a non-learned one with the same name. */
  learned?: boolean
}

export type RankSkillsInput = {
  objective: string
  /** `answer.load`: the candidate set the decision selected. */
  chosen: readonly string[]
  /** The loaded roster: the only source of valid names. */
  roster: readonly SkillCandidate[]
  /** `DecisionResult.probabilities`, present when the external provider won the decision. */
  probabilities?: Record<string, number>
  maxSkills: number
}

/** The box is frozen by a golden test; its only variable content is names joined by `, `. */
export const SKILL_LINE_TEMPLATE = (names: readonly string[]): string =>
  `<skill_relevance>Possibly relevant skills: ${names.join(", ")}. Consider loading one only if it clearly applies; otherwise ignore.</skill_relevance>`

const compareNames = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The roster the relevance writer trusts, deduped by name.
 *
 * `curator.roster` already returns one loaded entry per name, but a hand-made file could produce a
 * reverse collision — a learned entry sharing a human name — and the writer must never prefer the
 * learned one. A human entry wins; among equals, the first one wins, exactly as `skillReport` orders.
 */
export function dedupeRoster(roster: readonly SkillCandidate[]): SkillCandidate[] {
  const byName = new Map<string, SkillCandidate>()
  for (const entry of roster) {
    if (!NAME.test(entry.name)) continue
    const existing = byName.get(entry.name)
    if (existing === undefined) {
      byName.set(entry.name, entry)
      continue
    }
    if (existing.learned === true && entry.learned !== true) byName.set(entry.name, entry)
  }
  return [...byName.values()]
}

/**
 * The candidate names, ordered and capped.
 *
 * With probabilities it ranks by the provider's probability first, then by the lexical overlap with
 * the objective, then by name; without them it ranks by that overlap alone. Either way the tie-break
 * is the name ascending, so the same input always produces the same line.
 */
export function rankSkills(input: RankSkillsInput): string[] {
  const max = Math.floor(input.maxSkills)
  if (!Number.isFinite(max) || max <= 0) return []

  const roster = new Map<string, SkillCandidate>()
  for (const entry of input.roster) {
    if (!NAME.test(entry.name) || roster.has(entry.name)) continue
    roster.set(entry.name, entry)
  }

  const objective = new Set(words(input.objective))
  const hits = (text: string): number => words(text).filter((word) => objective.has(word)).length
  // Own properties only: a name like `constructor` would otherwise resolve on `Object.prototype` and
  // hand a function to the sort, poisoning the order with `NaN`. A missing or non-numeric entry is 0.
  const probabilities = input.probabilities
  const probability = (name: string): number => {
    if (probabilities === undefined || !Object.hasOwn(probabilities, name)) return 0
    const value = probabilities[name]
    return typeof value === "number" ? value : 0
  }
  const ranked = [...new Set(input.chosen)]
    .flatMap((name) => {
      const entry = roster.get(name)
      return entry === undefined ? [] : [{ name, entry }]
    })
    .map(({ name, entry }) => ({
      name,
      probability: probability(name),
      nameHits: hits(entry.name),
      descriptionHits: hits(entry.description),
    }))

  ranked.sort((a, b) => {
    if (input.probabilities !== undefined && b.probability !== a.probability) return b.probability - a.probability
    if (b.nameHits !== a.nameHits) return b.nameHits - a.nameHits
    if (b.descriptionHits !== a.descriptionHits) return b.descriptionHits - a.descriptionHits
    return compareNames(a.name, b.name)
  })

  return ranked.slice(0, max).map((entry) => entry.name)
}

/**
 * The rendered line, or `undefined` when there is nothing safe to render.
 *
 * A name that is not a bare folder name is dropped rather than escaped: the box carries names only,
 * and an empty selection is inert (nothing is added to the turn).
 */
export function renderSkillLine(names: readonly string[]): string | undefined {
  const valid = names.filter((name) => typeof name === "string" && NAME.test(name))
  if (valid.length === 0) return undefined
  return SKILL_LINE_TEMPLATE(valid)
}
