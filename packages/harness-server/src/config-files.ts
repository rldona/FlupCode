/**
 * Config files you can look at, and hand to your own config repository.
 *
 * The harness could show the agents, commands and skills a folder loads, but not the rest of the
 * engine's configuration: the `tool/*.{js,ts}` modules it scans, the guard modules a delivery profile
 * names, and the global `config.json` / `opencode.json` / `opencode.jsonc`. This lists those, reads
 * one back confined to the list, and copies the global ones into the repository the user keeps their
 * configuration in.
 *
 * **Where a tool is read from is the engine's own rule, read from `config/paths.ts` and
 * `tool/registry.ts` rather than guessed:** `{tool,tools}/*.{js,ts}` under the global config
 * directory, under every `.opencode` from the session's folder up to the project root, under
 * `~/.opencode`, and under `OPENCODE_CONFIG_DIR` when it is set. The delivery plugin resolves guards
 * against the same config directory, and merges `config.json` → `opencode.json` → `opencode.jsonc`,
 * later winning; this mirrors that merge so the list says what the engine would load. The global
 * config is read from both the XDG folder and `OPENCODE_CONFIG_DIR`, later winning, because the
 * engine can have written the repository to either depending on how it was started.
 *
 * **Export only writes.** It copies a global file into the config repository and never replaces the
 * original with a symlink: the user's own `install.sh` owns symlinks, and nothing here runs a script.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { configDirectory, isInside, walkUp } from "./context"
import { MAX_BYTES } from "./files"

export type ConfigFileScope = "global" | "project"
export type ConfigFileKind = "tool" | "guard" | "config"

export type ConfigFileEntry = {
  name: string
  path: string
  scope: ConfigFileScope
  kind: ConfigFileKind
  bytes: number
  mtimeMs: number
  /** The link target, when the file is a symlink rather than a file of its own. */
  symlink?: { target: string }
  /** A guard the config names but which is not there, so the engine would refuse to load it. */
  missing?: boolean
}

export type ConfigFileText = { path: string; text: string }

export type ExportClassification = "written" | "unchanged" | "conflicts" | "skipped" | "outside"

export type ExportEntry = {
  path: string
  /** Where in the repository this would go. Empty when the file could not be mapped. */
  target: string
  classification: ExportClassification
  reason?: string
}

export type ExportResult = {
  repo: string
  /** True when nothing was written and this is only the plan. */
  dryRun: boolean
  written: string[]
  unchanged: string[]
  conflicts: string[]
  skipped: string[]
  outside: string[]
  entries: ExportEntry[]
}

export class ConfigFileError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "ConfigFileError"
  }
}

/** The folder names the engine looks in, in the order it looks. */
const TOOL_FOLDERS = ["tool", "tools"] as const
const TOOL_EXTENSIONS = [".js", ".ts"] as const

/** The global config files the delivery plugin merges, in the order it merges them. */
const CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"] as const

type Layer = { path: string; scope: ConfigFileScope }

/** The raw XDG config folder, as the engine's `directories()` reads it. */
function xdgConfigDirectory() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode")
}

/**
 * Every global folder whose config files are read, in the order they are merged.
 *
 * `OPENCODE_CONFIG_DIR` is the engine's explicit override and therefore wins, so it comes last; the
 * XDG folder is the default it replaces. A folder is not read twice.
 */
function globalConfigDirectories(): string[] {
  const dirs = [xdgConfigDirectory()]
  if (process.env.OPENCODE_CONFIG_DIR) dirs.push(process.env.OPENCODE_CONFIG_DIR)
  return [...new Set(dirs)]
}

/** The home folder the engine uses, test override included. */
function homeDirectory() {
  return process.env.OPENCODE_TEST_HOME ?? homedir()
}

/**
 * Every place a tool module would be scanned from, the engine's order.
 *
 * The engine builds this list in `config/paths.ts`: the XDG config folder, every `.opencode` from the
 * session's folder up to the worktree, `~/.opencode`, then `OPENCODE_CONFIG_DIR`. Duplicated folders
 * are dropped, the same way it deduplicates them.
 */
function toolRoots(directory?: string, projectDirectory?: string): Layer[] {
  const layers: Layer[] = [{ path: xdgConfigDirectory(), scope: "global" }]
  if (directory && !process.env.OPENCODE_DISABLE_PROJECT_CONFIG) {
    const stop = projectDirectory ?? directory
    if (isInside(directory, stop)) {
      for (const folder of walkUp(directory, stop)) layers.push({ path: join(folder, ".opencode"), scope: "project" })
    } else {
      layers.push({ path: join(directory, ".opencode"), scope: "project" })
    }
  }
  layers.push({ path: join(homeDirectory(), ".opencode"), scope: "global" })
  if (process.env.OPENCODE_CONFIG_DIR) layers.push({ path: process.env.OPENCODE_CONFIG_DIR, scope: "global" })
  const seen = new Set<string>()
  return layers.filter((layer) => {
    if (seen.has(layer.path)) return false
    seen.add(layer.path)
    return true
  })
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** JSONC without a parser: comments and trailing commas are all that separates it from JSON. */
function stripJsonc(text: string) {
  let out = ""
  let inString = false
  let escape = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2
      while (i < text.length && text[i] !== "\n") i += 1
      continue
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out.replace(/,(?=\s*[}\]])/g, "")
}

