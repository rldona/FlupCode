import type { AdaptiveConfig } from "./adaptive/config"
import type { DecisionResult } from "./adaptive/decision"
import type { DecisionService } from "./adaptive/decision-service"
import { VERDICTS, type RunVerdict, type Task, type TaskVerdict } from "./types"

/**
 * The verdict on a task (RP-06): whether it met its goal, judged by something other than the agent.
 *
 * A quiet session with a clean last step only says the turn ended. The deterministic rule reads the
 * final answer for the few things it can tell for certain — nothing was said, the agent said it gave
 * up, the agent ended asking the person — and otherwise says `unverified`: it cannot tell a finished
 * job from a partial one, and saying `verified` would be claiming a check nobody ran (P4). A check
 * that ran (a verify task) is what makes a task `verified`; an auditor model, when one is configured,
 * can only lower a verdict, never raise it.
 */
export function answerVerdict(answer: string | undefined): TaskVerdict {
  const text = answer?.trim() ?? ""
  if (!text) return { value: "failed", reason: "The agent's final answer is empty", source: "rule" }
  const said = sentences(text)
  const gaveUp = said.find((sentence) => GAVE_UP.some((pattern) => pattern.test(sentence)))
  if (gaveUp) return { value: "failed", reason: gaveUp, source: "rule" }
  const last = said.at(-1) ?? ""
  if (last.endsWith("?") && !OFFERS.some((pattern) => pattern.test(last)))
    return { value: "needs-user", reason: last, source: "rule" }
  return { value: "unverified", reason: "Nothing checked this answer", source: "rule" }
}

/**
 * The verdict an auditor model's answer leaves (RP-06).
 *
 * Only an answer the model actually gave counts (`source: "model"`): the completion kind's own
 * deterministic rule is about episodes and is not this verdict. A model that judges the goal not met
 * turns an `unverified` task into `failed`; it does not touch a verdict the rule already lowered,
 * whose reason is the agent's own words, and a model that judges it met leaves it `unverified`.
 */
export function auditedVerdict(verdict: TaskVerdict, audit: DecisionResult<"completion"> | undefined): TaskVerdict {
  if (!audit || audit.source !== "model" || verdict.value !== "unverified") return verdict
  if (audit.answer.verdict === "complete") return verdict
  return { value: "failed", reason: `The auditor model (${audit.provider}) judged the goal not met`, source: "model" }
}

/**
 * A run's verdict: its worst task's (RP-06).
 *
 * A task some later attempt retries no longer speaks for the run — the attempt after it does — so a
 * failed first try that a retry fixed does not fail the run. Tasks with no verdict (stopped, skipped,
 * external and action tasks) are not counted.
 */
export function runVerdict(tasks: ReadonlyArray<Pick<Task, "id" | "retryOf" | "verdict">>): RunVerdict | undefined {
  const retried = new Set(tasks.flatMap((task) => (task.retryOf ? [task.retryOf] : [])))
  return tasks
    .filter((task) => task.verdict && !retried.has(task.id))
    .map((task) => ({ ...task.verdict!, taskID: task.id }))
    .reduce<RunVerdict | undefined>(
      (worst, verdict) => (!worst || VERDICTS.indexOf(verdict.value) > VERDICTS.indexOf(worst.value) ? verdict : worst),
      undefined,
    )
}

/** What the runner asks an auditor model about a finished task (RP-06). */
export type AuditInput = {
  runID: string
  taskID: string
  objective: string
  answer: string
  projectID?: string
}

export type Auditor = (input: AuditInput) => Promise<DecisionResult<"completion">>

/**
 * The auditor: the `completion` decision, asked of whatever model the adaptive layer assigns it.
 *
 * Through the decision service, so the model, its consent, its budget and its audit row are the ones
 * every other decision uses; with no model assigned the service answers with its rule and the
 * verdict stays the deterministic one. It is an acting decision (the verdict is stored), so it is not
 * marked as shadow.
 */
export function createAuditor(service: DecisionService, config: () => AdaptiveConfig): Auditor {
  return (input) =>
    service.predict(
      {
        kind: "completion",
        policy: config().decisions.completion,
        scopeID: `${input.runID}:${input.taskID}`,
        ...(input.projectID ? { projectID: input.projectID } : {}),
        state: {
          episodeID: `${input.runID}:${input.taskID}`,
          objective: input.objective,
          answer: input.answer,
          // The turn ended cleanly, or the task would not be judged; nothing checked it yet.
          outcome: "success",
          toolCalls: 0,
          verifications: [],
          failures: 0,
          projectID: input.projectID ?? "",
        },
      },
      "batch",
      false,
    )
}

/**
 * The sentences of an answer: by line, then by sentence end. Good enough to quote one back; it is not
 * a parser of prose.
 */
const sentences = (text: string) =>
  text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=\S)/))
    .map((sentence) => sentence.replace(/^[\s>*#-]+/, "").trim())
    .filter(Boolean)

/**
 * An agent saying it gave up, in English and Spanish. Small and explicit on purpose: each phrase is
 * one an agent uses to stop, not to report ("I can't find any issue" is a finding, not a refusal),
 * and a false `failed` costs more trust than a missed one, which the auditor model can still catch.
 */
const GAVE_UP = [
  /\bI(?: cannot| can't| can not|'m unable to| am unable to| was unable to| wasn't able to| was not able to) (?:do|complete|finish|continue|proceed)\b/i,
  /\bI(?:'ll| will)? stop here\b/i,
  /\bstopping here\b/i,
  /\bI give up\b/i,
  /\bno (?:puedo|he podido|pude) (?:hacer|completar|terminar|continuar|seguir)/i,
  /\bme (?:detengo|paro) aquí/i,
  /\blo dejo aquí/i,
  /\bme rindo\b/i,
]

/**
 * A closing offer is not a question the work waits on: "Would you like me to add tests?" ends a
 * finished answer as often as not.
 */
const OFFERS = [
  /^(?:would you like|do you want|want me to|shall I also|should I also|let me know)/i,
  /^¿?(?:quieres que|te gustaría|deseas que)/i,
]
