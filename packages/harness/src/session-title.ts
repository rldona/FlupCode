/**
 * The engine names a session itself, with its `title` agent, on the first turn — but only while the
 * title is still the placeholder it created the session with. The harness used to rename every new
 * session to the first line of the prompt, which looked fine and permanently stopped the engine from
 * ever naming anything. It no longer does, so a session carries the engine's placeholder for the
 * second or two the title agent takes, and that placeholder is not something to show anybody.
 */
// Mirrors `isDefaultTitle` in packages/opencode/src/session/session.ts.
const DEFAULT_TITLE = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function isPlaceholderTitle(title: string | undefined) {
  return !title || DEFAULT_TITLE.test(title)
}

/** The session's name, or nothing while the engine is still deciding on one. */
export function sessionTitle(session: { title?: string } | undefined) {
  return isPlaceholderTitle(session?.title) ? "" : (session?.title ?? "")
}
