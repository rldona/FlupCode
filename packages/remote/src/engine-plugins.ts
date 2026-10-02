import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CACHE_SELECTION_SOURCE } from "./cache-selection-source"
import { PLUGINS_V2 } from "./engine-plugins-v2"

export { CACHE_SELECTION_SOURCE }

/** The first line of every plugin file FlupCode has ever written, 1.x and 2.x alike. */
const MARKER = "// Installed by FlupCode"

/** OpenCode's global config folder: OPENCODE_CONFIG_DIR, else `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. */
export function engineConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

/**
 * Where FlupCode keeps its engine plugins (HE-04): its own config folder, never OpenCode's, so an
 * `opencode` the reader starts themselves never loads them.
 */
export function enginePluginsDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const flupcode = env.FLUPCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "flupcode")
  return path.join(flupcode, "engine-plugins")
}

/**
 * One folder per plugin, its code in `index.js`: 2.x loads a local plugin named in a config from a
 * folder and refuses a path to a file.
 */
export function enginePluginFolders(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  return PLUGINS_V2.map((plugin) => path.join(enginePluginsDir(env, home), plugin.file.replace(/\.js$/, "")))
}

/**
 * The environment that makes an engine FlupCode starts load its plugins: their folders added to the
 * `plugins` of `OPENCODE_CONFIG_CONTENT`, the config layer 2.x merges on top of the reader's own. It
 * is the one way 2.0.18 offers that keeps the reader's global config and plugins loading:
 * `OPENCODE_CONFIG_DIR` replaces the global folder rather than adding to it. `OPENCODE_CONFIG_CONTENT`
 * the reader set is kept and extended; one that is not a JSON object is left as it is, without them.
 */
export function withEnginePlugins(env: NodeJS.ProcessEnv, home = os.homedir()): NodeJS.ProcessEnv {
  const content = configContent(env.OPENCODE_CONFIG_CONTENT)
  if (!content) return env
  const plugins = Array.isArray(content.plugins) ? content.plugins : []
  return {
    ...env,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...content, plugins: [...plugins, ...enginePluginFolders(env, home)] }),
  }
}

/**
 * Writes FlupCode's OpenCode 2 plugins (`engine-plugins-v2.ts`) into FlupCode's own folder when
 * missing or outdated, and removes the copies earlier versions wrote into OpenCode's global
 * `plugins` folder. Takes effect the next time an engine FlupCode starts (`withEnginePlugins`), so
 * call it before starting one. Never throws: without them the effort menu is only empty and the
 * Context screen only says nothing was captured.
 */
export async function installEnginePlugins(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  const paths: string[] = []
  let changed = false
  let error: string | undefined
  for (const [index, folder] of enginePluginFolders(env, home).entries()) {
    const plugin = PLUGINS_V2[index]!
    const target = path.join(folder, "index.js")
    try {
      const current = await readFile(target, "utf8").catch(() => undefined)
      if (current !== plugin.source) {
        await mkdir(folder, { recursive: true })
        await writeFile(target, plugin.source)
        changed = true
      }
      paths.push(target)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
  const removed = await removeGlobalCopies(env, home)
  return { paths, changed, removed, ...(error ? { error } : {}) }
}

/**
 * Earlier versions wrote the plugins into OpenCode's global `plugins` folder, where every `opencode`
 * loaded them. A file there is removed only when it has one of FlupCode's plugin file names and
 * starts with the line FlupCode writes first; anything else in that folder is the reader's own.
 */
async function removeGlobalCopies(env: NodeJS.ProcessEnv, home: string) {
  const folders = [
    ...new Set([engineConfigDir(env, home), engineConfigDir({ XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }, home)]),
  ]
  const candidates = folders.flatMap((folder) => PLUGINS_V2.map((plugin) => path.join(folder, "plugins", plugin.file)))
  const removed = await Promise.all(
    candidates.map(async (file) => {
      const text = await readFile(file, "utf8").catch(() => undefined)
      if (!text?.startsWith(MARKER)) return undefined
      return rm(file, { force: true }).then(
        () => file,
        () => undefined,
      )
    }),
  )
  return removed.filter((file): file is string => file !== undefined)
}

function configContent(text: string | undefined): Record<string, unknown> | undefined {
  if (!text?.trim()) return {}
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}
