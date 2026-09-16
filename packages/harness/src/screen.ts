/**
 * Which full screen is open, written in the URL so a reload comes back to it.
 *
 * The hash, not a path. The same build is served by Vite, by a static host and from the desktop
 * app's own bundle, and only the hash survives a reload in all three: a path like `/runs` needs
 * whatever serves the file to rewrite unknown paths to `index.html`, and the desktop app has
 * nothing to do that.
 */
export type Screen = "routines" | "runs"

const SCREENS: readonly Screen[] = ["routines", "runs"]

/**
 * The screen the hash names, if it names one.
 *
 * Anything else stays none: a pairing link arrives as `#pair=…` in this same hash and belongs to
 * remote control, not here.
 */
export function screenFromHash(hash: string): Screen | undefined {
  const name = hash.replace(/^#\/?/, "")
  return SCREENS.find((screen) => screen === name)
}

/** Where the address bar should point for a screen, keeping the path and query it already has. */
export function urlForScreen(screen: Screen | undefined, location: { pathname: string; search: string }) {
  return `${location.pathname}${location.search}${screen ? `#${screen}` : ""}`
}
