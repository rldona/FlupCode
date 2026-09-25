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

export type ActionSummary = {
  action: string
  origin: string
  url?: string
  title?: string
  extracted: Array<{ field: string; value: string }>
  steps: Array<{ index: number; kind: string; status: string }>
  evidence: string[]
  /** Lines the summary carried but the parser does not know, kept so the renderer can still show them. */
  extra: string[]
}

const ACTION_HEADER = /^Acción "(.+)" completada\.$/
const ACTION_ORIGIN = /^Origen: (https?:\/\/.+)$/
const ACTION_URL = /^URL: (.+)$/
const ACTION_TITLE = /^Título: (.+)$/
const ACTION_EXTRACTED = /^Extraído (.+?): (.+)$/
const ACTION_STEP = /^- #(\d+) (.+?): (.+)$/
const ACTION_EVIDENCE = /^Evidencia: (.+)$/

/**
 * The URL of a web action's summary, only when it is safe to render as a link.
 *
 * The summary carries values read from the page, so a `URL:` line can name any scheme, `javascript:`
 * included. Only an absolute http(s) URL becomes an anchor; anything else is shown as plain text.
 */
export function actionLink(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined
  const protocol = new URL(url).protocol
  return protocol === "http:" || protocol === "https:" ? url : undefined
}

/**
 * The summary the web-action plugin writes as its tool output, read back into its fields.
 *
 * The first line names the action and an `Origen:` line with a real URL is required, so a plain text
 * output or a failure sentence ("No se pudo contactar…", "La acción fue denegada…") is never mistaken
 * for an action. Unknown lines are kept in `extra` so the renderer can still show them after the
 * plugin adds a line. The first `URL:` wins: a later one cannot replace it.
 */
export function parseActionSummary(output: string): ActionSummary | undefined {
  // The header is validated on its own line first, without splitting the whole output, so a plain
  // text or failure sentence is rejected before any parsing work.
  const breakIndex = output.indexOf("\n")
  const firstLine = (breakIndex === -1 ? output : output.slice(0, breakIndex)).trim()
  const action = firstLine.match(ACTION_HEADER)?.[1]
  if (action === undefined) return undefined
  const lines = breakIndex === -1 ? [] : output.slice(breakIndex + 1).split("\n").map((line) => line.trim())
  const origin = lines.map((line) => line.match(ACTION_ORIGIN)?.[1]).find((value) => value !== undefined)
  if (origin === undefined) return undefined

  const summary: ActionSummary = { action, origin, extracted: [], steps: [], evidence: [], extra: [] }
  let inSteps = false
  for (const line of lines) {
    if (line === "") continue
    if (line === "Pasos:") {
      inSteps = true
      continue
    }
    const step = inSteps ? line.match(ACTION_STEP) : undefined
    if (step) {
      summary.steps.push({ index: Number(step[1]), kind: step[2]!, status: step[3]! })
      continue
    }
    const url = line.match(ACTION_URL)?.[1]
    if (url !== undefined) {
      inSteps = false
      if (summary.url === undefined) summary.url = url
      continue
    }
    const title = line.match(ACTION_TITLE)?.[1]
    if (title !== undefined) {
      inSteps = false
      summary.title = title
      continue
    }
    const extracted = line.match(ACTION_EXTRACTED)
    if (extracted) {
      inSteps = false
      summary.extracted.push({ field: extracted[1]!, value: extracted[2]! })
      continue
    }
    const evidence = line.match(ACTION_EVIDENCE)?.[1]
    if (evidence !== undefined) {
      inSteps = false
      summary.evidence = evidence.split(", ")
      continue
    }
    if (ACTION_ORIGIN.test(line)) {
      inSteps = false
      continue
    }
    summary.extra.push(line)
  }
  return summary
}
