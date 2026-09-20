/**
 * The steps a plan is made of (H-28).
 *
 * `foreach` means "one task per element of the plan", and that only works if an element is something
 * the harness can read. A plan is prose plus lists, and guessing which bullet is a step — across
 * nesting, numbering and checkboxes — would be inventing structure the model did not promise. So the
 * plan ends with a fenced `json` block, the same shape a review uses for findings (H-32), and the
 * parser is forgiving about what each entry looks like: a string, or an object naming it `title`,
 * `task`, `step`, `item` or `summary`.
 */

export type PlanItem = {
  /** What the task is given, interpolated in place of `{{item}}`. */
  text: string
}

const TEXT_KEYS = ["title", "task", "step", "item", "summary", "prompt", "what"]

const asArray = (value: unknown) => {
  if (Array.isArray(value)) return value
  if (value && typeof value === "object") {
    const holder = value as Record<string, unknown>
    for (const key of ["items", "tasks", "steps", "plan"]) {
      if (Array.isArray(holder[key])) return holder[key] as unknown[]
    }
  }
  return undefined
}

/** Every fenced block, newest last, plus the whole text when it is itself the array. */
function candidates(text: string) {
  const blocks: string[] = []
  const fence = /```(?:json|jsonc)?\s*\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) if (match[1]) blocks.push(match[1])
  const trimmed = text.trim()
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) blocks.push(trimmed)
  return blocks.reverse()
}

/**
 * Reads the steps out of what the planning task answered.
 *
 * Nothing to read is not a failure: it means the task was not planning, and this costs a regular
 * expression. A block that parses but names nothing usable is not the plan, so the search continues.
 */
export function parsePlan(text: string | undefined): string[] {
  if (!text) return []
  for (const block of candidates(text)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block)
    } catch {
      continue
    }
    const entries = asArray(parsed)
    if (!entries) continue
    const items = entries.flatMap((entry): string[] => {
      if (typeof entry === "string") return entry.trim() ? [entry.trim()] : []
      if (!entry || typeof entry !== "object") return []
      const value = entry as Record<string, unknown>
      for (const key of TEXT_KEYS) {
        const text = value[key]
        if (typeof text === "string" && text.trim()) return [text.trim()]
      }
      return []
    })
    if (items.length > 0) return items
  }
  return []
}

/** What a planning task is told to end with, so a `foreach` over it has something to read. */
export const PLAN_INSTRUCTION = `End your answer with a fenced json block: an array of the steps, each
a short string. One entry is one unit of work, because each is handed to a task of its own. Keep them
independent and in the order they should be done.`
