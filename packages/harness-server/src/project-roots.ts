/**
 * The folders the harness may read and write in (TI-11).
 *
 * Every route that takes a `directory` from a caller used to trust it, so `directory=/` read any file
 * of the user's. A folder is now accepted only when it is, or is inside, a project the engine knows or
 * one of its worktrees, compared by real path so a link cannot stand in for a project.
 *
 * The filesystem root is never one, even when the engine lists it: an engine started from `/` (the
 * desktop app, launched from the Finder) records `/` as the project of every session opened without a
 * folder, and accepting it would accept everything.
 */

import { realpathSync } from "node:fs"
import { parse, resolve, sep } from "node:path"

/**
 * A list read this recently is trusted without asking the engine again. A folder it does not have
 * always asks again: a project opened a moment ago is not in it yet.
 */
const FRESH_MS = 10_000

export type ProjectRoots = ReturnType<typeof projectRoots>

/** `list` names the engine's project folders and worktrees; it is read lazily and cached. */
export function projectRoots(list: () => Promise<string[]>) {
  let known: string[] = []
  let readAt = 0

  const load = async () => {
    // An engine that cannot be asked knows no project: the guard fails closed.
    known = await list()
      .then((roots) => roots.flatMap((root) => realOrNothing(root) ?? []).filter((root) => parse(root).root !== root))
      .catch(() => [])
    readAt = Date.now()
    return known
  }

  return {
    /** The folder's real path when it is inside a known project, or `undefined`. */
    async within(directory: string) {
      const real = realOrNothing(resolve(directory))
      if (!real) return undefined
      if (Date.now() - readAt < FRESH_MS && contains(known, real)) return real
      return contains(await load(), real) ? real : undefined
    },
  }
}

/**
 * The real path of `path` inside `root`, or `undefined` when it leaves it.
 *
 * Resolved twice: lexically, so `..` and an absolute path are refused before the disk is touched, and
 * then through every link, so a link inside the folder that points out of it is refused too. A path
 * that does not exist answers its lexical form, so the caller can still say "no such file".
 */
export function confinedPath(root: string, path: string) {
  const base = resolve(root)
  const absolute = resolve(base, path)
  if (!inside(base, absolute)) return undefined
  const real = realOrNothing(absolute)
  if (!real) return absolute
  return inside(realOrNothing(base) ?? base, real) ? real : undefined
}

function contains(roots: string[], real: string) {
  return roots.some((root) => inside(root, real))
}

function inside(root: string, path: string) {
  return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
}

function realOrNothing(path: string) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
