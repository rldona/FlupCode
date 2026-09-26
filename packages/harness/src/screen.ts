/**
 * Which full screen is open, written in the URL so a reload comes back to it.
 *
 * A path, not a hash, which means everything that serves this build has to answer an address like
 * `/runs` with `index.html` instead of a 404: Vite does it on its own, `vercel.json` rewrites it,
 * and the desktop app's renderer protocol falls back to the page for any address that is not a file.
 */
export type Screen =
  | "routines"
  | "runs"
  | "artifacts"
  | "changes"
  | "usage"
  | "context"
  | "agents"
  | "skills"
  | "files"
  | "workflows"
  | "actions"
  | "replay"
  | "compare"

const SCREENS: readonly Screen[] = [
  "routines",
  "runs",
  "artifacts",
  "changes",
  "usage",
  "context",
  "agents",
  "skills",
  "files",
  "workflows",
  "actions",
  "replay",
  "compare",
]

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

/**
 * The pair of runs a comparison link names (H-44).
 *
 * A best-of-n lands on `/compare?left=…&right=…`, so the batch it was run for survives a reload. A
 * link without them is an ordinary comparison: the reader picks, as before.
 */
export function compareFromSearch(search: string): { left?: string; right?: string } {
  const params = new URLSearchParams(search)
  return { left: params.get("left") ?? undefined, right: params.get("right") ?? undefined }
}

/** Where the comparison of these runs lives (H-44). Only two: that is what the screen holds. */
export function searchForCompare(ids: string[]) {
  const params = new URLSearchParams()
  if (ids[0]) params.set("left", ids[0])
  if (ids[1]) params.set("right", ids[1])
  const search = params.toString()
  return search ? `?${search}` : ""
}
