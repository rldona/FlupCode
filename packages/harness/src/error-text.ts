/** The provider's own sentence is buried in a JSON envelope; the reader only needs that sentence. */

const HTTP_PREFIX = /^Provider request failed with HTTP (\d+): ([\s\S]*)$/

export function errorDetail(message: string): string {
  const match = HTTP_PREFIX.exec(message)
  if (!match) return message
  const detail = providerDetail(match[2] ?? "")
  return detail ? `HTTP ${match[1]}: ${detail}` : `HTTP ${match[1]}`
}

function providerDetail(body: string) {
  try {
    return stringMessage(JSON.parse(body))
  } catch {
    return undefined
  }
}

// Envelopes differ per provider: `{ message }`, `{ error: { message } }`, `{ error: "..." }` or a
// nested `{ error: { error: { message } } }` from gateways such as Console Go.
function stringMessage(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (value === null || typeof value !== "object") return undefined
  if ("message" in value && typeof value.message === "string") return value.message
  if ("detail" in value && typeof value.detail === "string") return value.detail
  return "error" in value ? stringMessage(value.error) : undefined
}