/** The delivery plugin's own merge: nested objects combine, everything else is replaced. */
function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...target }
  for (const key of Object.keys(source)) {
    merged[key] =
      isPlainObject(target[key]) && isPlainObject(source[key])
        ? mergeConfig(target[key], source[key])
        : source[key]
  }
  return merged
}

/** One global folder's config files merged, later files winning, as the delivery plugin loads them. */
function loadConfigDirectory(configDir: string): Record<string, unknown> {
  let merged: Record<string, unknown> = {}
  for (const name of CONFIG_FILES) {
    const path = join(configDir, name)
    if (!existsSync(path)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(stripJsonc(readFileSync(path, "utf8")))
    } catch {
      continue
    }
    if (isPlainObject(parsed)) merged = mergeConfig(merged, parsed)
  }
  return merged
}

/** The merged global config across every folder read, so the repo and guards are found wherever set. */
function loadGlobalConfig(): Record<string, unknown> {
  let merged: Record<string, unknown> = {}
  for (const dir of globalConfigDirectories()) merged = mergeConfig(merged, loadConfigDirectory(dir))
  return merged
}

/** Every guard every delivery profile names, resolved against the config directory. */
function guardEntries(config: Record<string, unknown>, configDir: string) {
  const flupcode = config.flupcode
  const delivery = isPlainObject(flupcode) ? flupcode.delivery : undefined
  if (!isPlainObject(delivery)) return []
  const seen = new Set<string>()
  const out: Array<{ name: string; path: string; missing: boolean }> = []
  for (const profile of Object.values(delivery)) {
    if (!isPlainObject(profile)) continue
    const guards = profile.guards
    if (!Array.isArray(guards)) continue
    for (const entry of guards) {
      if (typeof entry !== "string" || !entry) continue
      const path = resolve(configDir, entry)
      if (seen.has(path)) continue
      seen.add(path)
      out.push({ name: entry, path, missing: !existsSync(path) })
    }
  }
  return out
}

/** One file as the list would describe it, or nothing when it cannot be stat-ed. */
function describe(path: string, scope: ConfigFileScope, kind: ConfigFileKind, name = basename(path)): ConfigFileEntry | undefined {
  let symlink: { target: string } | undefined
  let bytes = 0
  let mtimeMs = 0
  try {
    if (lstatSync(path).isSymbolicLink()) symlink = { target: readlinkSync(path) }
    const stat = statSync(path)
    if (!stat.isFile()) return undefined
    bytes = stat.size
    mtimeMs = stat.mtimeMs
  } catch {
    return undefined
  }
  return { name, path, scope, kind, bytes, mtimeMs, ...(symlink ? { symlink } : {}) }
}

/** The tool modules directly inside one folder, a symlink included. */
function toolFiles(folder: string): string[] {
  if (!existsSync(folder)) return []
  const entries = readdirSync(folder, { withFileTypes: true })
    .filter((entry) => (entry.isFile() || entry.isSymbolicLink()) && TOOL_EXTENSIONS.some((ext) => entry.name.endsWith(ext)))
    .map((entry) => join(folder, entry.name))
  return entries.sort()
}

/**
 * The config files this folder would load: its tools, the guards its delivery profiles name, and the
 * global config files. A guard the config names but which is not there is listed with `missing`, so
 * the screen can say the engine would refuse rather than let it disappear.
 */
export function listConfigFiles(input: { directory?: string; project?: string } = {}): ConfigFileEntry[] {
  const out: ConfigFileEntry[] = []
  const seen = new Set<string>()
  const push = (entry: ConfigFileEntry) => {
    if (seen.has(entry.path)) return
    seen.add(entry.path)
    out.push(entry)
  }

  for (const root of toolRoots(input.directory, input.project)) {
    for (const folder of TOOL_FOLDERS) {
      for (const path of toolFiles(join(root.path, folder))) {
        const entry = describe(path, root.scope, "tool")
        if (entry) push(entry)
      }
    }
  }

  const configDir = configDirectory()
  for (const dir of globalConfigDirectories()) {
    for (const guard of guardEntries(loadConfigDirectory(dir), dir)) {
      const entry = guard.missing
        ? { name: guard.name, path: guard.path, scope: "global" as const, kind: "guard" as const, bytes: 0, mtimeMs: 0, missing: true }
        : describe(guard.path, "global", "guard", guard.name)
      if (entry) push(entry)
    }
  }

  for (const name of CONFIG_FILES) {
    const path = join(configDir, name)
    if (!existsSync(path)) continue
    const entry = describe(path, "global", "config", name)
    if (entry) push(entry)
  }

  return out
}

