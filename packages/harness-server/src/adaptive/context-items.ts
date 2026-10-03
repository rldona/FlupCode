/**
 * The context item model (FH-020): what a context item can be and which kinds a plan protects.
 *
 * A leaf module, re-exported by `decision.ts`: the scorer and the run-prompt classifier read it, and
 * the `contextItem` decision module reads them, so it must not import the decision registry back.
 */

/**
 * The closed vocabulary of things a context item can be.
 *
 * `other` catches anything outside it and is protected; `skill` is reserved for Phase 3b/4 and the
 * Phase 3a classifiers never emit it, but declaring it keeps the type ready without dead code.
 */
export const CONTEXT_ITEM_KINDS = [
  "objective", // the objective of the task/run — never dropped
  "plan", // the current plan
  "decision", // a decision and its rationale
  "handoff", // what a previous task concluded
  "file", // a file/code reference
  "command", // a command that ran
  "error", // an error / red check — never dropped
  "artifact", // an artifact quoted in the prompt
  "memory", // a project note (human data, not an instruction)
  "tool", // a tool call (scope + outcome)
  "message", // agent narration
  "history", // historical conversation
  "skill", // RESERVED to 3b/Phase 4; 3a never emits it
  "other", // unknown — never dropped
] as const
export type ContextItemKind = (typeof CONTEXT_ITEM_KINDS)[number]

/**
 * The kinds a plan never archives nor drops ("no-drop" in plan §7.2).
 *
 * `memory` is a human project note — an instruction a person wrote for every turn — so it is as
 * protected as the objective: archiving it would silently drop a directive from the prompt. The
 * `@artifact:` refs and `contextFiles` stay archivable.
 */
export const PROTECTED_CONTEXT_KINDS: readonly ContextItemKind[] = ["objective", "error", "other", "memory"]
/**
 * The only kinds `drop` may touch; everything else is archived, which is recoverable. A pack's
 * `artifact` and `file` parts are deliberately **not** here: even with `context.apply=true` they can
 * only be archived (recoverable), never dropped, so a reference a person added to a pack is never
 * lost silently. The scorer and the model merge both enforce this, and the manager re-checks it.
 */
export const DROPPABLE_CONTEXT_KINDS: readonly ContextItemKind[] = ["tool", "message", "history"]

export const isContextItemKind = (value: unknown): value is ContextItemKind =>
  typeof value === "string" && (CONTEXT_ITEM_KINDS as readonly string[]).includes(value)

/**
 * The item observed: a descriptor, never content. The text lives in its durable source (a pack, an
 * artifact, a handoff or `evidence`). `importance`/`novelty`/`state`/`reason` are results, not
 * observations, and live on the plan entry instead.
 */
export type ContextItem = {
  id: string
  kind: ContextItemKind
  tokens: number
  /** Names something in the current objective (lexical). */
  referenced: boolean
  /** How many paths/commands/errors it carries; the scorer caps it. */
  anchors: number
  /** Archived by an earlier plan; a referenced archived item can recover. */
  archived: boolean
  createdAt?: number
}
