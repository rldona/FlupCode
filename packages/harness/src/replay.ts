/**
 * Replaying a session's durable events (H-33).
 *
 * The engine keeps every public session event with a sequence number, so a reader can ask for what
 * comes after the last one seen: a replay is a replay, not the current state read again. This module
 * is the part that does not need a browser — naming each event and counting them — so the screen only
 * has to paint.
 */

/** What the helpers below need; the engine's own union is wider and fits this structurally. */
export type ReplayEvent = {
  type?: string
  durable?: { seq?: number }
  data?: Record<string, unknown>
}

const LABELS: Record<string, string> = {
  "session.next.prompted": "Prompt sent",
  "session.next.prompt.admitted": "Prompt admitted",
  "session.next.step.started": "Step started",
  "session.next.step.ended": "Step ended",
  "session.next.step.failed": "Step failed",
  "session.next.text.started": "Writing",
  "session.next.text.delta": "Text",
  "session.next.text.ended": "Wrote",
  "session.next.reasoning.started": "Thinking",
  "session.next.reasoning.delta": "Thought",
  "session.next.reasoning.ended": "Thought",
  "session.next.tool.input.started": "Tool input",
  "session.next.tool.input.delta": "Tool input",
  "session.next.tool.input.ended": "Tool input ready",
  "session.next.tool.called": "Called a tool",
  "session.next.tool.progress": "Tool running",
  "session.next.tool.success": "Tool returned",
  "session.next.tool.failed": "Tool failed",
  "session.next.agent.switched": "Agent switched",
  "session.next.model.switched": "Model switched",
  "session.next.context.updated": "Context updated",
  "session.next.shell.started": "Shell started",
  "session.next.shell.ended": "Shell ended",
  "session.next.compaction.started": "Compaction started",
  "session.next.compaction.delta": "Compaction",
  "session.next.compaction.ended": "Compaction ended",
  "session.next.retried": "Retried",
  "session.next.moved": "Session moved",
  "session.next.revert.staged": "Revert staged",
  "session.next.revert.cleared": "Revert cleared",
  "session.next.revert.committed": "Revert committed",
  "session.next.synthetic": "Synthetic",
}

const firstString = (...values: unknown[]) => {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim()
  return undefined
}

export function replaySeq(event: ReplayEvent): number | undefined {
  const seq = event?.durable?.seq
  return typeof seq === "number" ? seq : undefined
}

export function replayTime(event: ReplayEvent): number | undefined {
  const time = event?.data?.timestamp
  return typeof time === "number" ? time : undefined
}

/** A short label for the event, and whatever names it: a tool, a model, a command, a path. */
export function describeReplayEvent(event: ReplayEvent): { label: string; detail?: string } {
  const type = typeof event?.type === "string" ? event.type : ""
  const data = event?.data ?? {}
  const label = LABELS[type] ?? "Event"
  const detail = firstString(
    data.tool,
    data.name,
    data.callID,
    data.command,
    data.path,
    data.modelID,
    data.agent,
    data.reason,
  )
  return detail ? { label, detail: detail.slice(0, 120) } : { label }
}

/** How many of each kind of event there were, most frequent first. */
export function replayCounts(events: ReplayEvent[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const event of events) {
    const { label } = describeReplayEvent(event)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label))
}
