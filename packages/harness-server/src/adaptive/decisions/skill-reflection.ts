/**
 * `skillReflection`: does this closed episode carry a reusable lesson, and what change does it call
 * for? Asked in the background by the learning manager (FH-031).
 */

import type { EpisodeOutcome } from "../episode"
import { chosen, defineDecision, weakest, yes } from "./define"

/**
 * The change a reusable lesson calls for (FH-031). `merge` and `drop` are declared so the vocabulary
 * is closed and a model adapter can parse them, but Phase 3b rejects both with a reason: only `add`
 * and `patch` are implemented, and `merge`/`drop` are later phases (ADR-0020 §9).
 */
export const REFLECTION_INTENTS = ["add", "patch", "merge", "drop"] as const
export type ReflectionIntent = (typeof REFLECTION_INTENTS)[number]

export const isReflectionIntent = (value: unknown): value is ReflectionIntent =>
  typeof value === "string" && (REFLECTION_INTENTS as readonly string[]).includes(value)

export type SkillReflectionAnswer = {
  reusable: boolean
  intent: ReflectionIntent
  /** The name of the existing skill a `patch`/`merge` points at, when one was chosen. */
  target?: string
}

/**
 * What a closed episode offers a reflection decision (FH-031).
 *
 * Bounded signals and a roster, never a transcript: the decision is *whether* a lesson is reusable
 * and *what* it calls for, and the small model drafts the text afterwards. `skills` is the current
 * roster so a `patch`/`merge` can point at a real skill by name.
 */
export type SkillReflectionState = {
  episodeID: string
  objective: string
  outcome: EpisodeOutcome
  toolCalls: number
  /** Bounded, deterministic signals ("verify:test ok", "file:src/x.ts", "failure:…"). */
  signals: string[]
  skills: Array<{ name: string; description: string; learned: boolean }>
}

export const skillReflection = defineDecision<"skillReflection", SkillReflectionState, SkillReflectionAnswer>({
  kind: "skillReflection",
  capability: "classify",
  latencyClass: "batch",
  question: "Does this episode carry a reusable lesson, and what change does it call for?",
  probabilities: "gates",
  // One request per episode: `reusable` is the gate, `intent` is what the lesson calls for, and
  // `target` is only asked when there is a roster to point at (a state with no skills asks two).
  questions: (state) => [
    {
      id: "reusable",
      type: "binary",
      prompt: `Does this episode contain a reusable, non-obvious lesson for a future task? Objective: ${state.objective}. Signals: ${state.signals.join("; ")}`,
    },
    {
      id: "intent",
      type: "choice",
      prompt: "Which change does the lesson call for?",
      options: [...REFLECTION_INTENTS],
    },
    ...(state.skills.length > 0
      ? [
          {
            id: "target",
            type: "choice" as const,
            prompt: "Which existing skill should it target, if any?",
            options: state.skills.map((skill) => skill.name).slice(0, 255),
          },
        ]
      : []),
  ],
  // The binary gate decides reusable; a missing or unrecognised intent falls to the safe `add`, and
  // the target is only carried when the model named one. The service folds the gate's certainty into
  // the reported confidence and keeps the weakest, so a noisy intent can pull a confident gate below
  // the policy and the service degrades to inert.
  read: (answers) => {
    const reusable = yes(answers.reusable)
    if (reusable === undefined) return undefined
    const intent = chosen(answers.intent)
    const target = chosen(answers.target)
    return {
      answer: {
        reusable: reusable >= 0.5,
        intent: isReflectionIntent(intent) ? intent : "add",
        ...(target ? { target } : {}),
      },
      ...weakest([answers.reusable, answers.intent]),
      probabilities: { reusable },
    }
  },
  // Inert on purpose: without a classifier nothing is reusable, so an idle project learns nothing.
  baseline: () => ({ answer: { reusable: false, intent: "add" }, rule: "no-reflection" }),
  egress: (state) => state,
})
