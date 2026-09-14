/**
 * Path helpers for the folder browser. The engine lists entries relative to a location, so the
 * browser keeps an absolute `root` (the location) and a `relative` path inside it; these helpers
 * only manipulate strings and work with both `/` and `\` separators.
 */

const SEPARATORS = /[\\/]+/

/** The separator a path uses: `\` only for Windows drive paths. */
export function separatorOf(path: string): "/" | "\\" {
  return /^[A-Za-z]:\\/.test(path) ? "\\" : "/"
}

/** True for `/…`, `C:\…` and `\\server\…` paths. */
export function isAbsolutePath(path: string) {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path.trim())
}

/** Joins an absolute root with a relative path, without doubling separators. */
export function joinPath(root: string, relative: string) {
  const sep = separatorOf(root)
  const base = trimTrailing(root)
  const rest = relative.split(SEPARATORS).filter(Boolean).join(sep)
  if (!rest) return base || sep
  return base === "" || base === "/" ? `${sep}${rest}`.replace(/^\/\//, "/") : `${base}${sep}${rest}`
}

/** The parent of an absolute path, or `undefined` at a filesystem root. */
export function parentPath(path: string) {
  const sep = separatorOf(path)
  const trimmed = trimTrailing(path)
  if (trimmed === "" || trimmed === "/" || /^[A-Za-z]:$/.test(trimmed)) return undefined
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"))
  if (index <= 0) return sep === "/" ? "/" : undefined
  const parent = trimmed.slice(0, index)
  return /^[A-Za-z]:$/.test(parent) ? `${parent}${sep}` : parent
}

/** Path segments for a breadcrumb; the first one is the filesystem root (`/` or `C:\`). */
export function segmentsOf(path: string) {
  const sep = separatorOf(path)
  const parts = trimTrailing(path).split(SEPARATORS)
  if (sep === "/") return ["/", ...parts.filter(Boolean)]
  const [drive, ...rest] = parts
  return [`${drive}${sep}`, ...rest.filter(Boolean)]
}

/** Rebuilds the absolute path of the first `count` segments from `segmentsOf`. */
export function pathOfSegments(segments: string[], count: number) {
  const [root, ...rest] = segments
  if (!root) return ""
  const sep = separatorOf(root)
  const kept = rest.slice(0, Math.max(0, count - 1))
  return kept.length === 0 ? root : `${trimTrailing(root)}${sep}${kept.join(sep)}`.replace(/^\/\//, "/")
}

/** The last segment of an entry path such as `docs/guides/` → `guides`. */
export function entryName(path: string) {
  return trimTrailing(path).split(SEPARATORS).filter(Boolean).pop() ?? ""
}

/** Strips a trailing separator, keeping a bare `/` root intact. */
export function trimTrailing(path: string) {
  const trimmed = path.trim().replace(/[\\/]+$/, "")
  return trimmed === "" && path.trim().startsWith("/") ? "/" : trimmed
}

export type FolderEntry = { path: string; type: "file" | "directory" }

/** Directories only, hidden ones filtered unless asked for, matching an optional filter, sorted by name. */
export function visibleFolders(entries: FolderEntry[], options: { hidden: boolean; filter: string }) {
  const filter = options.filter.trim().toLowerCase()
  return entries
    .filter((entry) => entry.type === "directory")
    .map((entry) => ({ path: entry.path, name: entryName(entry.path) }))
    .filter((entry) => entry.name.length > 0)
    .filter((entry) => options.hidden || !entry.name.startsWith("."))
    .filter((entry) => !filter || entry.name.toLowerCase().includes(filter))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
}
