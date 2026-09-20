/**
 * YAML frontmatter, read and written.
 *
 * Shared by the agent editor (H-13) and the skill catalogue (H-27), because the engine reads both
 * kinds of file the same way: `---`, settings, `---`, and the body is what the model is told.
 *
 * Writing is done by hand in block style rather than with `Bun.YAML.stringify`, which writes flow
 * style — `{mode: primary,tools: {...}}`. It parses, and it makes a file worse to open, and these
 * are files meant to be opened.
 */

export type Frontmatter = { fields: Record<string, unknown>; prompt: string; problem?: string }

/**
 * Splits a file into its settings and its body.
 *
 * Deliberately tolerant: a file with no frontmatter is all body. A frontmatter that does not parse
 * is **reported** rather than thrown away, so an editor can refuse to overwrite a file it did not
 * understand instead of flattening it.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { fields: {}, prompt: text.trim() }
  const body = text.slice(match[0].length)
  let parsed: unknown
  try {
    parsed = Bun.YAML.parse(match[1]!)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause)
    return { fields: {}, prompt: body.trim(), problem: `Its frontmatter could not be read: ${detail}` }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { fields: {}, prompt: body.trim(), problem: "Its frontmatter is not a list of settings" }
  }
  return { fields: parsed as Record<string, unknown>, prompt: body.trim() }
}

/**
 * Which values have to be quoted.
 *
 * Checked against what actually breaks rather than against a rule of thumb: `color: #44BA81` reads
 * as null because `#` opens a comment, `variant: 2.0` reads as the number 2 and then fails a schema
 * that wants a string, and a value with `: ` in it ends the scalar and turns the rest into a key.
 */
const needsQuotes = (value: string) =>
  value === "" ||
  /^[-?:,[\]{}#&*!|>'"%@`]/.test(value) ||
  /[:#]\s/.test(value) ||
  /:\s*$/.test(value) ||
  value !== value.trim() ||
  ["true", "false", "null", "yes", "no", "on", "off", "~"].includes(value.toLowerCase()) ||
  /^[\d.+-]+$/.test(value)

const scalar = (value: unknown): string => {
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  if (value === null) return "null"
  const text = String(value)
  return needsQuotes(text) ? JSON.stringify(text) : text
}

/** Frontmatter a person can still read: scalars, and one level of map or list. */
export function serialiseFrontmatter(draft: { fields: Record<string, unknown>; prompt: string }) {
  const lines: string[] = []
  for (const [key, value] of Object.entries(draft.fields)) {
    if (value === undefined) continue
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries = Object.entries(value as Record<string, unknown>)
      if (entries.length === 0) continue
      lines.push(`${key}:`)
      for (const [inner, own] of entries) lines.push(`  ${scalar(inner)}: ${scalar(own)}`)
      continue
    }
    if (Array.isArray(value)) {
      if (value.length === 0) continue
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${scalar(item)}`)
      continue
    }
    lines.push(`${key}: ${scalar(value)}`)
  }
  const prompt = draft.prompt.trim()
  if (lines.length === 0) return prompt ? `${prompt}\n` : ""
  return `---\n${lines.join("\n")}\n---\n\n${prompt}\n`
}
