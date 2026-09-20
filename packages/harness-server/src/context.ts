/**
 * What the model was given (H-17).
 *
 * The audit calls the context opaque, and it is: a turn goes out with instructions nobody chose to
 * send, skills nobody remembers enabling, and a token count with no breakdown. This answers the
 * part that can be answered exactly — **which instruction files load, in which order** — and says
 * plainly which part cannot.
 *
 * The rules are the engine's own, read out of `core/src/instruction-context.ts` rather than guessed:
 *
 *  1. `AGENTS.md` in the global config directory, always first.
 *  2. Every `AGENTS.md` walking **up** from the session's folder to the project root.
 *  3. Nothing at all when the folder is outside the project, or when
 *     `OPENCODE_DISABLE_PROJECT_CONFIG` is set.
 *  4. Deduplicated, and a path with no file there is simply not loaded.
 *
 * Only `AGENTS.md`. Not `CLAUDE.md`, not `.cursorrules` — those are what `/init` reads *about*, not
 * what the engine loads. Guessing otherwise would have this screen claim the model was told things
 * it was never told, which is worse than not having the screen.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

export type InstructionFile = {
  path: string
  scope: "global" | "project"
  bytes: number
  /** The first line worth showing, so the list says something without being opened. */
  excerpt?: string
}

export type ContextReport = {
  directory: string
  projectDirectory?: string
  instructions: InstructionFile[]
  /** Why there are none, when that is a decision rather than an absence. */
  problem?: string
}

const FILENAME = "AGENTS.md"

/** Where the engine keeps its own configuration, by the same rules it uses. */
export function configDirectory() {
  const explicit = process.env.OPENCODE_CONFIG_DIR
  if (explicit) return explicit
  const xdg = process.env.XDG_CONFIG_HOME
  return join(xdg ?? join(homedir(), ".config"), "opencode")
}

/** Whether `start` is inside `stop`, which is what decides if project files load at all. */
export function isInside(start: string, stop: string) {
  const from = relative(stop, start)
  return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from))
}

/** Every directory from `start` up to and including `stop`, nearest last — the engine's order. */
export function walkUp(start: string, stop: string) {
  const out: string[] = []
  let at = resolve(start)
  const top = resolve(stop)
  // Guarded rather than `while (true)`: a path that never reaches the root would spin forever.
  for (let depth = 0; depth < 64; depth++) {
    out.push(at)
    if (at === top) break
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  // Furthest first, so the nearest file is read last and has the last word — as the engine does.
  return out.reverse()
}

const describe = (path: string, scope: InstructionFile["scope"]): InstructionFile | undefined => {
  if (!existsSync(path)) return undefined
  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    return undefined
  }
  let excerpt: string | undefined
  try {
    excerpt = readFileSync(path, "utf8")
      .split("\n")
      .map((line) => line.replace(/^#+\s*/, "").trim())
      .find((line) => line.length > 0)
      ?.slice(0, 160)
  } catch {
    excerpt = undefined
  }
  return { path, scope, bytes, ...(excerpt ? { excerpt } : {}) }
}

/**
 * The instruction files a turn in this folder would load.
 *
 * `projectDirectory` is where the walk stops. Without one the folder itself is the boundary, which
 * is what a session outside any project gets.
 */
export function instructionsFor(directory: string, projectDirectory?: string): ContextReport {
  const global = describe(join(configDirectory(), FILENAME), "global")
  if (process.env.OPENCODE_DISABLE_PROJECT_CONFIG) {
    return {
      directory,
      ...(projectDirectory ? { projectDirectory } : {}),
      instructions: global ? [global] : [],
      problem: "OPENCODE_DISABLE_PROJECT_CONFIG is set, so nothing from the project is loaded",
    }
  }

  const stop = projectDirectory ?? directory
  if (!isInside(directory, stop)) {
    return {
      directory,
      projectDirectory,
      instructions: global ? [global] : [],
      problem: "This folder is outside the project, so nothing from the project is loaded",
    }
  }

  const seen = new Set<string>()
  const instructions: InstructionFile[] = []
  if (global) {
    seen.add(global.path)
    instructions.push(global)
  }
  for (const folder of walkUp(directory, stop)) {
    const path = join(folder, FILENAME)
    if (seen.has(path)) continue
    seen.add(path)
    const file = describe(path, "project")
    if (file) instructions.push(file)
  }
  return { directory, ...(projectDirectory ? { projectDirectory } : {}), instructions }
}

/** One instruction file's contents, for reading in place. Only ones this would have loaded. */
export function readInstruction(report: ContextReport, path: string) {
  if (!report.instructions.some((file) => file.path === path)) return undefined
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}
