/**
 * `skillRelevance`: which skills should be loaded for this objective? Asked live by the relevance
 * line before a turn, and in the background by the episode shadow.
 */

import { words } from "../context"
import { defineDecision, weakest, yes } from "./define"

export type SkillRelevanceAnswer = { load: string[] }

export type SkillRelevanceState = {
  sessionID: string
  objective: string
  skills: Array<{ name: string; description: string; learned: boolean }>
}

export const skillRelevance = defineDecision<"skillRelevance", SkillRelevanceState, SkillRelevanceAnswer>({
  kind: "skillRelevance",
  capability: "classify",
  latencyClass: "hot",
  question: "Which skills should be loaded for this objective?",
  probabilities: "gates",
  // A gate per candidate skill: the answer is the set of names above the gate, which the service
  // then thresholds again. A state with no candidates asks nothing.
  questions: (state) =>
    state.skills.map((skill) => ({
      id: skill.name,
      type: "binary",
      prompt: `Load the "${skill.name}" skill (${skill.description}) for: ${state.objective}?`,
    })),
  read: (answers) => {
    const gates = Object.entries(answers).flatMap(([name, answer]) => {
      const probability = yes(answer)
      return probability === undefined ? [] : [[name, probability] as const]
    })
    return {
      answer: { load: gates.filter(([, probability]) => probability >= 0.5).map(([name]) => name) },
      ...weakest(Object.values(answers)),
      probabilities: Object.fromEntries(gates),
    }
  },
  baseline: (request) => ({ answer: lexicallyRelevant(request.state), rule: "lexical-objective-match" }),
  egress: (state) => state,
})

/**
 * The skills whose name or description shares a word with the objective.
 *
 * Lexical and boring on purpose: it is the fallback the richer provider is measured against, and it
 * loads nothing when there is no overlap, which is exactly the behaviour the harness has today.
 */
function lexicallyRelevant(state: SkillRelevanceState): SkillRelevanceAnswer {
  const objective = new Set(words(state.objective))
  const load = state.skills
    .filter((skill) => words(`${skill.name} ${skill.description}`).some((word) => objective.has(word)))
    .map((skill) => skill.name)
  return { load }
}
