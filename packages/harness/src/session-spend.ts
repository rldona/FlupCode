import { createHarnessClient } from "./client"
import type { SessionMessageInfo } from "./engine-types"
import { createResource } from "./resource"

/**
 * What a session spent, from the usage ledger (UL-06): the session with its subagents, its cost by
 * agent, and the turn in progress (`since`, from the turn's prompt). Read for the composer's meter.
 *
 * It refetches when a step finishes — the count of steps that reported tokens changes — rather than
 * on a clock: the ledger only grows when the engine ends a step. The step's row can land a moment
 * after the step (the plugin posts it, or the reconciler reads it once the session is idle), so the
 * meter also asks again whenever it is opened (`refresh`). A failed read keeps the last answer
 * and says so through `failure`, like every other harness read; an answer about another session is
 * never handed out, so switching sessions shows a dash until the new one is read.
 */
export function createSessionSpend(
  input: () => { serverUrl: string; sessionID: string; messages: SessionMessageInfo[] } | undefined,
) {
  const [report, { refetch }] = createResource(
    () => {
      const current = input()
      if (!current) return undefined
      const turn = current.messages.findLast((message) => message.type === "user") as
        | { time?: { created?: number } }
        | undefined
      const steps = current.messages.filter(
        (message) => message.type === "assistant" && (message as { tokens?: unknown }).tokens,
      ).length
      // The step count is not read by the fetcher: it only makes a finished step a new key.
      return [current.serverUrl, current.sessionID, turn?.time?.created ?? "", steps].join("\n")
    },
    (key) => {
      const [serverUrl = "", sessionID = "", from = ""] = key.split("\n")
      return createHarnessClient(serverUrl).sessionUsage(sessionID, from ? { from: Number(from) } : {})
    },
  )
  return {
    report: () => {
      const current = report()
      return current && current.sessionID === input()?.sessionID ? current : undefined
    },
    failure: () => report.failure(),
    refresh: () => void refetch(),
  }
}
