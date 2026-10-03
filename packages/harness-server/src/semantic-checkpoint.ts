/**
 * A checkpoint as a point in the work, not only in the folder (CL-3).
 *
 * H-15's checkpoint keeps the files. The engine keeps the conversation and can take it back with
 * `session.revert`. Until this, the two were unrelated: restoring the files left the conversation in
 * the future, still talking about work the folder no longer had. A checkpoint now also names the
 * session that did the work and its newest message then, what had been decided by that point (a
 * version of the run's summary document) and, read from the ledger, what the work had cost.
 *
 * Restoring takes both halves back in one operation, and never leaves one done without the other.
 * The engine's revert is staged first, because a staged revert can be cleared; then the files are
 * written; then the revert is committed. A failure at any step clears the revert and puts the files
 * back from the point taken just before, so the reader finds things as they were, told why.
 */

import { NO_TOOLS, type Engine } from "./engine"
import type { Model } from "./policy"
import { apply, drop, planRestore, take, type Checkpoint, type RestorePlan } from "./checkpoint"
import { changedBetween } from "./touched"
import { bucketOf } from "./usage"
import type { SqliteRoutineRepository } from "./repository"
import type { Task } from "./types"

/** What restoring a checkpoint would do to the files and to the conversation, before it does it. */
export type CheckpointPlan = {
  files: RestorePlan
  conversation: ConversationPlan
}

/**
 * The conversation's half: `none` for a point that names no session (taken by hand from a folder, or
 * before CL-3), `gone` for one whose session or message the engine no longer has, `kept` otherwise,
 * with the prompts made since that a restore would drop.
 */
export type ConversationPlan =
  | { state: "none" }
  | { state: "gone"; sessionID: string }
  | { state: "kept"; sessionID: string; prompts: number; revertTo?: string }

/** The slice of `Engine` a checkpoint's conversation needs; the real `Engine` satisfies it. */
export type CheckpointEngine = Pick<
  Engine,
  "conversationSince" | "stageRevert" | "clearRevert" | "commitRevert" | "newestMessage"
>

/** A restore that did not happen, and whether putting things back worked. Always a 409. */
export class RestoreError extends Error {
  readonly status = 409
}

export async function planCheckpoint(engine: CheckpointEngine, checkpoint: Checkpoint): Promise<CheckpointPlan> {
  const [files, conversation] = await Promise.all([
    planRestore(checkpoint.directory, checkpoint.sha),
    conversationPlan(engine, checkpoint),
  ])
  return { files, conversation }
}

/**
 * Takes the folder and the conversation back to a checkpoint, both or neither.
 *
 * The point of the present is taken first, as any restore's is, and is handed back to be recorded;
 * when the restore fails it is used to put the files back and then forgotten, since it holds nothing
 * the folder does not. A committed revert cannot be undone by the engine, so that point brings the
 * files back, not the conversation; the plan says so before anything happens.
 */
export async function restoreCheckpoint(input: {
  engine: CheckpointEngine
  checkpoint: Checkpoint
  safetyTitle: string
}): Promise<{ plan: CheckpointPlan; safety: Checkpoint }> {
  const checkpoint = input.checkpoint
  const plan = await planCheckpoint(input.engine, checkpoint)
  const revert =
    plan.conversation.state === "kept" && plan.conversation.revertTo
      ? { sessionID: plan.conversation.sessionID, messageID: plan.conversation.revertTo }
      : undefined
  const safety = await take({ directory: checkpoint.directory, title: input.safetyTitle })
  const fail = async (what: string, cause: unknown, staged: boolean) => {
    const problems = await putBack(input.engine, safety, staged ? revert?.sessionID : undefined)
    if (problems.length === 0) await drop(safety.directory, safety.id)
    throw new RestoreError(
      problems.length === 0
        ? `${what}: ${message(cause)}. Nothing was changed.`
        : `${what}: ${message(cause)}. Putting things back also failed (${problems.join("; ")}); the folder as it was is checkpoint "${safety.title}".`,
    )
  }
  if (revert)
    await input.engine.stageRevert(revert.sessionID, revert.messageID).catch((cause) =>
      fail("The conversation could not be taken back", cause, false),
    )
  // Worked out again after the stage: the engine's revert puts back the files its session changed,
  // and the checkpoint is what the folder must end up as, whatever that left.
  await planRestore(checkpoint.directory, checkpoint.sha)
    .then((files) => apply(checkpoint.directory, checkpoint.sha, files))
    .catch((cause) => fail("The files could not be restored", cause, !!revert))
  if (revert)
    await input.engine
      .commitRevert(revert.sessionID)
      .catch((cause) => fail("The conversation could not be taken back", cause, true))
  return { plan, safety }
}

/** What a failed restore could not put back, in words; empty when everything is as it was. */
async function putBack(engine: CheckpointEngine, safety: Checkpoint, staged?: string) {
  const cleared = staged
    ? await engine.clearRevert(staged).then(
        () => undefined,
        (cause: unknown) => `the conversation: ${message(cause)}`,
      )
    : undefined
  const files = await planRestore(safety.directory, safety.sha)
    .then((plan) => apply(safety.directory, safety.sha, plan))
    .then(
      () => undefined,
      (cause: unknown) => `the files: ${message(cause)}`,
    )
  return [cleared, files].filter((problem): problem is string => !!problem)
}

