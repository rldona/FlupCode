import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CACHE_SELECTION_SOURCE } from "./cache-selection-source"
import { PLUGINS_V2 } from "./engine-plugins-v2"

export { CACHE_SELECTION_SOURCE }

/** Earlier file names of the same plugin, removed so it never loads twice. */
const REPLACED_FILES = ["reasoning-variants.ts", "reasoning-variants.js"]

/** OpenCode's global config folder: OPENCODE_CONFIG_DIR, else `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. */
export function engineConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

/**
 * Writes FlupCode's OpenCode 2 plugins (`engine-plugins-v2.ts`) into the engine's global config
 * folder when missing or outdated, so they load for every project. Takes effect the next time the
 * engine starts, so call it before starting one. Never throws: without them the effort menu is only
 * empty and the Context screen only says nothing was captured.
 *
 * A folder 1.x FlupCode wrote holds the 1.x plugins under the same file names, so they are
 * overwritten here rather than left for 2.x to refuse.
 */
export async function installEnginePlugins(configDir = engineConfigDir()) {
  const dir = path.join(configDir, "plugins")
  const paths: string[] = []
  let changed = false
  let error: string | undefined
  for (const plugin of PLUGINS_V2) {
    const target = path.join(dir, plugin.file)
    try {
      const current = await readFile(target, "utf8").catch(() => undefined)
      if (current !== plugin.source) {
        await mkdir(dir, { recursive: true })
        await writeFile(target, plugin.source)
        changed = true
      }
      paths.push(target)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }
  await Promise.all(REPLACED_FILES.map((file) => rm(path.join(dir, file), { force: true }).catch(() => {})))
  return { paths, changed, ...(error ? { error } : {}) }
}
