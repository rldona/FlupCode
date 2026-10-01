/**
 * How an OpenCode 2 execution ended, when that is worth telling the reader (V2-40). 2.x reports the
 * end of a whole execution — every step and queued prompt included — as one of three events. Success
 * says nothing the transcript does not. A failure can happen before the model answered (a model that
 * no longer resolves, a provider that refuses the key), when there is no assistant message to carry
 * the error. A stop is worth a line only when the reader did not ask for it: the engine shut down, a
 * newer execution took the session over, or the run sat idle too long.
 */
export type RunOutcome =
  | { kind: "failed"; message: string }
  | { kind: "interrupted"; reason: "shutdown" | "superseded" | "inactivity" }

export function runOutcome(
  type: string,
  data: { error?: { message?: string }; reason?: string } | undefined,
): RunOutcome | undefined {
  if (type === "session.execution.failed") return { kind: "failed", message: data?.error?.message ?? "" }
  if (type !== "session.execution.interrupted") return undefined
  const reason = data?.reason
  if (reason === "shutdown" || reason === "superseded" || reason === "inactivity")
    return { kind: "interrupted", reason }
  return undefined
}
