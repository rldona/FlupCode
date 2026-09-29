/**
 * The two total classifiers that turn what `harness-server` sees into context items (FH-020).
 *
 * There is one classifier per source, because the server sees two vocabularies: the parts it
 * assembles into a run prompt, and the episode it captures when a run or session closes. Both are
 * total — every input produces exactly one item — and both are content-free: the item carries an
 * opaque id, never the path, command or text. Classification is lexical and deterministic, so a
 * golden test fixes it and the ids stay stable between a plan and its application.
 *
 * The `skill` kind is declared in the model but never emitted here: it is Phase 3b/4. A future
 * classifier will emit it; until then a test asserts its absence.
 */

import type { ContextItem, ContextItemKind } from "./decision"
import { isContextItemKind } from "./decision"
import { opaqueItemID } from "./opaque-id"
import type { SessionEpisode } from "../types"

/** A part of the run prompt assembly; the runner produces it, the manager consumes it. */
export type ContextPartKind = "objective" | "handoff" | "memory" | "artifact" | "file"

export type ContextPart = {
  id: string
  kind: ContextPartKind
  /** The rendered text of the part (it never travels to Jev or the plan). */
  text?: string
  /** A `file` part of the engine (the engine reads it); not text. */
  file?: { path: string }
  createdAt?: number
}

const NOT_A_WORD = /[^\p{L}\p{N}]+/u

/**
 * The lexical tokens used to decide whether something names the objective.
 *
 * Shared with the skill baseline so there is one notion of "the same word" across the adaptive
 * layer. Kept here because classification is where lexical matching first happens.
 */
export const words = (text: string): string[] =>
  text.toLowerCase().split(NOT_A_WORD).filter((word) => word.length >= 3)

/** A rough token estimate: four characters per token, the same the decision service uses. */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)

const referencesObjective = (text: string, objective: ReadonlySet<string>): boolean =>
  words(text).some((word) => objective.has(word))

/**
 * The classifier is total: a kind outside the vocabulary becomes the protected `other` rather than
 * an invented item. Today the typed parts cannot produce one; the guard is what keeps it total when
 * a future source does.
 */
export const contextItemKindOf = (kind: unknown): ContextItemKind => (isContextItemKind(kind) ? kind : "other")

/** The run prompt's parts, in order; the objective is protected and names itself. */
export function classifyRunPrompt(input: { parts: readonly ContextPart[]; objective: string }): ContextItem[] {
  const objective = new Set(words(input.objective))
  return input.parts.map((part) => {
    const text = part.file?.path ?? part.text ?? ""
    return {
      id: part.id,
      kind: contextItemKindOf(part.kind),
      tokens: estimateTokens(text),
      referenced:
        part.kind === "objective" ? true : text.length > 0 && referencesObjective(text, objective),
      anchors: part.kind === "file" ? 1 : 0,
      archived: false,
      ...(part.createdAt !== undefined ? { createdAt: part.createdAt } : {}),
    }
  })
}

/**
 * The items an episode names from what it already carries.
 *
 * This is the same vocabulary the Phase 2 shadow derived inline: `files`→`file`, `commands`→
 * `command`, `failures`→`error`, all by the one opaque formula, so a re-capture converges and the
 * episode's own `id` is the classifier's scope (it is not part of the opaque id).
 */
export function classifyEpisode(input: { episode: SessionEpisode; key: Buffer }): ContextItem[] {
  const { episode, key } = input
  const objective = new Set(words(episode.objective))
  const item = (kind: ContextItemKind, discriminant: "file" | "command" | "failure", value: string): ContextItem => ({
    id: opaqueItemID(discriminant, value, key),
    kind,
    tokens: estimateTokens(value),
    referenced: referencesObjective(value, objective),
    anchors: 1,
    archived: false,
  })
  return [
    ...episode.files.map((path) => item("file", "file", path)),
    ...episode.commands.map((command) => item("command", "command", command)),
    ...episode.failures.map((failure) => item("error", "failure", failure.summary)),
  ]
}
