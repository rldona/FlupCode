/**
 * Writing one web action into a config file (WA-8).
 *
 * The reader (`loadActionProfiles`) says what a folder would load; this is the other direction. It
 * edits **only** `flupcode.actions[id]`, leaves every other byte of the file as it was — comments,
 * ordering, the rest of the config — and writes through a temp file renamed over the original, so a
 * crash cannot leave half a profile behind. A global profile goes to the first config file that is
 * already there, or to where the id already lives; a project one goes beside the project's
 * `.opencode`.
 *
 * The path is derived here and never taken from the request: a caller names a scope, a folder and a
 * profile, and this decides the file.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import type { ParseError } from "jsonc-parser"
import { validateActionProfile } from "./actions"
import { configDirectory } from "./context"
import { loadActionProfiles } from "./config-files"
import type { ActionProfileScope } from "./config-files"

/** The global config files a profile may be written to, the preferred one first. */
const GLOBAL_CANDIDATES = ["opencode.jsonc", "opencode.json", "config.json"] as const
/** A project's config files, `opencode.jsonc` preferred and `opencode.json` when that is what exists. */
const PROJECT_CANDIDATES = ["opencode.jsonc", "opencode.json"] as const

const FORMAT = { insertSpaces: true, tabSize: 2 } as const

export class ActionConfigError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "invalid_action",
  ) {
    super(message)
    this.name = "ActionConfigError"
  }
}

export type ActionProfileFile = { id: string; scope: ActionProfileScope; path: string }
export type WrittenActionProfile = { path: string; scope: ActionProfileScope; id: string }
export type RemovedActionProfile = { removed: true; path: string }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The text of a config file, or an empty document when it does not exist yet. */
function readConfigText(path: string): string {
  try {
    return readFileSync(path, "utf8")
  } catch (cause) {
    // Only a missing file is a fresh config to create. A permission error means the file is there
    // but this cannot read it, and renaming a new document over it would lose what it held.
    if (errorCodeOf(cause) === "ENOENT") return ""
    throw new ActionConfigError(`The config file could not be read: ${path}`, 500, "config_unreadable")
  }
}

/** The `code` a Node filesystem error carries, when it carries one. */
function errorCodeOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
  const code = (cause as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/** Whether a document already declares this profile id, read with the same JSONC rules as writing. */
function declaresAction(text: string, id: string): boolean {
  if (!text.trim()) return false
  const errors: ParseError[] = []
  const parsed: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0 || !isPlainObject(parsed)) return false
  const flupcode = parsed.flupcode
  if (!isPlainObject(flupcode) || !isPlainObject(flupcode.actions)) return false
  return Object.hasOwn(flupcode.actions, id)
}

/** Whether the path is an existing file, rather than a missing one or a directory. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Where this id is written: a file that already has it, then the first that exists, then the
 * preferred name so a fresh config is created rather than appended to a stranger's file.
 */
function choosePath(candidates: string[], id: string): string {
  for (const path of candidates) if (isFile(path) && declaresAction(readConfigText(path), id)) return path
  for (const path of candidates) if (isFile(path)) return path
  return candidates[0]!
}

/** The `.opencode` folder a project profile belongs to, from the folder or the project root. */
function projectConfigDirectory(input: { directory?: string; project?: string }): string {
  const root = input.project?.trim() || input.directory?.trim()
  if (!root) throw new ActionConfigError("A folder is required to write a project action", 400, "invalid_request")
  return join(root, ".opencode")
}

/** The candidate file names a scope writes to, preferred first. */
const CANDIDATES: Record<ActionProfileScope, readonly string[]> = {
  global: GLOBAL_CANDIDATES,
  project: PROJECT_CANDIDATES,
}

/** Which of a folder's candidate files holds this id, or the preferred name when none does. */
function declaredPath(scope: ActionProfileScope, directory: string, id: string): string {
  return choosePath(
    CANDIDATES[scope].map((name) => join(directory, name)),
    id,
  )
}

