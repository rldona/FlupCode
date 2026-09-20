/**
 * Agents you can edit (H-13).
 *
 * An agent is a markdown file: YAML frontmatter for how it runs, the body for what it is told. The
 * harness could show them and could not change them, so configuring one meant leaving for an editor
 * and knowing which keys the engine reads.
 *
 * **Where they live is the engine's rule, read from `core/src/config.ts` and
 * `core/src/config/plugin/agent.ts` rather than guessed:** `agent/**\/*.md` (and `agents`, `mode`,
 * `modes`) inside the global config directory, and inside every `.opencode` from the session's
 * folder up to the project root. The name is the path under that folder with the extension dropped.
 *
 * **Which dialect is written is not a free choice.** The engine decides by the keys it finds: a
 * frontmatter using only `model`, `variant`, `request`, `system`, `description`, `mode`, `hidden`,
 * `color`, `steps`, `disabled` and `permissions` is read as v2, and anything else — `tools`,
 * `temperature`, `permission` — puts the whole file through the v1 decoder. This writes v1, because
 * that is what the agent files already in this repository use and what the form needs `tools` for.
 * Mixing them in one file would silently change how every other key in it is read.
 *
 * Keys nobody here understands are kept exactly as they were found. A file is somebody's, and an
 * editor that drops what it does not recognise is an editor that eats work.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, sep } from "node:path"
import { configDirectory, isInside, walkUp } from "./context"
import { parseFrontmatter, serialiseFrontmatter } from "./frontmatter"

export type AgentScope = "global" | "project"

export type AgentFile = {
  /** What the engine calls it: the path under the agent folder, without `.md`. */
  name: string
  path: string
  scope: AgentScope
  /** The folder this file was found under, which is where a sibling would be written. */
  root: string
  fields: Record<string, unknown>
  prompt: string
  bytes: number
  /** Why this one cannot be trusted to round-trip, when that is the case. */
  problem?: string
}

export type AgentDraft = {
  name: string
  scope: AgentScope
  fields: Record<string, unknown>
  prompt: string
}

/** The folder names the engine looks in, in the order it looks. */
const FOLDERS = ["agent", "agents", "mode", "modes"] as const

/** A name that is a file name and nothing else: no folders, no climbing out, no surprises. */
export const NAME = /^[a-z0-9][a-z0-9._-]*$/i

export class AgentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "AgentError"
  }
}

/** Every place an agent file would be read from, global first, nearest project folder last. */
export function agentRoots(directory?: string, projectDirectory?: string) {
  const roots: Array<{ path: string; scope: AgentScope }> = [{ path: configDirectory(), scope: "global" }]
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

/** Frontmatter, shared with the skill catalogue (H-27). Re-exported under the names H-13 used. */
export const parseAgentFile = parseFrontmatter
export const serialiseAgentFile = serialiseFrontmatter

const describe = (path: string, root: string, scope: AgentScope, folder: string): AgentFile | undefined => {
  let text: string
  let bytes = 0
  try {
    text = readFileSync(path, "utf8")
    bytes = statSync(path).size
  } catch {
    return undefined
  }
  const { fields, prompt, problem } = parseAgentFile(text)
  const name = relative(join(root, folder), path).replaceAll("\\", "/").replace(/\.md$/, "")
  return {
    name,
    path,
    scope,
    root,
    fields,
    prompt,
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
 * The agent files that would be read for this folder.
 *
 * Nearest last, the way the engine reads them, so a project agent with the same name as a global one
 * is the one that wins — and the list says so instead of showing two rows that disagree.
 */
export function listAgentFiles(directory?: string, projectDirectory?: string): AgentFile[] {
  const found: AgentFile[] = []
  const seen = new Set<string>()
  for (const root of agentRoots(directory, projectDirectory)) {
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

/** Where a new agent of this scope would be written for this folder. */
export function rootFor(scope: AgentScope, directory?: string, projectDirectory?: string) {
  const roots = agentRoots(directory, projectDirectory)
  const match = scope === "global" ? roots.find((root) => root.scope === "global") : roots.at(-1)
  if (!match || match.scope !== scope) {
    throw new AgentError("There is no folder to write a project agent into: open a project first")
  }
  return match.path
}

/** The file a draft would be written to, checked to be inside the folder it claims. */
export function pathFor(draft: Pick<AgentDraft, "name" | "scope">, directory?: string, projectDirectory?: string) {
  if (!NAME.test(draft.name)) {
    throw new AgentError("A name can only be letters, numbers, dots, dashes and underscores")
  }
  const root = rootFor(draft.scope, directory, projectDirectory)
  const folder = join(root, "agent")
  const path = resolve(folder, `${draft.name}.md`)
  // The name arrives from a browser. `NAME` already refuses a slash, and this refuses everything
  // else: a file is only ever written inside the folder this said it would be written in.
  if (!(path.startsWith(folder + sep) || dirname(path) === folder)) {
    throw new AgentError("That name would write outside the agent folder")
  }
  return path
}

export function writeAgentFile(draft: AgentDraft, directory?: string, projectDirectory?: string) {
  const path = pathFor(draft, directory, projectDirectory)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, serialiseAgentFile({ fields: draft.fields, prompt: draft.prompt }))
  return path
}

/** Deletes one, and only one this listing named. A path from a browser is not a path to obey. */
export function deleteAgentFile(path: string, directory?: string, projectDirectory?: string) {
  const known = listAgentFiles(directory, projectDirectory).some((file) => file.path === path)
  if (!known) throw new AgentError("That is not an agent file this project knows about", 404)
  rmSync(path)
}