async function conversationPlan(engine: CheckpointEngine, checkpoint: Checkpoint): Promise<ConversationPlan> {
  if (!checkpoint.sessionID || !checkpoint.messageID) return { state: "none" }
  const since = await engine.conversationSince(checkpoint.sessionID, checkpoint.messageID)
  if (since.state === "gone") return { state: "gone", sessionID: checkpoint.sessionID }
  return { sessionID: checkpoint.sessionID, ...since }
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/**
 * A checkpoint as the app reads it (CL-3): the row, what had been decided by then and who wrote that
 * down, and what the work had cost by then according to the ledger.
 *
 * The cost is read at the time of asking, not stored: the ledger is filled as the engine reports
 * steps, and a figure frozen when the point was taken could miss a step reported a moment later.
 */
export function describeCheckpoints(repository: SqliteRoutineRepository, checkpoints: Checkpoint[]) {
  return checkpoints.map((checkpoint) => {
    const summary = checkpoint.summaryArtifactID ? repository.getArtifact(checkpoint.summaryArtifactID) : undefined
    const scope = checkpoint.runID
      ? { runID: checkpoint.runID }
      : checkpoint.sessionID
        ? { sessionIDs: repository.usageSessionTree(checkpoint.sessionID).map((member) => member.sessionID) }
        : undefined
    return {
      ...checkpoint,
      ...(summary?.content
        ? {
            decided: {
              text: summary.content,
              // Who wrote it down: FlupCode from what it recorded, or the small model (P4).
              by: summary.producer === "harness" ? ("facts" as const) : ("model" as const),
              version: summary.version,
            },
          }
        : {}),
      ...(scope ? { cost: bucketOf(repository.usageTotals({ ...scope, to: checkpoint.createdAt + 1 })) } : {}),
    }
  })
}

/** What a summary is written from: the tasks so far and what this step changed. */
export type SummaryFacts = {
  /** The task the point is taken after. */
  after: string
  tasks: Array<Pick<Task, "name" | "status" | "verdict" | "attempt">>
  files: string[]
  /** What the step handed on, when it wrote a note: the model's starting point, not shown as fact. */
  note?: string
}

/**
 * What a run had decided by a checkpoint, from the facts FlupCode recorded: the task it follows, every
 * task's state and verdict, and the files the step changed. It needs no model, so there is always one.
 */
export function factsSummary(facts: SummaryFacts) {
  const done = facts.tasks.filter((task) => task.status === "success").length
  const files =
    facts.files.length === 0
      ? "No files changed in this step."
      : `Files changed in this step: ${facts.files.slice(0, 12).join(", ")}${facts.files.length > 12 ? ` and ${facts.files.length - 12} more` : ""}.`
  return [
    `After ${facts.after}: ${done} of ${facts.tasks.length} tasks done.`,
    ...facts.tasks.map((task) => {
      const marks = [task.status, task.verdict?.value, task.attempt > 1 ? `attempt ${task.attempt}` : undefined]
      return `- ${task.name}: ${marks.filter(Boolean).join(", ")}`
    }),
    files,
  ].join("\n")
}

/** How long the small model has to write one; past that, the facts stand. */
const SUMMARY_TIMEOUT_MS = 60_000

/**
 * The small model's summary (CL-3), only when one is configured, and the facts otherwise.
 *
 * Asked the way every helper turn of this server is: a throwaway session with no tools, prompted
 * once and deleted whatever happens. Anything short of an answer — no model, a refusal, a timeout,
 * an empty reply — is the facts, labelled as such, so a point is never without its summary.
 */
export async function writeSummary(input: {
  engine: Pick<Engine, "createSession" | "prompt" | "waitForIdle" | "lastAnswer" | "deleteSession">
  model?: Model
  facts: SummaryFacts
  directory?: string
  onSession?: (sessionID: string) => void
}): Promise<{ text: string; by: "facts" | "model" }> {
  const facts = factsSummary(input.facts)
  if (!input.model) return { text: facts, by: "facts" }
  const session = await input.engine
    .createSession({ ...(input.directory ? { directory: input.directory } : {}), title: `${input.facts.after} — checkpoint`, permission: NO_TOOLS })
    .catch(() => undefined)
  if (!session) return { text: facts, by: "facts" }
  input.onSession?.(session.id)
  try {
    await input.engine.prompt({
      sessionID: session.id,
      ...(input.directory ? { directory: input.directory } : {}),
      model: input.model,
      text: [
        "Summarise what this run has decided so far, for someone deciding whether to come back to this point.",
        "At most 8 lines, facts only, no preamble.",
        "",
        facts,
        ...(input.facts.note ? ["", "What the last step handed on:", input.facts.note] : []),
      ].join("\n"),
    })
    await input.engine.waitForIdle(session.id, { timeoutMs: SUMMARY_TIMEOUT_MS })
    const answer = await input.engine.lastAnswer(session.id)
    const text = answer?.error ? "" : (answer?.text ?? "").trim()
    return text ? { text, by: "model" } : { text: facts, by: "facts" }
  } catch {
    return { text: facts, by: "facts" }
  } finally {
    await input.engine.deleteSession(session.id).catch(() => undefined)
  }
}

/** The files a step changed: from the run's previous point in the same tree, or the commit's parent. */
export async function filesOfStep(checkpoint: Checkpoint, previous?: Checkpoint) {
  const from = previous && previous.directory === checkpoint.directory ? previous.sha : `${checkpoint.sha}^`
  return changedBetween(checkpoint.directory, from, checkpoint.sha)
    .then((files) => files.map((file) => file.path))
    .catch(() => [])
}
