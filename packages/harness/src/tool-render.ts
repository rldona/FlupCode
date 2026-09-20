/**
 * Reading a tool call's own data, for the per-tool renderers (H-06).
 *
 * Pure helpers, kept out of `SessionView.tsx` so they can be tested without mounting a component
 * (that file pulls the markdown worker, which a unit test cannot import).
 */

export type Todo = { content: string; status: string }

/** The todo list a `todowrite` call wrote, read from its own input. Order and statuses are kept. */
export function parseTodos(input: Record<string, unknown>): Todo[] {
  const raw = input.todos
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const content = (item as { content?: unknown }).content
    if (typeof content !== "string") return []
    const status = (item as { status?: unknown }).status
    return [{ content, status: typeof status === "string" ? status : "pending" }]
  })
}

/**
 * The child session a `task` tool ran in.
 *
 * The engine writes it into the tool's own output as `<task id="…">`, and the transcript keeps that
 * output, so it can be read back without the engine's metadata (which the transcript drops).
 */
export function taskSessionID(output: string | undefined): string | undefined {
  return output?.match(/<task\s+id="([^"]+)"/)?.[1]
}

/** Non-empty lines of an output, for the tools whose result is a list of paths or hits. */
export function outputLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}
