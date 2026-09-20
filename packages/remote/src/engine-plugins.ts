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
 * tool-uses: what tools a session ran, and how long each took. The engine names an MCP tool
 * `<server>_<tool>`, and while it never reports which tools a server offers — they bypass the tool
 * registry, so no endpoint lists them — it does hand every call to these hooks, which is enough to
 * say which of them a session used and where its time went (H-16).
 *
 * Every tool goes in, not only the MCP ones: telling them apart needs the server list, which lives on
 * the other side of this file, and a name is a name.
 */
export const TOOL_USES_PLUGIN = {
  file: "flupcode-tool-uses.js",
  source: `// Installed by FlupCode. Records which tools each session ran and how long each took, so the Context
// screen can say which of an MCP server's tools a session used and the supervisor can draw a
// timeline. Regenerated when FlupCode starts the engine; edits here are overwritten.
import { mkdir, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with toolUsesDirectory() in packages/harness-server/src/context.ts, which reads it back.
function directory() {
  if (process.env.FLUPCODE_TOOL_USES_DIR) return process.env.FLUPCODE_TOOL_USES_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "tool-uses")
}

// A step can run several tools at once, and two of them read-modify-writing the same file lose one
// another: the newer write would drop the tool the other just recorded.
const queues = new Map()

// The names are the engine's and its servers'; this is only here so a plugin registering endlessly
// cannot fill the file.
const MOST = 200

// A timeline, not a full history: enough to see where a session spent its time without growing
// without bound on a long one.
const MOST_CALLS = 500

// When each running call started, by the id the engine gave it. Removed when it finishes.
const running = new Map()

function serial(file, work) {
  const tail = queues.get(file) || Promise.resolve()
  const next = tail.then(work, work)
  queues.set(file, next.catch(() => {}))
  return next
}

function load(file) {
  return readFile(file, "utf8").then(JSON.parse).catch(() => ({}))
}

function callsOf(previous) {
  return previous && Array.isArray(previous.calls) ? previous.calls.slice(-MOST_CALLS) : []
}

// The engine hands the same callID to before and after, which is what pairs them up. A session with
// no callID still gets a key, so a solo call is timed; two at once would only share a duration.
function timedKey(sessionID, callID, tool) {
  return sessionID + "|" + (callID || tool) + "|" + tool
}

async function began(sessionID, tool, callID) {
  // The id names a file, so anything that is not an engine-shaped id is refused rather than written.
  if (!sessionID || !/^[A-Za-z0-9_-]+$/.test(sessionID)) return
  if (typeof tool !== "string" || !tool) return
  running.set(timedKey(sessionID, callID, tool), Date.now())
  // A call whose end never arrives must not grow this forever.
  if (running.size > 1000) {
    const oldest = running.keys().next().value
    if (oldest !== undefined) running.delete(oldest)
  }
  const folder = directory()
  const file = path.join(folder, sessionID + ".json")
  await serial(file, async () => {
    const previous = await load(file)
    const tools = previous && previous.tools && typeof previous.tools === "object" ? previous.tools : {}
    const known = tools[tool]
    if (!known && Object.keys(tools).length >= MOST) return
    const count = known && typeof known.count === "number" ? known.count : 0
    tools[tool] = { count: count + 1, last: Date.now() }
    await mkdir(folder, { recursive: true })
    await writeFile(file, JSON.stringify({ at: Date.now(), tools, calls: callsOf(previous) }))
  })
}

async function finished(sessionID, tool, callID) {
  if (!sessionID || !/^[A-Za-z0-9_-]+$/.test(sessionID)) return
  if (typeof tool !== "string" || !tool) return
  const key = timedKey(sessionID, callID, tool)
  const start = running.get(key)
  running.delete(key)
  // Without a start there is nothing to time; the call was already counted by before.
  if (start === undefined) return
  const folder = directory()
  const file = path.join(folder, sessionID + ".json")
  await serial(file, async () => {
    const previous = await load(file)
    const tools = previous && previous.tools && typeof previous.tools === "object" ? previous.tools : {}
    const calls = callsOf(previous)
    calls.push({ tool: tool, start: start, ms: Math.max(0, Date.now() - start) })
    await mkdir(folder, { recursive: true })
    await writeFile(file, JSON.stringify({ at: Date.now(), tools: tools, calls: calls }))
  })
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
export const flupcodeToolUses = async () => ({
  "tool.execute.before": async ({ tool, sessionID, callID }) => {
    await began(sessionID, tool, callID).catch(() => {})
  },
  "tool.execute.after": async ({ tool, sessionID, callID }) => {
    await finished(sessionID, tool, callID).catch(() => {})
  },
})
`,
}

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

// The file name is what orders these, and two requests can land in the same millisecond — a turn and
// the compaction that answers it do. A clock that never goes back keeps them in the order they were
// written, which is what decides which recording is the newest and which one is pruned.
let last = 0
function stamp() {
  const now = Date.now()
  last = now > last ? now : last + 1
  return last
}

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
  const at = stamp()
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

/**
 * artifact-write: the tool that lets the agent keep a document where the Artifacts screen shows it.
 *
 * A document the agent wants kept goes into `.flupcode/artifacts` inside the project — the folder the
 * harness indexes lazily (packages/harness-server/src/documents.ts). Without a tool the model has to
 * know that folder by heart; with it, it says "keep this as report.html" and the file lands where it
 * will be found. Plain JavaScript with no package imports, so it loads before any dependency is
 * installed, exactly like the other ones.
 */
export const ARTIFACT_WRITE_PLUGIN = {
  file: "flupcode-artifact-write.js",
  source: `// Installed by FlupCode. Lets the agent keep a generated document where the Artifacts screen
// indexes it: .flupcode/artifacts inside the project. Regenerated when FlupCode starts the engine;
// edits here are overwritten.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

// The folder must be the one the harness indexes, so both sides name it the same way.
function folderFor(directory) {
  return path.join(directory, ".flupcode", "artifacts")
}

// The name is what the file becomes on disk, so it is reduced to a safe file name: a path a model
// writes must not escape the folder.
function fileName(value) {
  const base = path.basename(String(value || "document.md")).replace(/[^A-Za-z0-9._-]/g, "-")
  return base && base !== "." && base !== ".." ? base : "document.md"
}

export const flupcodeArtifactWrite = async () => ({
  tool: {
    "artifact.write": {
      description:
        "Keep a document you produced (a page, a report, an image note) so the reader finds it under Artifacts. Writes it to .flupcode/artifacts in the project and returns its path.",
      args: {
        title: { type: "string", description: "A short title the reader will see in the Artifacts list." },
        filename: { type: "string", description: "The file name to write, including its extension, e.g. report.html." },
        content: { type: "string", description: "The document itself, in full." },
      },
      async execute(args, context) {
        const directory = context && context.directory
        if (!directory) return "This session has no project folder to keep a document in."
        const name = fileName(args && args.filename)
        const folder = folderFor(directory)
        await mkdir(folder, { recursive: true })
        await writeFile(path.join(folder, name), String((args && args.content) || ""), "utf8")
        return "Kept " + name + " in .flupcode/artifacts. It appears under Artifacts for this project."
      },
    },
  },
})
`,
}

/** The engine plugins FlupCode owns. */
const PLUGINS = [REASONING_VARIANTS_PLUGIN, TOOL_USES_PLUGIN, SYSTEM_PROMPT_PLUGIN, ARTIFACT_WRITE_PLUGIN]

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