/** The file a scope and id resolve to. The path is computed, never taken from a caller. */
function targetPath(input: { scope: ActionProfileScope; id: string; directory?: string; project?: string }): string {
  if (input.scope === "project") {
    const opencodeDir = projectConfigDirectory({ ...(input.project ? { project: input.project } : {}), ...(input.directory ? { directory: input.directory } : {}) })
    return declaredPath("project", opencodeDir, input.id)
  }
  return declaredPath("global", configDirectory(), input.id)
}

/**
 * One list entry: the profile, the layer that declared it, and the file behind it (WA-8).
 *
 * The path is the directory the profile actually came from, not one derived from the project root:
 * a profile inherited from a parent folder's `.opencode` lives there, and pointing the editor at the
 * project root's file would name a file that does not hold it.
 */
export function listActionProfiles(input: { directory?: string; project?: string } = {}): ActionProfileFile[] {
  const source = loadActionProfiles(input)
  return Object.keys(source.profiles).map((id) => {
    const scope = source.scopes[id] ?? "global"
    const directory = source.guardDirs[id] ?? (scope === "project" ? projectConfigDirectory(input) : configDirectory())
    return { id, scope, path: declaredPath(scope, directory, id) }
  })
}

/** One profile written into its file, with the id and the scope kept beside it (WA-8). */
export async function writeActionProfile(input: {
  scope: ActionProfileScope
  profile: unknown
  directory?: string
  project?: string
  id?: string
}): Promise<WrittenActionProfile> {
  const id = actionId(input.id, input.profile)
  const validation = validateActionProfile(id, input.profile)
  if (!validation.ok) throw new ActionConfigError(validation.message, 422, validation.code)
  const path = targetPath({
    scope: input.scope,
    id,
    ...(input.project ? { project: input.project } : {}),
    ...(input.directory ? { directory: input.directory } : {}),
  })
  return serial(async () => {
    const text = readConfigText(path)
    requireReadable(text, path)
    // The map key is the id; a copy of it inside the profile would only be a second place to drift.
    const { id: _key, ...stored } = validation.profile
    const edits = modify(text, ["flupcode", "actions", id], stored, { formattingOptions: FORMAT })
    await writeAtomic(path, applyEdits(text, edits))
    return { path, scope: input.scope, id }
  })
}

/** The id a write uses: the explicit one, or the profile's own tool name (WA-8). */
function actionId(explicit: string | undefined, profile: unknown): string {
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim()
  if (isPlainObject(profile) && typeof profile.tool === "string" && profile.tool.trim()) return profile.tool.trim()
  throw new ActionConfigError("A profile needs an id or a tool name", 400, "invalid_id")
}

/** Refuses to edit a file this cannot read: rewriting a malformed config would only make it worse. */
function requireReadable(text: string, path: string): void {
  if (!text.trim()) return
  const errors: ParseError[] = []
  parse(text, errors, { allowTrailingComma: true })
  if (errors.length > 0) throw new ActionConfigError(`The config file is not valid JSONC: ${path}`, 422, "invalid_config")
}

/** Removes one profile from its file, leaving every other key as it was (WA-8). */
export async function removeActionProfile(input: {
  id: string
  scope: ActionProfileScope
  directory?: string
  project?: string
}): Promise<RemovedActionProfile | undefined> {
  const path = targetPath(input)
  if (!isFile(path)) return undefined
  return serial(async () => {
    const text = readConfigText(path)
    if (!declaresAction(text, input.id)) return undefined
    requireReadable(text, path)
    const edits = modify(text, ["flupcode", "actions", input.id], undefined, { formattingOptions: FORMAT })
    await writeAtomic(path, applyEdits(text, edits))
    return { removed: true, path }
  })
}

// One write at a time, so two windows cannot read the same file and each write the other's work away.
// Module-global like the export queue in `config-files.ts`.
let writeQueue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(work, work)
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Writes through a temp file renamed in place, so a crash never leaves a half-written config. */
async function writeAtomic(path: string, text: string): Promise<void> {
  mkdirSync(dirname(path), { recursive: true })
  const temp = join(dirname(path), `.${path.split(/[\\/]/).pop()}.${process.pid}.tmp`)
  try {
    await Bun.write(temp, text)
    renameSync(temp, path)
  } catch (cause) {
    rmSync(temp, { force: true })
    throw cause
  }
}
