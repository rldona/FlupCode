/**
 * Skills, and why yours is not showing up (H-27).
 *
 * The audit calls the old screen a placebo, and it was: a list with an Insert button. The question a
 * skill screen has to answer is the one that list could not — *"I wrote a skill and the model does
 * not have it"* — and answering it means knowing the engine's rules exactly rather than roughly.
 *
 * **Every rule below was measured against a local engine on 17/09/2026**, in one clean project,
 * because the loader the runs go through is the legacy one in `opencode/src/skill/index.ts` and it is
 * stricter than the v2 one next to it:
 *
 * ```
 * .opencode/skills/named/SKILL.md      with `name:`      → loaded
 * .opencode/skills/unnamed/SKILL.md    without `name:`   → NOT loaded, silently
 * .opencode/skills/toplevel.md         not named SKILL.md→ NOT loaded, silently
 * .claude/skills/from-claude/SKILL.md                    → loaded
 * .agents/skills/from-agents/SKILL.md                    → loaded
 * ```
 *
 * And one more, checked on purpose: a skill written **after** the folder was opened does not appear,
 * at all, until the engine opens that folder again. Two of those three failures look identical from
 * the outside — nothing happens — which is exactly why they are worth naming on a screen.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { configDirectory, isInside, walkUp } from "./context"
import { parseFrontmatter, serialiseFrontmatter } from "./frontmatter"

export type SkillScope = "global" | "project" | "claude" | "agents"

export type SkillFile = {
  /** The name the model would see. Undefined when the file gives none, which is why it is ignored. */
  name?: string
  path: string
  scope: SkillScope
  /** The folder the engine scans, which this file was found under. */
  root: string
  description?: string
  bytes: number
  /** Whether the engine would load it, and when not, why not. */
  loaded: boolean
  reason?: string
  /** The name is already taken by a file the engine reads first. */
  shadows?: string
}

export class SkillError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "SkillError"
  }
}

/** A folder name that is a folder name and nothing else. */
export const NAME = /^[a-z0-9][a-z0-9._-]*$/i

/**
 * Every folder the engine scans for skills, in the order it scans them.
 *
 * `{skill,skills}` under each config folder, and `skills` under `.claude` and `.agents` — the two it
 * borrows from other tools — in the home folder and walking up to the project root.
 */
export function skillRoots(directory?: string, projectDirectory?: string) {
  const roots: Array<{ path: string; scope: SkillScope }> = []
  const home = homedir()
  roots.push({ path: join(home, ".claude", "skills"), scope: "claude" })
  roots.push({ path: join(home, ".agents", "skills"), scope: "agents" })
  for (const folder of ["skill", "skills"]) roots.push({ path: join(configDirectory(), folder), scope: "global" })
  if (directory) {
    const stop = projectDirectory ?? directory
    const folders = isInside(directory, stop) ? walkUp(directory, stop) : [directory]
    for (const folder of folders) {
      roots.push({ path: join(folder, ".claude", "skills"), scope: "claude" })
      roots.push({ path: join(folder, ".agents", "skills"), scope: "agents" })
      for (const name of ["skill", "skills"]) {
        roots.push({ path: join(folder, ".opencode", name), scope: "project" })
      }
    }
  }
  return roots
}

const markdownIn = (folder: string): string[] => {
  if (!existsSync(folder)) return []
  const out: string[] = []
  let entries: Array<{ name: string; isDirectory: () => boolean }> = []
  try {
    entries = readdirSync(folder, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) out.push(...markdownIn(path))
    else if (entry.name.endsWith(".md")) out.push(path)
  }
  return out.sort()
}

/**
 * Every skill file on disk, and whether the engine would load it.
 *
 * Files that are not loaded are the point of this. Listing only the good ones would be the screen
 * that already existed.
 */
