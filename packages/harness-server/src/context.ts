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

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
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

/** One system prompt as the engine handed it to the provider, before the request went out. */
export type CapturedPrompt = {
  at: number
  providerID?: string
  modelID?: string
  system: string[]
}

/**
 * Where FlupCode's engine plugin records those prompts. Kept in step with the plugin it installs
 * (`packages/remote/src/engine-plugins.ts`), which writes one folder per session under it.
 */
export function systemPromptsDirectory() {
  const explicit = process.env.FLUPCODE_SYSTEM_PROMPTS_DIR
  if (explicit) return explicit
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "flupcode", "system-prompts")
}

/** One completed call, with how long it took. The timeline is built from these (H-16). */
export type ToolCall = { tool: string; start?: number; ms?: number }

/** What one session's tools were used for. The engine names an MCP tool `<server>_<tool>`. */
export type ToolUses = {
  tools: Record<string, { count: number; last: number }>
  /** Completed calls, newest last. Absent in files written before calls were timed. */
  calls: ToolCall[]
}

/** Where the other engine plugin records that, one file per session. */
export function toolUsesDirectory() {
  const explicit = process.env.FLUPCODE_TOOL_USES_DIR
  if (explicit) return explicit
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "flupcode", "tool-uses")
}

/**
 * The tools a session ran, and how often.
 *
 * The engine never reports which tools an MCP server offers — its tools bypass the tool registry, so
 * no endpoint lists them and the prompt carries only the server's name — but it hands every call to
 * the plugin that writes this. Which of them belong to which server is worked out on the other side,
 * where the servers are known.
 */
export function usedTools(sessionID: string): ToolUses {
  // The id names a file under ours; anything else is not a session and is not looked up.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return { tools: {}, calls: [] }
  try {
    const parsed = JSON.parse(readFileSync(join(toolUsesDirectory(), `${sessionID}.json`), "utf8")) as {
      tools?: unknown
      calls?: unknown
    }
    const tools: ToolUses["tools"] = {}
    if (parsed?.tools && typeof parsed.tools === "object") {
      for (const [name, value] of Object.entries(parsed.tools as Record<string, unknown>)) {
        const entry = value as { count?: unknown; last?: unknown }
        if (typeof entry?.count !== "number" || typeof entry.last !== "number") continue
        tools[name] = { count: entry.count, last: entry.last }
      }
    }
    return { tools, calls: readToolCalls(parsed?.calls) }
  } catch {
    return { tools: {}, calls: [] }
  }
}

/** Only the calls that can be read back whole; a malformed entry is dropped rather than guessed at. */
function readToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const call = entry as { tool?: unknown; start?: unknown; ms?: unknown }
    if (typeof call.tool !== "string" || !call.tool) return []
    return [
      {
        tool: call.tool,
        ...(typeof call.start === "number" ? { start: call.start } : {}),
        ...(typeof call.ms === "number" ? { ms: call.ms } : {}),
      },
    ]
  })
}

const record = (value: unknown): CapturedPrompt | undefined => {
  if (!value || typeof value !== "object") return undefined
  const entry = value as { at?: unknown; providerID?: unknown; modelID?: unknown; system?: unknown }
  if (typeof entry.at !== "number" || !Array.isArray(entry.system)) return undefined
  if (!entry.system.every((part) => typeof part === "string")) return undefined
  return {
    at: entry.at,
    ...(typeof entry.providerID === "string" ? { providerID: entry.providerID } : {}),
    ...(typeof entry.modelID === "string" ? { modelID: entry.modelID } : {}),
    system: entry.system,
  }
}

/**
 * The requests a session's last turns were given, newest first.
 *
 * A session has more than one: the turn itself, the title the engine writes for it, a compaction and
 * its continuation all go through the same hook, and the plugin keeps the newest few of them. Which
 * is which is left to the reader of the screen rather than guessed at here.
 */
export function capturedPrompts(sessionID: string, limit = 6): CapturedPrompt[] {
  // The id names a folder under ours; anything else is not a session and is not looked up.
  if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return []
  const folder = join(systemPromptsDirectory(), sessionID)
  let files: string[]
  try {
    files = readdirSync(folder)
  } catch {
    return []
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, limit)
    .flatMap((file) => {
      try {
        const parsed = record(JSON.parse(readFileSync(join(folder, file), "utf8")))
        return parsed ? [parsed] : []
      } catch {
        return []
      }
    })
}