/** One listed file's text, and only a file this would have listed. */
export function readConfigFile(path: string, input: { directory?: string; project?: string } = {}): ConfigFileText {
  const known = listConfigFiles(input).some((entry) => entry.path === path)
  if (!known) throw new ConfigFileError("That is not a config file this server lists", 404)
  let isFile = false
  try {
    isFile = statSync(path).isFile()
  } catch {
    throw new ConfigFileError("No such file", 404)
  }
  if (!isFile) throw new ConfigFileError("That is not a file")
  return { path, text: readFileSync(path).subarray(0, MAX_BYTES).toString("utf8") }
}

/** The repository the user keeps their configuration in, from the global config and nowhere else. */
function configRepo(config: Record<string, unknown>): string {
  const flupcode = config.flupcode
  const value = isPlainObject(flupcode) ? flupcode.configRepo : undefined
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigFileError("No config repository is set in the global config (flupcode.configRepo)")
  }
  const repo = resolve(value)
  let isDirectory = false
  try {
    isDirectory = statSync(repo).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) throw new ConfigFileError(`The configured config repository is not a folder: ${repo}`)
  return repo
}

const inside = (path: string, root: string) => path === root || path.startsWith(root + sep)

const safeRealpath = (path: string) => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

/**
 * Whether `path` — which may not exist, like a dangling link — resolves inside `root`.
 *
 * `realpathSync` canonicalises a symlinked ancestor only up to the nearest folder that exists, so a
 * missing leaf under a directory that is itself a link still compares against the real root.
 */
function resolvesInside(path: string, root: string) {
  const realRoot = safeRealpath(root)
  let at = path
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(at)) return inside(safeRealpath(at), realRoot)
    const up = dirname(at)
    if (up === at) return false
    at = up
  }
  return false
}

/**
 * Whether any folder on the way to `target` is a link that leaves the repository.
 *
 * A `..` is refused before this runs; this catches the same escape made through a symlinked folder,
 * where the path itself looks confined. The nearest folder that exists is the one that decides.
 */
function escapesRepo(target: string, repoRoot: string) {
  const realRoot = safeRealpath(repoRoot)
  let at = dirname(target)
  for (let depth = 0; depth < 64; depth++) {
    if (existsSync(at)) return !inside(safeRealpath(at), realRoot)
    const up = dirname(at)
    if (up === at) return false
    at = up
  }
  return false
}

const filesEqual = (left: string, right: string) => {
  try {
    return readFileSync(left).equals(readFileSync(right))
  } catch {
    return false
  }
}

/**
 * How an existing target decides an entry, or nothing when there is nothing there.
 *
 * `lstatSync` rather than `existsSync`: a symlink exists as a link even when it points nowhere, and a
 * dangling one must never be replaced by the copy. A link is left alone — `outside` when its realpath
 * leaves the repository, `conflicts` otherwise — and so is anything that is not a regular file, since
 * reading a FIFO to compare would block.
 */
function existingTarget(
  source: string,
  target: string,
  repoRoot: string,
): Pick<ExportEntry, "classification" | "reason"> | undefined {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(target)
  } catch {
    return undefined
  }
  if (stat.isSymbolicLink()) {
    const link = safeRealpath(resolve(dirname(target), readlinkSync(target)))
    return resolvesInside(link, repoRoot)
      ? { classification: "conflicts", reason: "a link already points here, and is not this file" }
      : { classification: "outside", reason: "the target is a link that leaves the repository" }
  }
  if (!stat.isFile()) return { classification: "conflicts", reason: "the target is not a regular file" }
  return filesEqual(source, target)
    ? { classification: "unchanged", reason: "the repository already has this file" }
    : { classification: "conflicts", reason: "the repository already has a different file here" }
}

type PlanEntry = ExportEntry & { sourcePath?: string; sourceBytes?: Buffer }

