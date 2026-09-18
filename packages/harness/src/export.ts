/**
 * A session as a file (H-35).
 *
 * The old export was a dozen lines inline in the app: markdown, no options, and nothing else. This
 * is the same thing as a plain function — so the two questions a reader actually has, "with or
 * without the tool noise" and "as JSON", are answered by arguments instead of by editing the
 * reader — and it has tests, because a transcript turned into text is exactly the kind of thing
 * that silently loses a part.
 */

export type ExportPart = {
  type?: string
  text?: string
  name?: string
  state?: {
    status?: string
    content?: Array<{ type?: string; text?: string }>
    error?: { message?: string }
  }
}

export type ExportMessage = {
  type?: string
  text?: string
  files?: Array<{ uri?: string; name?: string; mime?: string }>
  content?: ExportPart[]
  summary?: string
}

export type ExportOptions = {
  /** What the model thought, as a collapsed block. */
  reasoning?: boolean
  /** The tool calls, by name. */
  tools?: boolean
  /** What the tools printed. Off by default: it is the noisy half, and rarely what is wanted. */
  toolOutput?: boolean
}

export const DEFAULT_EXPORT_OPTIONS: Required<ExportOptions> = { reasoning: true, tools: true, toolOutput: false }

const toolOutputOf = (part: ExportPart) => {
  const state = part.state
  if (!state) return ""
  if (state.status === "completed") {
    return (state.content ?? [])
      .filter((content) => content.type === "text" && content.text)
      .map((content) => content.text)
      .join("\n")
  }
  if (state.status === "error") return state.error?.message ?? "Error"
  if (state.status === "running") return "In progress"
  return "Pending"
}

const isImage = (file: { uri?: string; mime?: string }) =>
  !!file.mime?.startsWith("image/") || !!file.uri?.startsWith("data:image/")

/**
 * The transcript as markdown, with the noise the options leave out.
 *
 * Parts nobody asked for — a shell turn, an agent switch — are dropped rather than guessed at: a
 * markdown export with a line saying "model switched" is worse than one without it.
 */
export function sessionMarkdown(
  title: string,
  messages: ExportMessage[],
  options: ExportOptions = {},
  now: Date = new Date(),
): string {
  const opts = { ...DEFAULT_EXPORT_OPTIONS, ...options }
  const lines: string[] = [`# ${title}`, "", `_Exported ${now.toISOString()}_`, ""]
  for (const message of messages) {
    if (message.type === "user") {
      lines.push("## User", "", message.text ?? "", "")
      for (const file of message.files ?? []) {
        lines.push(`- ${isImage(file) ? "image" : "file"}: ${file.name ?? file.uri ?? "attachment"}`)
      }
      if ((message.files ?? []).length > 0) lines.push("")
      continue
    }
    if (message.type === "compaction") {
      lines.push("> Context compacted", message.summary ? `: ${message.summary}` : "", "")
      continue
    }
    if (message.type !== "assistant") continue
    lines.push("## Assistant", "")
    for (const part of message.content ?? []) {
      if (part.type === "text" && part.text) {
        lines.push(part.text, "")
        continue
      }
      if (part.type === "reasoning" && part.text && opts.reasoning) {
        lines.push("<details><summary>Reasoning</summary>", "", part.text, "", "</details>", "")
        continue
      }
      if (part.type === "tool" && opts.tools) {
        lines.push(`> Tool: ${part.name ?? "unknown"}`, "")
        if (opts.toolOutput) {
          const output = toolOutputOf(part).trim()
          if (output) lines.push("```", output, "```", "")
        }
      }
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`
}

/** The session and its messages, exactly as they arrived, for a reader who wants the data. */
export function sessionJson(
  title: string,
  messages: ExportMessage[],
  now: Date = new Date(),
): string {
  return JSON.stringify({ title, exportedAt: now.toISOString(), messages }, null, 2)
}

/** Saves text as a file in the browser. The desktop renderer runs the same code. */
export function downloadFile(name: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = name
  anchor.click()
  URL.revokeObjectURL(url)
}
