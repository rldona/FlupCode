/**
 * Session tabs (H-36).
 *
 * Which sessions are open in the window, in the order they were opened. The selected session is the
 * active tab — that is already the app's idea of "what is open" — so this only has to remember the
 * strip and answer what to do when one is closed or cycled. Kept out of the component so the rules
 * are testable.
 */

/** A session that is already open stays where it is; a new one goes on the end. */
export function openTab(tabs: string[], id: string): string[] {
  return tabs.includes(id) ? tabs : [...tabs, id]
}

export function closeTab(tabs: string[], id: string): string[] {
  return tabs.filter((tab) => tab !== id)
}

/**
 * Which tab becomes active after closing `id`: the one to its right, or the one to its left when it
 * was last. Closing the only tab leaves nothing to select.
 */
export function tabAfterClose(tabs: string[], id: string): string | undefined {
  const index = tabs.indexOf(id)
  if (index === -1) return tabs[0]
  const rest = closeTab(tabs, id)
  return rest[Math.min(index, rest.length - 1)]
}

/** The tab `delta` steps away, wrapping around. */
export function cycleTab(tabs: string[], active: string | undefined, delta: number): string | undefined {
  if (tabs.length === 0) return undefined
  const index = active ? tabs.indexOf(active) : -1
  const next = (index + delta + tabs.length) % tabs.length
  return tabs[index === -1 ? (delta > 0 ? 0 : tabs.length - 1) : next]
}

/** Drops tabs whose session no longer exists, keeping the order of the rest. */
export function keepTabs(tabs: string[], exists: (id: string) => boolean): string[] {
  return tabs.filter(exists)
}
