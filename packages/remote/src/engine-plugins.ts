import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * Engine plugins FlupCode installs into OpenCode's global config folder, so they load for every
 * project (a project's `.opencode/plugins` only loads for sessions inside that project).
 *
 * reasoning-variants: OpenCode's v2 model catalog carries no reasoning effort levels for most models,
 * so the effort menu was empty (and a stored level was rejected with VariantUnavailableError). The
 * plugin adds each model's effort levels from the models.dev data the engine already caches. It is
 * plain JavaScript with no imports, so it loads before the engine has installed any dependency.
 */
export const REASONING_VARIANTS_PLUGIN = {
  file: "flupcode-reasoning-variants.js",
  source: `// Installed by FlupCode. Adds reasoning effort levels to OpenCode's model catalog.
// Regenerated when FlupCode starts the engine; edits here are overwritten.
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

function cachePath() {
  if (process.env.OPENCODE_MODELS_PATH) return process.env.OPENCODE_MODELS_PATH
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache")
  return path.join(base, "opencode", "models.json")
}

async function loadModelsDev() {
  const text = await readFile(cachePath(), "utf8").catch(() => "{}")
  try {
    return JSON.parse(text) || {}
  } catch {
    return {}
  }
}

function efforts(model) {
  const option = ((model && model.reasoning_options) || []).find((item) => item.type === "effort")
  if (!option) return []
  return option.values.filter((value) => typeof value === "string")
}

// Each protocol takes the effort in a different request body field.
function variantBody(pkg, effort) {
  if (pkg === "@ai-sdk/openai")
    return effort === "none"
      ? { reasoning: { effort } }
      : { reasoning: { effort }, include: ["reasoning.encrypted_content"] }
  if (pkg === "@ai-sdk/openai-compatible") return { reasoning_effort: effort }
  return undefined
}

export default {
  id: "flupcode-reasoning-variants",
  setup: async (ctx) => {
    let data
    await ctx.catalog.transform(async (catalog) => {
      data = data || (await loadModelsDev())
      for (const record of catalog.provider.list()) {
        const provider = data[record.provider.id]
        if (!provider || !provider.models) continue
        for (const model of record.models.values()) {
          const pkg =
            model.api.type === "aisdk"
              ? model.api.package
              : record.provider.api.type === "aisdk"
                ? record.provider.api.package
                : undefined
          for (const effort of efforts(provider.models[model.id])) {
            if (model.variants.some((variant) => variant.id === effort)) continue
            const body = variantBody(pkg, effort)
            if (body) model.variants.push({ id: effort, headers: {}, body })
          }
        }
      }
    })
  },
}
`,
}

/** Earlier file names of the same plugin, removed so it never loads twice. */
const REPLACED_FILES = ["reasoning-variants.ts", "reasoning-variants.js"]

/** OpenCode's global config folder: OPENCODE_CONFIG_DIR, else `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. */
export function engineConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

/**
 * Writes FlupCode's engine plugins when missing or outdated. Takes effect the next time the engine
 * starts, so call it before starting one. Never throws: without the plugin the effort menu is only empty.
 */
export async function installEnginePlugins(configDir = engineConfigDir()) {
  const dir = path.join(configDir, "plugins")
  const target = path.join(dir, REASONING_VARIANTS_PLUGIN.file)
  try {
    const current = await readFile(target, "utf8").catch(() => undefined)
    const changed = current !== REASONING_VARIANTS_PLUGIN.source
    if (changed) {
      await mkdir(dir, { recursive: true })
      await writeFile(target, REASONING_VARIANTS_PLUGIN.source)
    }
    await Promise.all(REPLACED_FILES.map((file) => rm(path.join(dir, file), { force: true })))
    return { path: target, changed }
  } catch (error) {
    return { path: target, changed: false, error: error instanceof Error ? error.message : String(error) }
  }
}
