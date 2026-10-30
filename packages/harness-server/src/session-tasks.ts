/**
 * The task list of a session, as its plugin tool writes it.
 *
 * OpenCode 2 has no todo tool of its own (ADR-0026), so FlupCode's plugin is the writer and the
 * harness keeps the list: this is what turns a written body into the rows the repository stores.
 */
export type SessionTask = { content: string; status: string }

const MAX_TASKS = 200
const MAX_CONTENT = 500

/**
 * A written list, or undefined when the body is not one. Items without content are dropped: a model
 * that sends half an item should lose that item, never the list it was working through.
 */
export function sessionTasksFrom(value: unknown): SessionTask[] | undefined {
  if (!Array.isArray(value)) return undefined
  const list = value
    .flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const content = (item as { content?: unknown }).content
      const status = (item as { status?: unknown }).status
      if (typeof content !== "string" || !content.trim()) return []
      return [
        { content: content.trim().slice(0, MAX_CONTENT), status: typeof status === "string" ? status : "pending" },
      ]
    })
    .slice(0, MAX_TASKS)
  return list
}
