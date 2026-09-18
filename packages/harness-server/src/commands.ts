/**
 * Commands you can edit (H-25).
 *
 * A command is a markdown file too: frontmatter says how it runs (`description`, `agent`, `model`,
 * `subtask`), and the body is the template the engine fills with the arguments. The engine already
 * reads them — from `{command,commands}/**\/*.md` under the global config directory and under every
 * `.opencode` from the session's folder up — and lists them in the palette, so the only thing missing
 * was a way to write one without knowing the folder the engine reads.
 *
 * **The name is a path, not a file name.** The engine keys a nested file by its path under the
 * folder without the extension, so `command/git/commit.md` is `/git/commit`. A slash is allowed in
 * the middle of a name for that reason, and the write is confined to the folder it claims to be in.
 *
 * Keys nobody here understands are kept exactly as they were found, the same promise the agent
 * editor makes: an editor that drops what it does not recognise is an editor that eats work.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { configDirectory, isInside, walkUp } from "./context"
import { parseFrontmatter, serialiseFrontmatter } from "./frontmatter"

export type CommandScope = "global" | "project"

export type CommandFile = {
  /** What the engine calls it: the path under the command folder, without `.md`. */
  name: string
  path: string
  scope: CommandScope
  /** The folder this file was found under, which is where a sibling would be written. */
  root: string
  fields: Record<string, unknown>
  /** The body, which is the template the arguments are filled into. */
  template: string
  bytes: number
  /** Why this one cannot be trusted to round-trip, when that is the case. */
  problem?: string
}

export type CommandDraft = {
  name: string
  scope: CommandScope
  fields: Record<string, unknown>
  template: string
}

/** The folder names the engine looks in, in the order it looks. */
export const FOLDERS = ["command", "commands"] as const

/** A name that is a path of file-name parts: no climbing, no absolute path, no surprises. */
export const COMMAND_NAME = /^[a-z0-9][a-z0-9._/-]*$/i

export class CommandError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "CommandError"
  }
}

/** Every place a command file would be read from, global first, nearest project folder last. */
export function commandRoots(directory?: string, projectDirectory?: string) {
  const roots: Array<{ path: string; scope: CommandScope }> = [{ path: configDirectory(), scope: "global" }]
  if (directory) {
    const stop = projectDirectory ?? directory
    if (isInside(directory, stop)) {
      for (const folder of walkUp(directory, stop)) roots.push({ path: join(folder, ".opencode"), scope: "project" })
    } else {
      roots.push({ path: join(directory, ".opencode"), scope: "project" })
    }
  }
  return roots
}

const describe = (path: string, root: string, scope: CommandScope, folder: string): CommandFile | undefined => {
  let text: string
  let bytes = 0
  try {
    text = readFileSync(path, "utf8")
    bytes = statSync(path).size
  } catch {
    return undefined
  }
  const { fields, prompt, problem } = parseFrontmatter(text)
  const name = relative(join(root, folder), path).replaceAll("\\", "/").replace(/\.md$/, "")
  return {
    name,
    path,
    scope,
    root,
    fields,
    template: prompt,
    bytes,
    ...(problem ? { problem } : {}),
  }
}

const markdownIn = (folder: string): string[] => {
  if (!existsSync(folder)) return []
  const out: string[] = []
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) out.push(...markdownIn(path))
    else if (entry.name.endsWith(".md")) out.push(path)
  }
  return out.sort()
}

/**
 * The command files that would be read for this folder, nearest last, the way the engine reads
 * them: a project command with the same name as a global one is the one that wins.
 */
export function listCommandFiles(directory?: string, projectDirectory?: string): CommandFile[] {
  const found: CommandFile[] = []
  const seen = new Set<string>()
  for (const root of commandRoots(directory, projectDirectory)) {
    for (const folder of FOLDERS) {
      for (const path of markdownIn(join(root.path, folder))) {
        if (seen.has(path)) continue
        seen.add(path)
        const file = describe(path, root.path, root.scope, folder)
        if (file) found.push(file)
      }
    }
  }
  return found
}

/** Where a new command of this scope would be written for this folder. */
export function rootFor(scope: CommandScope, directory?: string, projectDirectory?: string) {
  const roots = commandRoots(directory, projectDirectory)
  const match = scope === "global" ? roots.find((root) => root.scope === "global") : roots.at(-1)
  if (!match || match.scope !== scope) {
    throw new CommandError("There is no folder to write a project command into: open a project first")
  }
  return match.path
}

/** The file a draft would be written to, checked to be inside the folder it claims. */
export function pathFor(
  draft: Pick<CommandDraft, "name" | "scope">,
  directory?: string,
  projectDirectory?: string,
) {
  if (!COMMAND_NAME.test(draft.name) || draft.name.includes("..")) {
    throw new CommandError("A name can only be letters, numbers, dots, dashes, slashes and underscores")
  }
  const root = rootFor(draft.scope, directory, projectDirectory)
  const folder = join(root, "command")
  const path = resolve(folder, `${draft.name}.md`)
  // The name arrives from a browser. The check above refuses an escape, and this refuses everything
  // else: a file is only ever written inside the folder this said it would be written in.
  if (!(path.startsWith(folder + sep) || dirname(path) === folder)) {
    throw new CommandError("That name would write outside the command folder")
  }
  return path
}

export function writeCommandFile(draft: CommandDraft, directory?: string, projectDirectory?: string) {
  const path = pathFor(draft, directory, projectDirectory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serialiseFrontmatter({ fields: draft.fields, prompt: draft.template }))
  return path
}

/** Deletes one, and only one this listing named. A path from a browser is not a path to obey. */
export function deleteCommandFile(path: string, directory?: string, projectDirectory?: string) {
  const known = listCommandFiles(directory, projectDirectory).some((file) => file.path === path)
  if (!known) throw new CommandError("That is not a command file this project knows about", 404)
  rmSync(path)
}
