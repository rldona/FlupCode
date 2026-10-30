import type { SessionMessageInfo } from "./engine-types"

/**
 * The task list a session wrote, read from its transcript.
 *
 * OpenCode 2 has no todo tool of its own (ADR-0026), so this is not the engine's store: it is the
 * last list the model wrote with a `todowrite`/`todo` call, which imported 1.x history and plugin
 * tools still produce. Nothing written means no tasks, which is what the panel reads to decide
 * whether it has a section to draw.
 */
export type SessionTask = { content: string; status: string }

export function sessionTasks(messages: SessionMessageInfo[] | undefined): SessionTask[] {
  const list = messages ?? []
  for (const message of [...list].reverse()) {
    if (message.type !== "assistant") continue
    const parts = [...message.content].reverse()
    for (const part of parts) {
      if (part.type !== "tool" || (part.name !== "todowrite" && part.name !== "todo")) continue
      const raw = (part.state.input as { todos?: unknown }).todos
      if (!Array.isArray(raw)) continue
      return raw.flatMap((item) => {
        if (!item || typeof item !== "object") return []
        const content = (item as { content?: unknown }).content
        const status = (item as { status?: unknown }).status
        if (typeof content !== "string" || !content.trim()) return []
        return [{ content, status: typeof status === "string" ? status : "pending" }]
      })
    }
  }
  return []
}
