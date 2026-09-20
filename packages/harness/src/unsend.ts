/**
 * Whether a sent prompt can be taken back (UN-1).
 *
 * Recoverable while the turn did nothing irreversible: the message is the session's last user
 * message, everything after it is this turn's own assistant output, and none of that output ran
 * a tool. Text or reasoning streaming alone does not disable it; the first tool call does.
 * Recovering deletes the prompt and the partial turn behind it, in reverse order. Pure over
 * message order and part types, so the rule can be tested without a server.
 */

export type UnsendMessage =
  | { type: "user"; id: string; text?: string }
  | { type: "assistant"; id: string; content?: Array<{ type: string }> }
  | { type: string; id: string }

export type RecoverPlan = {
  /** The prompt text, back to the composer first so it can never be lost. */
  text: string
  /** The prompt plus its partial turn, newest first for deletion. */
  deleteIDs: string[]
}

/** The recovery plan, or `undefined` when the message is already beyond recovering. */
export function recoverablePrompt(messages: UnsendMessage[] | undefined, userID: string): RecoverPlan | undefined {
  if (!messages || messages.length === 0) return undefined
  const index = messages.findIndex((message) => message.id === userID)
  if (index === -1) return undefined
  const message = messages[index]!
  if (message.type !== "user") return undefined
  const after = messages.slice(index + 1)
  // Only this turn's own assistant output may follow: another user message means a newer prompt
  // owns recovery, and anything else (compaction markers, system) is not ours to delete.
  if (after.some((entry) => entry.type !== "assistant")) return undefined
  // A tool already did something the composer cannot take back.
  if (
    after.some((entry) =>
      (entry as { content?: Array<{ type: string }> }).content?.some((part) => part.type === "tool"),
    )
  )
    return undefined
  const text = (message as { text?: string }).text?.trim()
  if (!text) return undefined
  return { text, deleteIDs: [userID, ...after.map((entry) => entry.id).reverse()] }
}
