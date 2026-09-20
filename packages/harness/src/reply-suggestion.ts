/** Helpers for suggesting the user's next message after a turn (shown greyed in the input, Tab accepts). */

export const SUGGESTION_SYSTEM = [
  "You predict the next message a user will send to a coding assistant.",
  "Reply with only that message: one short line in the user's language, at most 15 words.",
  "No quotes, no explanations, no summaries.",
  "If the assistant asked for approval or offered options, answer with the most likely choice.",
  "If there is no clear next message, reply with exactly NONE.",
].join(" ")

const clip = (text: string, max: number) => (text.length > max ? `…${text.slice(-max)}` : text)

export function buildSuggestionPrompt(user: string, assistant: string) {
  return [
    "End of the conversation:",
    "",
    "<user>",
    clip(user.trim(), 1500),
    "</user>",
    "<assistant>",
    clip(assistant.trim(), 3000),
    "</assistant>",
    "",
    "Write the user's next message.",
  ].join("\n")
}

/** A usable suggestion, or undefined when the model had none. */
export function cleanSuggestion(raw: string | undefined) {
  const line = (raw ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find(Boolean)
  if (!line) return undefined
  const text = line
    .replace(/^(user|usuario)\s*:\s*/i, "")
    .replace(/^["'“”«»`]+|["'“”«»`]+$/g, "")
    .trim()
  if (!text || /^none\.?$/i.test(text) || text.length > 200) return undefined
  return text
}

const SMALL = /(flash|nano|mini|haiku|lite|small|fast)/i

/**
 * The model for suggestions: the configured small model, else a cheap one from the current
 * provider, else the current model only when it is itself a cheap one. Never a large model.
 */
export function pickSuggestionModel(
  configured: { providerID: string; id: string } | undefined,
  current: { providerID: string; id: string } | undefined,
  models: Array<{ providerID: string; id: string }>,
) {
  if (configured) return configured
  if (!current) return undefined
  if (SMALL.test(current.id)) return { providerID: current.providerID, id: current.id }
  const candidate = models.find((model) => model.providerID === current.providerID && SMALL.test(model.id))
  return candidate ? { providerID: candidate.providerID, id: candidate.id } : undefined
}
