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

/**
 * system-prompt: the Context screen promises to show what a turn was given, and the assembled system
 * prompt is the part of it no endpoint reports — the engine builds it at request time from the agent,
 * the environment, the instruction files, the skills and the MCP instructions. The plugin records
 * each request's own copy as the engine hands it to the provider, which is the only exact source.
 *
 * Written as the legacy plugin the docs show — one exported function returning hooks — because that
 * is the hook the runner FlupCode drives uses. OpenCode's other plugin loader reads the same folder
 * and ignores a shape it does not know, so the two live side by side.
 */
export const SYSTEM_PROMPT_PLUGIN = {
  file: "flupcode-system-prompt.js",
  source: `// Installed by FlupCode. Records the system prompt the engine assembles for each request, so the
// Context screen can show what a turn was actually given. Regenerated when FlupCode starts the
// engine; edits here are overwritten.
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with systemPromptsDirectory() in packages/harness-server/src/context.ts, which reads
// these back. One recording per request, so two requests at once cannot lose each other's.
function directory() {
  if (process.env.FLUPCODE_SYSTEM_PROMPTS_DIR) return process.env.FLUPCODE_SYSTEM_PROMPTS_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "system-prompts")
}

// A session keeps its newest few: a turn, its title, a compaction and a continuation are all requests.
const KEEP = 6

async function prune(folder) {
  const files = (await readdir(folder)).filter((file) => file.endsWith(".json")).sort()
  const old = files.slice(0, Math.max(0, files.length - KEEP))
  for (const file of old) await unlink(path.join(folder, file)).catch(() => {})
}

async function record(sessionID, system, model) {
  // The id names a folder, so anything that is not an engine-shaped id is refused rather than written.
  if (!sessionID || !/^[A-Za-z0-9_-]+$/.test(sessionID)) return
  const folder = path.join(directory(), sessionID)
  await mkdir(folder, { recursive: true })
  const at = Date.now()
  const name = at + "-" + Math.random().toString(36).slice(2, 8) + ".json"
  await writeFile(
    path.join(folder, name),
    JSON.stringify({ at, providerID: model && model.providerID, modelID: model && model.id, system }),
  )
  await prune(folder)
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
export const flupcodeSystemPrompt = async () => ({
  "experimental.chat.system.transform": async ({ sessionID, model }, { system }) => {
    await record(sessionID, system, model).catch(() => {})
  },
})
`,
}

/** The engine plugins FlupCode owns, in install order. */
const PLUGINS = [REASONING_VARIANTS_PLUGIN, SYSTEM_PROMPT_PLUGIN]

/** OpenCode's global config folder: OPENCODE_CONFIG_DIR, else `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`. */
export function engineConfigDir(env: NodeJS.ProcessEnv = process.env, home = os.homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "opencode")
}

/**
 * Writes FlupCode's engine plugins when missing or outdated. Takes effect the next time the engine
 * starts, so call it before starting one. Never throws: without them the effort menu is only empty
 * and the Context screen only says nothing was captured.
 */
export async function installEnginePlugins(configDir = engineConfigDir()) {
  const dir = path.join(configDir, "plugins")
  const paths: string[] = []
  let changed = false
  let error: string | undefined
  for (const plugin of PLUGINS) {
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