export function skillReport(directory?: string, projectDirectory?: string): SkillFile[] {
  const files: SkillFile[] = []
  const seenPath = new Set<string>()
  const takenBy = new Map<string, string>()
  for (const root of skillRoots(directory, projectDirectory)) {
    for (const path of markdownIn(root.path)) {
      if (seenPath.has(path)) continue
      seenPath.add(path)
      let text = ""
      let bytes = 0
      try {
        text = readFileSync(path, "utf8")
        bytes = statSync(path).size
      } catch {
        continue
      }
      const { fields, problem } = parseFrontmatter(text)
      const name = typeof fields.name === "string" && fields.name.trim() ? fields.name.trim() : undefined
      const description = typeof fields.description === "string" ? fields.description : undefined
      const file: SkillFile = { path, scope: root.scope, root: root.path, bytes, loaded: false, ...(name ? { name } : {}), ...(description ? { description } : {}) }
      if (basename(path) !== "SKILL.md") {
        // Measured: a `.md` in a skill folder that is not called SKILL.md is never globbed.
        files.push({ ...file, reason: "Only a file called SKILL.md is loaded" })
        continue
      }
      if (problem) {
        files.push({ ...file, reason: problem })
        continue
      }
      if (!name) {
        // Measured: the name is required, and a file without one is skipped without a word.
        files.push({ ...file, reason: "It has no `name` in its frontmatter, so the engine skips it" })
        continue
      }
      const taken = takenBy.get(name)
      if (taken) {
        files.push({ ...file, reason: "Another skill already has this name", shadows: taken })
        continue
      }
      takenBy.set(name, path)
      files.push({ ...file, loaded: true })
    }
  }
  return files
}

/** Where a new skill of this scope would be written. */
export function rootFor(scope: "global" | "project", directory?: string, projectDirectory?: string) {
  if (scope === "global") return join(configDirectory(), "skills")
  const stop = projectDirectory ?? directory
  if (!directory || !stop) throw new SkillError("There is no folder to write a project skill into: open a project first")
  const folders = isInside(directory, stop) ? walkUp(directory, stop) : [directory]
  return join(folders.at(-1)!, ".opencode", "skills")
}

/** The file a new skill would be written to, checked to be inside the folder it claims. */
export function pathFor(
  input: { name: string; scope: "global" | "project" },
  directory?: string,
  projectDirectory?: string,
) {
  if (!NAME.test(input.name)) {
    throw new SkillError("A name can only be letters, numbers, dots, dashes and underscores")
  }
  const root = rootFor(input.scope, directory, projectDirectory)
  const path = resolve(root, input.name, "SKILL.md")
  if (!path.startsWith(root + sep)) throw new SkillError("That name would write outside the skills folder")
  return path
}

export type SkillDraft = {
  name: string
  scope: "global" | "project"
  description: string
  body: string
}

/**
 * Writes one, the way the engine reads it: a folder of its own, a `SKILL.md`, and a `name` in the
 * frontmatter — which is the field it is silently dropped for missing.
 */
export function writeSkill(draft: SkillDraft, directory?: string, projectDirectory?: string) {
  const path = pathFor(draft, directory, projectDirectory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    serialiseFrontmatter({
      fields: { name: draft.name, ...(draft.description.trim() ? { description: draft.description.trim() } : {}) },
      prompt: draft.body,
    }),
  )
  return path
}

/** What one says, for reading it in place. Only a file this report already named. */
export function readSkill(path: string, directory?: string, projectDirectory?: string) {
  if (!skillReport(directory, projectDirectory).some((file) => file.path === path)) return undefined
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Deletes one, and only one this report named.
 *
 * The `SKILL.md` and, when the folder it lived in holds nothing else, that folder — an empty folder
 * left behind is the thing that makes the next person wonder whether it worked.
 */
export function deleteSkill(path: string, directory?: string, projectDirectory?: string) {
  const file = skillReport(directory, projectDirectory).find((entry) => entry.path === path)
  if (!file) throw new SkillError("That is not a skill file this project knows about", 404)
  rmSync(path)
  const folder = dirname(path)
  try {
    // `rmSync` on a directory needs `recursive`, which is exactly what must not happen here.
    if (folder !== file.root && readdirSync(folder).length === 0) rmdirSync(folder)
  } catch {
    // Leaving the folder is not a failure worth reporting: the skill is gone either way.
  }
}
