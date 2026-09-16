/**
 * Which full screen is open, written in the URL so a reload comes back to it.
 *
 * A path, not a hash, which means everything that serves this build has to answer an address like
 * `/runs` with `index.html` instead of a 404: Vite does it on its own, `vercel.json` rewrites it,
 * and the desktop app's renderer protocol falls back to the page for any address that is not a file.
 */
export type Screen = "routines" | "runs" | "artifacts" | "changes"

const SCREENS: readonly Screen[] = ["routines", "runs", "artifacts", "changes"]

/** The screen the path names, if it names one. Anything else is the home screen. */
export function screenFromPath(pathname: string): Screen | undefined {
  const name = pathname.replace(/^\/+/, "").replace(/\/+$/, "")
  return SCREENS.find((screen) => screen === name)
}

/**
 * Where the address bar should point for a screen.
 *
 * The query and the hash come along: a pairing link (`#pair=…`) and a launch parameter both arrive
 * that way and are read after the first paint, so dropping them here would lose them.
 */
export function urlForScreen(screen: Screen | undefined, location: { search: string; hash: string }) {
  return `/${screen ?? ""}${location.search}${location.hash}`
}
