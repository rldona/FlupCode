import { formatDateTime } from "./dates"

/**
 * The engine names a session itself, with its `title` agent, on the first turn — but only while the
 * title is still the placeholder it created the session with. The harness used to rename every new
 * session to the first line of the prompt, which looked fine and permanently stopped the engine from
 * ever naming anything. It no longer does, so a session carries the engine's placeholder for the
 * second or two the title agent takes.
 *
 * The placeholder carries the moment the session started, so it is shown as a readable stamp rather
 * than the raw ISO string the engine writes: `New session · Lun 28 sept 13:03`.
 */
// Mirrors `isDefaultTitle` in packages/opencode/src/session/session.ts.
const DEFAULT_TITLE = /^(New session|Child session) - (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/

export function isPlaceholderTitle(title: string | undefined) {
  return !title || DEFAULT_TITLE.test(title)
}

/** The session's name: the engine's own, or its placeholder as `New session · <date>`. Nothing at all
    when there is no title yet. */
export function sessionTitle(session: { title?: string } | undefined) {
  const title = session?.title
  if (!title) return ""
  const placeholder = DEFAULT_TITLE.exec(title)
  if (!placeholder) return title
  return `${placeholder[1]} · ${formatDateTime(new Date(placeholder[2]!).getTime())}`
}