/** One requested path classified, before anything is written. */
function planEntry(path: string, configDir: string, repoRoot: string, listed: ConfigFileEntry[]): PlanEntry {
  const entry = listed.find((candidate) => candidate.path === path)
  if (!entry) {
    return { path, target: "", classification: "skipped", reason: "not one of this server's config files" }
  }
  if (entry.scope !== "global") {
    return { path, target: "", classification: "skipped", reason: "project-scope" }
  }
  if (entry.missing) {
    return { path, target: "", classification: "skipped", reason: "the file is not there" }
  }

  const relativePath = relative(configDir, entry.path)
  if (!relativePath || isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    return { path, target: "", classification: "outside", reason: "outside the global config folder" }
  }
  const target = resolve(repoRoot, relativePath)
  if (!inside(target, repoRoot)) {
    return { path, target, classification: "outside", reason: "the mapped path would escape the repository" }
  }
  if (escapesRepo(target, repoRoot)) {
    return { path, target, classification: "outside", reason: "a folder on the way would escape the repository" }
  }

  let isLink = false
  try {
    isLink = lstatSync(entry.path).isSymbolicLink()
  } catch {
    return { path, target, classification: "skipped", reason: "the file is not there" }
  }

  // A link that already points into the repository is the finished state, not something to copy.
  if (isLink) {
    const link = safeRealpath(resolve(dirname(entry.path), readlinkSync(entry.path)))
    if (inside(link, safeRealpath(repoRoot))) {
      return { path, target, classification: "unchanged", reason: "the link already points into the repository" }
    }
    return { path, target, classification: "outside", reason: "the link points outside the repository" }
  }

  const sourceBytes = readFileSync(entry.path)
  // Copy by default, never replace. An existing target — a file, a dangling link, a FIFO — is
  // somebody's work, so anything but an identical regular file is a conflict to resolve.
  const existing = existingTarget(entry.path, target, repoRoot)
  if (existing) return { path, target, ...existing }
  return { path, target, classification: "written", sourcePath: entry.path, sourceBytes }
}

const classify = (value: ExportClassification) => (plan: PlanEntry[]) =>
  plan.filter((entry) => entry.classification === value).map((entry) => entry.path)

/** The plan as a caller sees it, the per-path detail included. */
function toResult(repo: string, dryRun: boolean, plan: PlanEntry[]): ExportResult {
  return {
    repo,
    dryRun,
    written: classify("written")(plan),
    unchanged: classify("unchanged")(plan),
    conflicts: classify("conflicts")(plan),
    skipped: classify("skipped")(plan),
    outside: classify("outside")(plan),
    entries: plan.map(({ path, target, classification, reason }) => ({
      path,
      target,
      classification,
      ...(reason ? { reason } : {}),
    })),
  }
}

// One export at a time, so two windows cannot read the same target and each write the other's work
// away. The queue is module-global, like the plugin's own per-file queues.
let exportQueue: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = exportQueue.then(work, work)
  exportQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/** Writes the entries the plan marked as new, re-checking each target just before it is renamed in. */
async function applyPlan(plan: PlanEntry[], repoRoot: string): Promise<PlanEntry[]> {
  const applied: PlanEntry[] = []
  for (const entry of plan) {
    if (entry.classification !== "written" || !entry.sourcePath || !entry.sourceBytes) {
      applied.push(entry)
      continue
    }
    // Re-preview: whatever the plan saw, the target must still be absent when the write happens.
    const existing = existingTarget(entry.sourcePath, entry.target, repoRoot)
    if (existing) {
      applied.push({ ...entry, ...existing })
      continue
    }
    if (escapesRepo(entry.target, repoRoot)) {
      applied.push({ ...entry, classification: "outside", reason: "a folder on the way would escape the repository" })
      continue
    }
    mkdirSync(dirname(entry.target), { recursive: true })
    const temp = join(dirname(entry.target), `.${basename(entry.target)}.${process.pid}.tmp`)
    try {
      writeFileSync(temp, entry.sourceBytes)
      renameSync(temp, entry.target)
    } catch (cause) {
      rmSync(temp, { force: true })
      throw cause
    }
    applied.push(entry)
  }
  return applied
}

/**
 * Copies the chosen global files into the user's config repository.
 *
 * The repository comes from the merged global config, never from the request. A path must be a global
 * file this server lists and must map inside the repository; a project file is skipped, a link that
 * points outside is refused, and an existing file with different bytes is a conflict rather than
 * something to clobber. Without `confirm` nothing is written.
 */
export async function exportConfigFiles(input: {
  directory?: string
  project?: string
  paths: string[]
  confirm?: boolean
}): Promise<ExportResult> {
  const configDir = configDirectory()
  const repoRoot = configRepo(loadGlobalConfig())
  const listed = listConfigFiles({ directory: input.directory, project: input.project })
  const plan = input.paths.flatMap((path) => (typeof path === "string" && path ? [planEntry(path, configDir, repoRoot, listed)] : []))
  if (input.confirm !== true) return toResult(repoRoot, true, plan)
  return serial(async () => toResult(repoRoot, false, await applyPlan(plan, repoRoot)))
}
