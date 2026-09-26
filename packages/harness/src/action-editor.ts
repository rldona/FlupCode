/**
 * The editor's own browser session (WA-8).
 *
 * The Actions panel drives a real browser to preview a recipe and to pick selectors. That browser
 * is keyed by a session id the server accepts (`^[A-Za-z0-9_-]{1,128}$`), derived from the project
 * so reopening the editor reuses the same profile — and therefore the same login — rather than
 * starting a second window against a site that is already signed in.
 *
 * Pure, so the id can be asserted without a browser: the editor and its tests agree on one function.
 */
export function editorBrowserSessionID(project: string): string {
  return `editor-${hash(project)}`
}

/**
 * Where a click landed on the live frame, as a `0..1` fraction of it (WA-8).
 *
 * The frame is drawn at whatever size the panel gives it and its pixels are the device's, while the
 * page is measured in CSS pixels. A fraction is neither, so a click maps to the same point whatever
 * the device pixel ratio: the server turns it back into CSS pixels against the page's viewport.
 */
export function frameClickFraction(input: {
  clientX: number
  clientY: number
  left: number
  top: number
  width: number
  height: number
}): { x: number; y: number } {
  return { x: (input.clientX - input.left) / input.width, y: (input.clientY - input.top) / input.height }
}

/**
 * A stable 64-bit-ish hash as hex, enough to tell one project from another in a session id.
 *
 * Not a security hash and not used as one: the session id is only a key, and the server's own regex
 * is what keeps it safe. FNV-1a is chosen because it is short, deterministic and available without
 * a crypto call in the renderer.
 */
function hash(value: string): string {
  let low = 0x811c9dc5
  let high = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    low = Math.imul(low ^ code, 0x01000193) >>> 0
    high = Math.imul(high ^ (code ^ (index & 0xff)), 0x01000193) >>> 0
  }
  return high.toString(16).padStart(8, "0") + low.toString(16).padStart(8, "0")
}
