/**
 * The task list of a session, as its plugin tool writes it.
 *
 * OpenCode 2 has no todo tool of its own (ADR-0026), so FlupCode's plugin is the writer: it replaces
 * the whole list for a session, last write wins, and the app reads it back for the details panel.
 * The store is in memory because it mirrors the turn that wrote it: the transcript keeps the history,
 * and a fresh harness re-reads it from there.
 */
export type SessionTask = { content: string; status: string }

const MAX_TASKS = 200
const MAX_CONTENT = 500

export function createSessionTaskStore() {
  const bySession = new Map<string, SessionTask[]>()

  return {
    write(sessionID: string, tasks: unknown) {
      const list = sessionTasksFrom(tasks)
      if (list) bySession.set(sessionID, list)
      return list
    },
    read(sessionID: string) {
      return bySession.get(sessionID) ?? []
    },
    forget(sessionID: string) {
      bySession.delete(sessionID)
    },
  }
}

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

export type SessionTaskStore = ReturnType<typeof createSessionTaskStore>
