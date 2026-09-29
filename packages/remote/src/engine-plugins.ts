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
// timeline. It also keeps the evidence a call left — a shell's command, exit code and a bounded tail
// of its output, and the paths an edit touched — for an episode to say what changed and what failed.
// Regenerated when FlupCode starts the engine; edits here are overwritten.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with toolUsesDirectory() in packages/harness-server/src/context.ts, which reads it back.
function directory() {
  if (process.env.FLUPCODE_TOOL_USES_DIR) return process.env.FLUPCODE_TOOL_USES_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "tool-uses")
}

// Kept in step with episodeSignalsDirectory() in packages/harness-server/src/adaptive/signals.ts.
function signalsDirectory() {
  if (process.env.FLUPCODE_EPISODE_SIGNALS_DIR) return process.env.FLUPCODE_EPISODE_SIGNALS_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "episode-signals")
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

// Evidence is a smaller history than the timeline, and the newest calls are what a reader wants.
const MOST_SIGNALS = 200
const OUT_LIMIT = 4096
const COMMAND_LIMIT = 500
const PATHS_PER_CALL = 20
const PATH_LIMIT = 1000

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

// What one finished call left behind, or nothing when it left no evidence. A read or a grep says
// nothing an episode can act on, so they do not grow the ring.
function signalEntry(tool, input, output, start) {
  const args = input && input.args && typeof input.args === "object" ? input.args : {}
  const metadata = output && output.metadata && typeof output.metadata === "object" ? output.metadata : {}
  const entry = { tool: tool, ok: true, paths: [] }
  if (start !== undefined) entry.start = start
  if (start !== undefined) entry.ms = Math.max(0, Date.now() - start)
  const text = output && typeof output.output === "string" ? output.output : undefined

  if (tool === "bash") {
    if (typeof args.command === "string" && args.command) entry.command = args.command.slice(0, COMMAND_LIMIT)
    if (typeof metadata.exit === "number") entry.exit = metadata.exit
    if (text) {
      entry.out = text.length > OUT_LIMIT ? text.slice(-OUT_LIMIT) : text
      if (text.length > OUT_LIMIT) entry.truncated = true
    }
  } else if (tool === "edit" || tool === "write") {
    if (typeof args.filePath === "string" && args.filePath) entry.paths = [args.filePath.slice(0, PATH_LIMIT)]
  } else if (tool === "apply_patch") {
    const files = Array.isArray(metadata.files) ? metadata.files : []
    entry.paths = files
      .map((file) => (file && typeof file.relativePath === "string" ? file.relativePath.slice(0, PATH_LIMIT) : undefined))
      .filter((file) => file)
      .slice(0, PATHS_PER_CALL)
  }

  // The task tool is the one hook that fires even on failure, and it does so with no output: the only
  // observable sign that a call did not succeed. A real error event is FH-004.
  if (tool === "task" && output === undefined) entry.ok = false

  const hasEvidence =
    entry.command !== undefined ||
    entry.exit !== undefined ||
    entry.out !== undefined ||
    entry.paths.length > 0 ||
    entry.ok === false
  return hasEvidence ? entry : undefined
}

// Atomic: a reader never sees half the file. The temp suffix keeps it out of the reader's path. The
// signal carries a shell's output and command, so it is written user-only (0600) and the rename
// keeps that mode.
async function storeSignals(target, data) {
  const temp = target + ".tmp-" + process.pid + "-" + Date.now()
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
  try {
    await rename(temp, target)
  } catch (cause) {
    // A failed rename must not leave the temp behind: an unwritable target would otherwise collect
    // one .tmp file per call.
    await rm(temp, { force: true }).catch(() => {})
    throw cause
  }
}

async function recordSignal(sessionID, entry) {
  const folder = signalsDirectory()
  const file = path.join(folder, sessionID + ".json")
  await serial(file, async () => {
    const previous = await load(file)
    const calls = previous && Array.isArray(previous.calls) ? previous.calls.slice(-MOST_SIGNALS) : []
    calls.push(entry)
    // The signals folder holds shell output and commands, so it stays user-only. mkdir does not
    // change the mode of an existing folder, hence the best-effort chmod.
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o700).catch(() => {})
    await storeSignals(file, { at: Date.now(), calls: calls.slice(-MOST_SIGNALS) })
  })
}

async function finished(sessionID, tool, callID, input, output) {
  if (!sessionID || !/^[A-Za-z0-9_-]+$/.test(sessionID)) return
  if (typeof tool !== "string" || !tool) return
  const key = timedKey(sessionID, callID, tool)
  const start = running.get(key)
  running.delete(key)

  // Evidence is its own file, tied to the same call: a failed write must not stop the timeline, and
  // an after with no matching before still records what it saw, only with no times.
  const entry = signalEntry(tool, input, output, start)
  if (entry) await recordSignal(sessionID, entry).catch(() => {})

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
  "tool.execute.after": async (input, output) => {
    await finished(input && input.sessionID, input && input.tool, input && input.callID, input, output).catch(() => {})
  },
})
`,
}

/**
 * runtime-probe: a canary the harness reads to tell which runtime the engine is on, with positive
 * evidence rather than a version guess (FH-000). It stamps a boot token, `pid` and `loadedAt` once
 * per engine process, records `hookAt` when the legacy `experimental.chat.system.transform` hook
 * fires, and `v2At` when a turn event of the V2 runner is observed. A restart changes the token,
 * resets `loadedAt` and clears the marks, so a migration to V2 is never read as residual `legacy`,
 * and a pid the OS reused cannot pass as the current process.
 *
 * Every write is serialized and atomic (temp file plus rename), and nothing here throws: a canary
 * that cannot be written simply leaves no evidence, which the probe degrades to `unknown`.
 */
export const RUNTIME_PROBE_PLUGIN = {
  file: "flupcode-runtime-probe.js",
  source: `// Installed by FlupCode. Writes the runtime probe canary the harness reads to tell which runtime
// the engine is on. Regenerated when FlupCode starts the engine; edits here are overwritten.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with runtimeProbeFilePath() in packages/harness-server/src/adaptive/runtime.ts.
function filePath() {
  if (process.env.FLUPCODE_RUNTIME_PROBE_FILE) return process.env.FLUPCODE_RUNTIME_PROBE_FILE
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "runtime-probe.json")
}

// A hook and an event can fire at once; two read-modify-writes of the same file would lose one.
let tail = Promise.resolve()

function serial(work) {
  const next = tail.then(work, work)
  tail = next.catch(() => {})
  return next
}

function load(target) {
  return readFile(target, "utf8").then(JSON.parse).catch(() => ({}))
}

// Atomic: a reader never sees half a canary. The temp suffix keeps it out of the reader's path.
async function store(data) {
  const target = filePath()
  await mkdir(path.dirname(target), { recursive: true })
  const temp = target + ".tmp-" + process.pid + "-" + Date.now()
  await writeFile(temp, JSON.stringify(data))
  try {
    await rename(temp, target)
  } catch (cause) {
    // A failed rename must not leave the temp behind: an unwritable target would otherwise collect
    // one .tmp file per call. Nothing here throws toward the engine; the caller swallows it.
    await rm(temp, { force: true }).catch(() => {})
    throw cause
  }
}

// A pid alone is not proof of a new process: the operating system reuses them, so a reused pid would
// find the previous boot's mark already in place and keep its loadedAt and its hook evidence. The
// token carries the process start too, so only the process that wrote the canary ever rewrites it.
function stamp(boot) {
  return serial(async () => {
    const previous = await load(filePath())
    if (previous && previous.token === boot) return
    await store({ token: boot, pid: process.pid, loadedAt: Date.now(), hookAt: 0, v2At: 0, event: null })
  })
}

function markHook(boot) {
  return serial(async () => {
    const previous = await load(filePath())
    // A token from another process means the canary is not this process's to mark: writing would mix
    // one engine's evidence into another's. The probe reads it as unreadable rather than legacy.
    if (!previous || previous.token !== boot) return
    await store({ ...previous, hookAt: Date.now(), hook: "experimental.chat.system.transform" })
  })
}

// A turn event is the V2 runner's own signal; anything else is not evidence about the runtime.
const TURN_EVENTS = ["session.next.prompted", "session.next.step.started", "session.next.text.started"]

function markEvent(event, boot) {
  const type = event && event.type
  if (!TURN_EVENTS.includes(type)) return Promise.resolve()
  return serial(async () => {
    const previous = await load(filePath())
    if (!previous || previous.token !== boot) return
    await store({ ...previous, v2At: Date.now(), event: type })
  })
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
// The boot token is the process identity the classifier demands; a pid is reused by the OS, so it is
// not proof by itself. It is computed on the first factory call and kept, so every call and every
// reload of this module in the same process keeps the same token.
let boot
export const flupcodeRuntimeProbe = async () => {
  boot = boot || process.pid + ":" + Math.round(Date.now() - process.uptime() * 1000)
  await stamp(boot).catch(() => {})
  return {
    "experimental.chat.system.transform": async () => {
      await markHook(boot).catch(() => {})
    },
    event: async ({ event }) => {
      await markEvent(event, boot).catch(() => {})
    },
  }
}
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
    // Providers with an OpenAI-shaped API reject a function name that is not
    // \`^[a-zA-Z0-9_-]+$\`, so the name cannot carry a dot.
    artifact_write: {
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

/**
 * delivery: one tool per profile declared under `flupcode.delivery`. The profile carries the tool id,
 * the description, the labels, the composed-image rules and the guards, so a new product needs
 * configuration alone and no per-product tool file. Guards are modules in the reader's own config
 * directory; the plugin imports them and runs them in order before delivering anything.
 *
 * Unlike the other plugins this one imports `@opencode-ai/plugin` for its Zod args, which the engine
 * installs into the config directory and waits for before loading. That is what lets optional
 * arguments stay optional instead of being marked required.
 */
export const DELIVERY_PLUGIN = {
  file: "flupcode-deliver.js",
  source: String.raw`// Installed by FlupCode. Registers one delivery tool per profile declared under flupcode.delivery,
// so a new product needs only configuration and no tool file of its own: the tool id, the
// description, the labels, the composed-image rules and the guards all come from the config folder.
// Product names live there, never here. Regenerated when FlupCode starts the engine; edits here are
// overwritten.
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tool } from "@opencode-ai/plugin"

// The plugin sits in <configDir>/plugins, so its parent is the config directory. Both the config
// files and the guards are named against it: that is where the plugin actually lives and where
// install.sh symlinks lib/, so the two can never disagree about which directory is the reader's.
const CONFIG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// JSONC without a parser: comments and trailing commas are all that separates it from JSON. The scan
// is string-aware, so a URL keeps its double slash and a string keeps whatever looks like a comment.
function stripJsonc(text) {
  let out = ""
  let inString = false
  let escape = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
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

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The engine merges config.json, then opencode.json, then opencode.jsonc, later files winning; the
// same order here, recursively, so a profile the advanced editor wrote to jsonc is still seen and
// jsonc wins. Arrays replace rather than concatenate: a profile list is the file's whole list.
function mergeConfig(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source
  const merged = { ...target }
  for (const key of Object.keys(source)) {
    merged[key] =
      isPlainObject(target[key]) && isPlainObject(source[key])
        ? mergeConfig(target[key], source[key])
        : source[key]
  }
  return merged
}

const CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"]

// A missing file is skipped, and one that does not parse is skipped too: loading never throws.
async function readJsonc(file) {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(stripJsonc(text))
  } catch {
    return undefined
  }
}

async function loadConfig() {
  let merged = {}
  for (const name of CONFIG_FILES) {
    const parsed = await readJsonc(path.join(CONFIG_DIR, name))
    if (isPlainObject(parsed)) merged = mergeConfig(merged, parsed)
  }
  return merged
}

function propertyAt(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

// The composed PNG is not a part of its own: it stays inside the state of the tool that produced it,
// so the newest one is looked for there, last-first, and only when its producer is in composeTools.
function findImageDataUrl(messages, composeTools) {
  if (!Array.isArray(messages)) return undefined
  const wanted = Array.isArray(composeTools) && composeTools.length ? composeTools : undefined
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    const parts = message && message.parts
    if (!Array.isArray(parts)) continue
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]
      if (!part) continue
      if (wanted && typeof part.tool === "string" && !wanted.includes(part.tool)) continue
      const bags = [part.state && part.state.attachments, part.attachments]
      for (const bag of bags) {
        if (!Array.isArray(bag)) continue
        for (let a = bag.length - 1; a >= 0; a--) {
          const attachment = bag[a]
          if (!attachment) continue
          if (
            typeof attachment.mime === "string" &&
            attachment.mime.startsWith("image/") &&
            typeof attachment.url === "string" &&
            attachment.url.startsWith("data:")
          ) {
            return attachment.url
          }
        }
      }
    }
  }
  return undefined
}

function imageAttachment(dataUrl) {
  const match = /^data:([^;,]+);base64,/.exec(dataUrl)
  const mime = match && match[1]
  if (!mime || !mime.startsWith("image/")) return undefined
  return { type: "file", mime: mime, url: dataUrl }
}

// Guards are modules the product owns, resolved against the config directory. Every module's guards
// array is appended in turn, and the first refusal stops the delivery. A safety gate must not
// disappear silently: a module that cannot be loaded or one whose assess throws refuses the delivery.
async function runGuards(paths, input) {
  if (!Array.isArray(paths)) return undefined
  const guards = []
  for (const entry of paths) {
    if (typeof entry !== "string" || !entry) continue
    const url = pathToFileURL(path.resolve(CONFIG_DIR, entry)).href
    let mod
    try {
      mod = await import(url)
    } catch {
      return "No se entrega. GUARD_LOAD_ERROR: " + entry
    }
    const list = mod && mod.guards
    if (!Array.isArray(list)) return "No se entrega. GUARD_LOAD_ERROR: " + entry
    guards.push(...list)
  }
  for (const guard of guards) {
    if (!guard || typeof guard.assess !== "function") continue
    let verdict
    try {
      verdict = await guard.assess(input)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      return "No se entrega. GUARD_ERROR: " + String(guard.id) + " - " + message
    }
    if (verdict && verdict.allow === false) {
      return "No se entrega. " + String(verdict.code) + ": " + String(verdict.reason)
    }
  }
  return undefined
}

function definition(profile) {
  return tool({
    description:
      profile.description ||
      "Deliver the piece you have just written and composed so a person can copy and paste it by hand. Does not publish anything: it re-emits the composed image as an attachment.",
    args: {
      text: tool.schema.string().describe("The exact text of the piece, as it is copied."),
      template: tool.schema.string().describe("The template that was composed."),
      alt: tool.schema.string().optional().describe("The image alt text, when there is one."),
      location: tool.schema.string().optional().describe("The place the piece is about, when the guards need it."),
    },
    async execute(args, ctx) {
      const messages = propertyAt(ctx, "messages")
      const denied = await runGuards(profile.guards, {
        text: args.text,
        template: args.template,
        alt: args.alt,
        location: args.location,
        messages: messages,
      })
      if (denied) return denied

      const imageDataUrl = findImageDataUrl(messages, profile.composeTools)
      if (!imageDataUrl && profile.imageRequired !== false) {
        return (
          profile.imageMissing ||
          "I cannot find the composed image in this conversation. Compose it first and try again."
        )
      }
      const attachment = imageDataUrl ? imageAttachment(imageDataUrl) : undefined
      const labels = profile.labels || {}
      const alt = args.alt || ""
      const lines = [
        labels.title || "Ready to copy and paste. Nothing was published.",
        "",
        labels.text || "Text:",
        args.text,
        "",
        alt ? (labels.alt || "Image alt:") + "\n" + alt : labels.missingAlt || "The image has no alt.",
      ]
      if (attachment) lines.push("", labels.image || "The image goes with the piece, below: copy them together.")
      const output = lines.join("\n")
      const sessionID = propertyAt(ctx, "sessionID")
      const messageID = propertyAt(ctx, "messageID")
      if (!attachment || typeof sessionID !== "string" || typeof messageID !== "string") return output
      return {
        output: output,
        attachments: [{ id: "prt_" + randomUUID(), sessionID, messageID, ...attachment }],
      }
    },
  })
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
export const flupcodeDeliver = async () => {
  const config = await loadConfig().catch(() => undefined)
  const profiles = config && config.flupcode && config.flupcode.delivery
  if (!profiles || typeof profiles !== "object") return {}
  const tools = {}
  for (const profile of Object.values(profiles)) {
    if (!profile || typeof profile !== "object") continue
    if (typeof profile.tool !== "string" || !profile.tool) continue
    tools[profile.tool] = definition(profile)
  }
  return { tool: tools }
}
`,
}

/**
 * web-actions: one browser-action tool per profile the harness accepts. The plugin is a thin proxy:
 * it asks `harness-server` for the profiles under `flupcode.actions`, registers a tool for each and,
 * when the model calls one, asks for approval once and forwards the whole recipe to the runner. It
 * holds no browser state, no selectors and no credentials.
 *
 * Plain JavaScript with no third-party imports, like the other plugins, and its args are plain JSON
 * Schema rather than Zod: the registry marks every declared input required, which is what the runner
 * expects. The loopback token and the profiles both live outside the engine, so the desktop starts
 * the harness first (see `ensureHarnessServer`).
 */
export const WEB_ACTIONS_PLUGIN = {
  file: "flupcode-actions.js",
  source: String.raw`// Installed by FlupCode. Registers one browser-action tool per profile under "flupcode.actions", so
// a new site action needs only configuration and no tool file of its own. It is a thin proxy over the
// harness runner: it holds no browser state, no selectors and no credentials. Regenerated when
// FlupCode starts the engine; edits here are overwritten.
import { randomUUID } from "node:crypto"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The plugin sits in <configDir>/plugins, so its parent is the config directory the engine loads
// config.json / opencode.json / opencode.jsonc from.
const CONFIG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// The profiles endpoint is the loopback harness the desktop spawns. It is asked briefly when the
// engine loads: a slow or absent server must not hold startup, so a timeout is retried a couple of
// times and then the plugin simply registers nothing.
const PROFILE_TIMEOUT_MS = 1200
const PROFILE_ATTEMPTS = 3
const PROFILE_DELAY_MS = 400

// One action can drive a whole recipe, so the run gets a long ceiling; the evidence fetch is a single
// image and stays short. An attachment travels inside the conversation, so a runaway one is dropped.
const RUN_TIMEOUT_MS = 600000
const ARTIFACT_TIMEOUT_MS = 15000
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
// Only raster images travel back as an attachment: an SVG is a document that can carry script, and a
// generic image/* would let the runner choose the type.
const ATTACHMENT_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"])
// A runaway recipe could list many artifacts; only the tail is worth probing for a frame.
const EVIDENCE_SCAN = 5
// The same shape validateActionProfile enforces: a wider id would widen the approval resource.
const PROFILE_ID = /^[A-Za-z0-9_-]{1,64}$/

// The token the harness issued for this machine, and the base it answers on, are fixed when the
// plugin loads and shared by every tool it registers.
let activeToken
let activeBase

// JSONC without a parser: comments and trailing commas are all that separates it from JSON. The scan
// is string-aware, so a URL keeps its double slash and a string keeps whatever looks like a comment.
function stripJsonc(text) {
  let out = ""
  let inString = false
  let escape = false
  let i = 0
  while (i < text.length) {
    const ch = text[i]
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

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// The engine merges config.json, then opencode.json, then opencode.jsonc, later files winning; the
// same order here, recursively, so the flupcode.composeTools setting is seen wherever it was written.
function mergeConfig(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return source
  const merged = { ...target }
  for (const key of Object.keys(source)) {
    merged[key] =
      isPlainObject(target[key]) && isPlainObject(source[key])
        ? mergeConfig(target[key], source[key])
        : source[key]
  }
  return merged
}

const CONFIG_FILES = ["config.json", "opencode.json", "opencode.jsonc"]

async function readJsonc(file) {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(stripJsonc(text))
  } catch {
    return undefined
  }
}

async function loadConfig() {
  let merged = {}
  for (const name of CONFIG_FILES) {
    const parsed = await readJsonc(path.join(CONFIG_DIR, name))
    if (isPlainObject(parsed)) merged = mergeConfig(merged, parsed)
  }
  return merged
}

// Same shape the harness uses (packages/harness-server/src/browser-token.ts), read here without
// importing it: the plugin has no package imports.
function flupcodeConfigDir() {
  if (process.env.FLUPCODE_CONFIG_DIR) return process.env.FLUPCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "flupcode")
}

function harnessBaseURL() {
  const raw =
    process.env.FLUPCODE_HARNESS_SERVER_URL ||
    "http://127.0.0.1:" + (process.env.FLUPCODE_HARNESS_PORT || "4097")
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  // The bearer token is only ever sent to the loopback harness: a remote URL would leak it.
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1" && url.hostname !== "localhost")
    return undefined
  return url.origin
}

async function readToken() {
  // The desktop hands the engine it starts the token both sides compare (WA-6); a file only exists
  // when the harness wrote one on its own, so the environment wins and the file is the fallback.
  const fromEnv = typeof process !== "undefined" && process.env ? process.env.FLUPCODE_BROWSER_TOKEN : undefined
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") return fromEnv.trim()
  const text = await readFile(path.join(flupcodeConfigDir(), "browser-token"), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const token = text.trim()
  return token === "" ? undefined : token
}

function propertyAt(value, key) {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

// The composed PNG is not a part of its own: it stays inside the state of the tool that produced it,
// so the newest one is looked for there, last-first, and only when its producer is in composeTools.
function findImageDataUrl(messages, composeTools) {
  if (!Array.isArray(messages)) return undefined
  const wanted = Array.isArray(composeTools) && composeTools.length ? composeTools : undefined
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]
    const parts = message && message.parts
    if (!Array.isArray(parts)) continue
    for (let p = parts.length - 1; p >= 0; p--) {
      const part = parts[p]
      if (!part) continue
      if (wanted && typeof part.tool === "string" && !wanted.includes(part.tool)) continue
      const bags = [part.state && part.state.attachments, part.attachments]
      for (const bag of bags) {
        if (!Array.isArray(bag)) continue
        for (let a = bag.length - 1; a >= 0; a--) {
          const attachment = bag[a]
          if (!attachment) continue
          if (
            typeof attachment.mime === "string" &&
            attachment.mime.startsWith("image/") &&
            typeof attachment.url === "string" &&
            attachment.url.startsWith("data:")
          ) {
            return attachment.url
          }
        }
      }
    }
  }
  return undefined
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A run combines its own ceiling with the session's abort, so a call the engine cancels stops the
// fetch too. The signal is only ever used to stop a request; a missing abort leaves the timeout.
function requestSignal(ms, abort) {
  const timeout = AbortSignal.timeout(ms)
  if (!abort || typeof AbortSignal.any !== "function") return timeout
  return AbortSignal.any([timeout, abort])
}

const UPLOAD_FROM = /^\{\{\s*([A-Za-z0-9_-]+)\s*\}\}$/

// Which image inputs a recipe actually uploads. Only those have to be present before approving: an
// image input nothing reads is not a reason to stop.
function requiredImageNames(steps, imageInputs) {
  const referenced = new Set()
  for (const step of steps) {
    if (!isPlainObject(step) || !isPlainObject(step.upload)) continue
    const match = typeof step.upload.from === "string" ? UPLOAD_FROM.exec(step.upload.from) : undefined
    if (match) referenced.add(match[1])
  }
  return imageInputs.filter((name) => referenced.has(name))
}

// Only the steps with an effect are shown for approval: goto, waitFor, assert and screenshot
// do not change a page. No input values and no credential values, only the name of a credential.
function effectSteps(steps) {
  const out = []
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index]
    if (!isPlainObject(step)) continue
    if ("fill" in step) {
      const fill = isPlainObject(step.fill) ? step.fill : {}
      out.push({
        index: index,
        kind: "fill",
        ...(typeof fill.selector === "string" ? { selector: fill.selector } : {}),
        ...(typeof fill.credential === "string" ? { credential: fill.credential } : {}),
      })
    } else if ("click" in step) {
      out.push({ index: index, kind: "click", selector: step.click })
    } else if ("upload" in step) {
      const upload = isPlainObject(step.upload) ? step.upload : {}
      out.push({ index: index, kind: "upload", selector: upload.selector })
    } else if ("submit" in step) {
      const submit = isPlainObject(step.submit) ? step.submit : {}
      out.push({ index: index, kind: "submit", selector: submit.selector })
    }
  }
  return out
}

// The profile's own file, asked for once at load. Only a network failure or a timeout is retried; a
// served status is the server's answer, including a 404 that says the harness has no runner.
async function loadProfiles(base, token) {
  const url = base + "/harness/actions"
  for (let attempt = 0; attempt < PROFILE_ATTEMPTS; attempt++) {
    let response
    try {
      response = await fetch(url, {
        headers: { authorization: "Bearer " + token },
        signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      })
    } catch {
      if (attempt + 1 < PROFILE_ATTEMPTS) await sleep(PROFILE_DELAY_MS)
      continue
    }
    if (response.status !== 200) {
      // A 401/403 means the engine's token is not the harness's (a stale file token against a
      // desktop that rotates its own, say): every action tool would fail, so saying it here is the
      // only trace. Anything else (a 404 says the harness has no runner) keeps the plugin off.
      if (response.status === 401 || response.status === 403)
        console.warn(
          "[flupcode] el harness rechazó el token del navegador (HTTP " +
            response.status +
            "): las web-actions están desactivadas. Reinicia el engine con el FLUPCODE_BROWSER_TOKEN del escritorio.",
        )
      return undefined
    }
    const body = await response.json().catch(() => undefined)
    const profiles = propertyAt(propertyAt(body, "data"), "profiles")
    return Array.isArray(profiles) ? profiles : undefined
  }
  return undefined
}

// A value read from the page is written into a line-based summary, so a newline inside one would
// forge a line of the summary (an extra "URL:" line, say). Everything the page controls is folded
// onto a single line before it is written.
function oneLine(value) {
  // U+2028/U+2029 count as line breaks for consumers even though they are not \r or \n.
  return String(value).replace(/\s*[\r\n\u2028\u2029]+\s*/g, " ")
}

function summarise(profile, data) {
  const result = isPlainObject(data) ? data : {}
  const lines = ['Acción "' + (result.action || profile.id) + '" completada.']
  lines.push("Origen: " + (result.origin || profile.origin))
  // Everything read off the page is text somebody else wrote, so it is grouped and named as
  // untrusted: a value that happens to say "URL: ..." must not look like one of this summary's own
  // lines, and one that says the heading itself must not start a real section.
  const page = []
  if (typeof result.url === "string" && result.url) page.push("URL: " + oneLine(result.url))
  if (typeof result.title === "string" && result.title) page.push("Título: " + oneLine(result.title))
  if (isPlainObject(result.extract)) {
    for (const field of Object.keys(result.extract)) {
      page.push("Extraído " + field + ": " + oneLine(result.extract[field]))
    }
  }
  if (page.length > 0) {
    lines.push("Datos no confiables (tomados de la página):")
    for (const line of page) lines.push(line)
  }
  const steps = Array.isArray(result.steps) ? result.steps : []
  if (steps.length > 0) {
    lines.push("Pasos:")
    for (const step of steps) {
      if (!isPlainObject(step)) continue
      lines.push("- #" + step.index + " " + step.kind + ": " + step.status)
    }
  }
  const evidence = Array.isArray(result.evidence) ? result.evidence : []
  if (evidence.length > 0) lines.push("Evidencia: " + evidence.join(", "))
  return lines.join("\n")
}

// The runner already redacts its own message, so the fallback never echoes a raw body. The structured
// codes get a Spanish sentence with only the field or code the caller needs.
function failureText(profile, body) {
  const error = isPlainObject(body) ? body : {}
  const code = typeof error.code === "string" ? error.code : ""
  if (code === "guard_denied")
    return "La acción fue denegada por un guard (" + (error.guardCode || "sin código") + ")."
  if (code === "credential_unavailable")
    return (
      "Falta la credencial nombrada «" +
      (typeof error.field === "string" && error.field ? error.field : profile.credential || "credential") +
      "»."
    )
  if (code === "origin_mismatch" || code === "navigation_blocked")
    return "La navegación salió del origen permitido."
  if (code === "step_failed")
    return "Falló el paso " + (error.step || "?") + " (#" + (error.index !== undefined ? error.index : "?") + ")."
  if (code === "missing_input" || code === "unknown_input" || code === "invalid_input")
    return "Falta o no es válido el input " + (error.field || "?") + "."
  if (code === "extract_failed") return "No se pudo leer " + (error.field || "?") + "."
  if (code === "unknown_action" || code === "not_found")
    return "No se encontró la acción; puede que ya no exista. Reinicia el motor y vuelve a intentarlo."
  if (code === "internal_error")
    return "La acción no se pudo completar por un fallo del servidor del navegador. Vuelve a intentarlo; si persiste, reinicia el motor."
  return typeof error.error === "string" && error.error ? error.error : "La acción no se pudo completar."
}

// The newest frame the runner kept travels back as an attachment, so the tool result shows it. An
// unreadable or oversized artifact is dropped and the text summary still stands.
async function fetchAttachment(base, token, id, sessionID, messageID) {
  if (typeof id !== "string" || id === "") return undefined
  if (typeof sessionID !== "string" || !sessionID || typeof messageID !== "string" || !messageID) return undefined
  let response
  try {
    response = await fetch(base + "/harness/artifacts/" + encodeURIComponent(id) + "/raw", {
      headers: { authorization: "Bearer " + token },
      signal: AbortSignal.timeout(ARTIFACT_TIMEOUT_MS),
    })
  } catch {
    return undefined
  }
  if (!response.ok) return undefined
  const mime = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase()
  if (!ATTACHMENT_MIMES.has(mime)) return undefined
  const declared = response.headers.get("content-length")
  if (declared !== null && Number(declared) > MAX_ATTACHMENT_BYTES) return undefined
  const bytes = await response.arrayBuffer().catch(() => undefined)
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_ATTACHMENT_BYTES) return undefined
  return {
    id: "prt_" + randomUUID(),
    sessionID: sessionID,
    messageID: messageID,
    type: "file",
    mime: mime,
    url: "data:" + mime + ";base64," + Buffer.from(bytes).toString("base64"),
  }
}

// The runner appends a text artifact last when evidence.text is on, so the tail is not always the
// screenshot. The last few ids are probed newest-first and the first image wins; a non-image or an
// oversized one is simply skipped.
async function fetchEvidenceAttachment(base, token, value, sessionID, messageID) {
  const evidence = propertyAt(value, "evidence")
  if (!Array.isArray(evidence)) return undefined
  const start = Math.max(0, evidence.length - EVIDENCE_SCAN)
  for (let i = evidence.length - 1; i >= start; i--) {
    const attachment = await fetchAttachment(base, token, evidence[i], sessionID, messageID)
    if (attachment) return attachment
  }
  return undefined
}

function definition(profile, composeTools) {
  const args = {}
  for (const name of Object.keys(profile.inputs)) {
    if (profile.inputs[name] === "string") {
      args[name] = { type: "string", description: 'Value for the "' + name + '" input.' }
    }
  }
  return {
    description: profile.description,
    args: args,
    async execute(rawArgs, ctx) {
      const args = isPlainObject(rawArgs) ? rawArgs : {}
      const sessionID = propertyAt(ctx, "sessionID")
      const project = propertyAt(ctx, "directory") || propertyAt(ctx, "worktree")
      if (typeof sessionID !== "string" || !sessionID || typeof project !== "string" || !project) {
        return "Esta sesión no tiene una carpeta de proyecto donde ejecutar la acción."
      }
      const messageID = propertyAt(ctx, "messageID")

      const imageInputs = Object.keys(profile.inputs).filter((name) => profile.inputs[name] === "image")
      const imageDataUrl =
        imageInputs.length > 0 ? findImageDataUrl(propertyAt(ctx, "messages"), composeTools) : undefined
      // Before asking: a recipe that uploads an image with none composed cannot run, and asking first
      // would put an approval in front of a call that was never going to happen.
      if (requiredImageNames(profile.steps, imageInputs).length > 0 && !imageDataUrl) {
        return "No encuentro la imagen compuesta en esta conversación. Compónla primero y vuelve a intentarlo."
      }

      const inputs = {}
      for (const name of Object.keys(profile.inputs)) {
        const kind = profile.inputs[name]
        if (kind === "string" && typeof args[name] === "string") inputs[name] = args[name]
        else if (kind === "image" && imageDataUrl) inputs[name] = { dataUrl: imageDataUrl }
      }

      // One approval per action, before any request. A denial is not caught: it propagates so the
      // engine records a failed tool, and no HTTP is made.
      //
      // A profile cannot talk its way out of sensitivity: a recipe with effects or a credential is
      // sensitive whatever the profile says, so the strong permission is what gets asked.
      const steps = effectSteps(profile.steps)
      const credential = typeof profile.credential === "string" && profile.credential !== ""
      const sensitive = profile.sensitive === true || steps.length > 0 || credential
      const resource = sensitive ? profile.origin + ":" + profile.id : profile.origin
      await ctx.ask({
        permission: sensitive ? "browser_sensitive" : "browser",
        patterns: [resource],
        always: [resource],
        metadata: {
          kind: "browser",
          origin: profile.origin,
          action: profile.id,
          tool: profile.tool,
          description: profile.description,
          sensitive: sensitive,
          steps: steps,
        },
      })

      const base = activeBase
      const token = activeToken
      let response
      try {
        response = await fetch(base + "/harness/actions/run", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({
            action: profile.id,
            sessionID: sessionID,
            project: project,
            // Headless, so no window pops up: the live view shows the run, and Take over reveals
            // the headed window on demand. Scheduled actions never come through this tool: the
            // harness server drives them in process and headless (WA-7).
            inputs: inputs,
          }),
          signal: requestSignal(RUN_TIMEOUT_MS, propertyAt(ctx, "abort")),
        })
      } catch {
        return "No se pudo contactar con el servidor del navegador. Comprueba que sigue en marcha."
      }

      const payload = await response.json().catch(() => undefined)
      if (response.status !== 200) {
        const body = isPlainObject(payload) ? payload : {}
        const text = failureText(profile, body)
        const attachment = await fetchEvidenceAttachment(base, token, body, sessionID, messageID)
        return attachment ? { output: text, attachments: [attachment] } : text
      }
      const data = propertyAt(payload, "data")
      const output = summarise(profile, data)
      const attachment = await fetchEvidenceAttachment(base, token, data, sessionID, messageID)
      return attachment ? { output: output, attachments: [attachment] } : output
    },
  }
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
export const flupcodeActions = async () => {
  // The whole-engine kill switch: no token read, no profiles fetch, no tools.
  if (process.env.FLUPCODE_BROWSER_DISABLED === "1") return {}
  const base = harnessBaseURL()
  // A base that is not loopback is refused before the token is read: no token leaves the machine.
  if (base === undefined) return {}
  const token = await readToken()
  if (token === undefined) return {}
  const config = await loadConfig().catch(() => ({}))
  const profiles = await loadProfiles(base, token)
  if (profiles === undefined) return {}
  activeToken = token
  activeBase = base
  const composeTools = config && config.flupcode && config.flupcode.composeTools
  const tools = {}
  for (const profile of profiles) {
    if (!isPlainObject(profile)) continue
    if (typeof profile.tool !== "string" || !profile.tool) continue
    if (typeof profile.id !== "string" || !PROFILE_ID.test(profile.id)) continue
    if (typeof profile.origin !== "string" || !profile.origin) continue
    if (!isPlainObject(profile.inputs)) continue
    if (!Array.isArray(profile.steps)) continue
    tools[profile.tool] = definition(profile, composeTools)
  }
  return { tool: tools }
}
`,
}

/**
 * episode-events: the engine signals an episode cannot derive from a tool's own success or failure
 * (FH-004). The `tool.execute.after` hook sees a call end but not why: a tool that errored — a denied
 * permission, a failed edit — only shows up as the engine's `message.part.updated` event with the
 * part in `error`, and a provider failure only as `session.error`. This plugin records both into a
 * per-session ring the coordinator reads back (`adaptive/events.ts`), plain JavaScript with no
 * imports, like the other plugins.
 *
 * Only non-recoverable errors are recorded. A user cancellation (`MessageAbortedError`) and a
 * context overflow the engine compacts past and continues from (`ContextOverflowError`) are not
 * failures of the work, so they are filtered out; the list can grow as the engine adds recoverable
 * errors. A `session.error` with no session id has no file to land in.
 */
export const EPISODE_EVENTS_PLUGIN = {
  file: "flupcode-episode-events.js",
  source: `// Installed by FlupCode. Records the engine signals a tool's own hooks cannot see: a tool that
// ended in error and a session-level error. The adaptive coordinator reads them back to fill an
// episode's failures. Regenerated when FlupCode starts the engine; edits here are overwritten.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with episodeEventsDirectory() in packages/harness-server/src/adaptive/events.ts,
// which reads it back.
function directory() {
  if (process.env.FLUPCODE_EPISODE_EVENTS_DIR) return process.env.FLUPCODE_EPISODE_EVENTS_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "events")
}

// An event carries no tool input, so two events can fire at once and lose one another: the queue
// keeps each file's read-modify-write serial.
const queues = new Map()

// The newest events are what a reader wants; the ring is small enough to read whole.
const MOST = 200
// A provider's error body can be long, and the file is user-only; anything past this is dropped.
const MESSAGE_LIMIT = 1000

// A clock that never goes back orders events written in the same millisecond. The array order is
// authoritative; this only keeps the stamps readable.
let last = 0
function stamp() {
  const now = Date.now()
  last = now > last ? now : last + 1
  return last
}

function serial(file, work) {
  const tail = queues.get(file) || Promise.resolve()
  const next = tail.then(work, work)
  queues.set(file, next.catch(() => {}))
  return next
}

function load(file) {
  return readFile(file, "utf8").then(JSON.parse).catch(() => ({}))
}

function bounded(value, limit) {
  return value.length > limit ? value.slice(0, limit) : value
}

// Only what an episode can cite, and only the fields it needs: a tool error with its message, and a
// session error that is not recoverable. Anything else returns nothing.
function selection(event) {
  const type = event && event.type
  const properties = event && event.properties
  if (type === "message.part.updated") {
    const part = properties && properties.part
    if (!part || part.type !== "tool") return
    const state = part.state
    if (!state || state.status !== "error") return
    // An abort marks every in-flight tool with a synthetic error; that is not a failure of the work.
    if (state.metadata && state.metadata.interrupted === true) return
    if (state.error === "Tool execution aborted" || state.error === "Cancelled") return
    if (typeof part.tool !== "string" || !part.tool) return
    return {
      sessionID: properties.sessionID,
      entry: {
        kind: "tool.error",
        tool: part.tool,
        ...(typeof part.callID === "string" && part.callID ? { callID: part.callID } : {}),
        message: typeof state.error === "string" ? state.error : "",
      },
    }
  }
  if (type === "session.error") {
    const error = properties && properties.error
    const name = error && error.name
    // A cancellation and a context overflow the engine recovers from are not failures of the work.
    if (name === "MessageAbortedError" || name === "ContextOverflowError") return
    if (typeof name !== "string" || !name) return
    const data = error && error.data
    return {
      sessionID: properties.sessionID,
      entry: {
        kind: "session.error",
        error: name,
        message: data && typeof data.message === "string" ? data.message : "",
      },
    }
  }
}

async function record(event) {
  const selected = selection(event)
  if (!selected) return
  // The id names a file, so anything that is not an engine-shaped id is refused rather than written.
  const sessionID = selected.sessionID
  if (!sessionID || !/^[A-Za-z0-9_-]+$/.test(sessionID)) return
  const folder = directory()
  const file = path.join(folder, sessionID + ".json")
  await serial(file, async () => {
    const previous = await load(file)
    const events = previous && Array.isArray(previous.events) ? previous.events.slice(-MOST) : []
    events.push({
      seq: stamp(),
      at: Date.now(),
      ...selected.entry,
      message: bounded(selected.entry.message, MESSAGE_LIMIT),
    })
    // The file carries provider error bodies, so it stays user-only. mkdir does not change the mode
    // of an existing folder, hence the best-effort chmod.
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o700).catch(() => {})
    await store(file, { at: Date.now(), events: events.slice(-MOST) })
  })
}

// Atomic: a reader never sees half the file. A failed rename must not leave the temp behind.
async function store(target, data) {
  const temp = target + ".tmp-" + process.pid + "-" + Date.now()
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
  try {
    await rename(temp, target)
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {})
    throw cause
  }
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
export const flupcodeEpisodeEvents = async () => ({
  event: async ({ event }) => {
    await record(event).catch(() => {})
  },
})
`,
}

/**
 * relevance: injects the harness's acting relevance line into a turn's system prompt (FH-04,
 * ADR-0021). It is a thin proxy: it captures the turn's objective and its ids in
 * `experimental.chat.messages.transform`, asks the loopback harness for the line in
 * `experimental.chat.system.transform`, and pushes it only when the answer carries one. It decides
 * nothing, holds no product state and never throws: any failure — an absent server, a timeout, a
 * non-200, malformed JSON — leaves `system` byte-identical, which is the inertness ADR-0021 §3 fixes.
 *
 * The server is the only policy point, so the plugin registers whenever base and token resolve, even
 * with the feature off; the accepted cost is one loopback `POST` per turn returning `line: null`.
 * The capture is not consumed when read: a title runs on another fiber and its `system.transform` may
 * interleave before the turn, so reading has to leave the objective in place for the real turn.
 */
export const RELEVANCE_PLUGIN = {
  file: "flupcode-relevance.js",
  source: String.raw`// Installed by FlupCode. Injects the harness's acting relevance line into a turn's system prompt.
// It captures the turn's objective and its ids, asks the loopback harness for the line, and pushes
// it only when the answer carries one. It decides nothing and holds no product state. Regenerated
// when FlupCode starts the engine; edits here are overwritten.
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// The objective is a hint the harness matches skill names against, not the whole message; it is
// bounded so a huge turn cannot travel on the hot path.
const OBJECTIVE_LIMIT = 500

// A capture outlives its turn only to survive the title fiber racing the turn fiber; after this it is
// stale and the injection is inert. The next user turn overwrites it.
const CAPTURE_TTL_MS = 5 * 60 * 1000

// The capture map is bounded so a long-lived engine cannot grow it without bound.
const MAX_SESSIONS = 500

// The server's own hot deadline is capped below this one (see RELEVANCE_TIMEOUT_MS_CEILING in
// packages/harness-server/src/adaptive/config.ts), so the server always answers first. It is a
// defence against a hung server, not product policy.
const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_RELEVANCE_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 500
})()

// Same shape the harness uses (packages/harness-server/src/browser-token.ts), read here without
// importing it: the plugin has no package imports.
function flupcodeConfigDir() {
  if (process.env.FLUPCODE_CONFIG_DIR) return process.env.FLUPCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "flupcode")
}

function harnessBaseURL() {
  const raw =
    process.env.FLUPCODE_HARNESS_SERVER_URL ||
    "http://127.0.0.1:" + (process.env.FLUPCODE_HARNESS_PORT || "4097")
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  // The bearer token is only ever sent to the loopback harness: a remote URL would leak it.
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1" && url.hostname !== "localhost")
    return undefined
  return url.origin
}

async function readToken() {
  // The acting line has its own secret (FH-04, ADR-0022): the browser bearer the desktop injects is
  // a different credential and must not open this route. The harness-owned file is the only source —
  // never an environment variable, so the secret stays out of the children's env.
  const text = await readFile(path.join(flupcodeConfigDir(), "adaptive-token"), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const token = text.trim()
  return token === "" ? undefined : token
}

// The last user message of the request, with only its non-synthetic text: a synthetic part is the
// engine's own scaffolding, not what the user asked.
function lastUserObjective(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    const info = message && message.info
    if (!info || info.role !== "user") continue
    const parts = Array.isArray(message.parts) ? message.parts : []
    const text = parts
      .filter((part) => part && part.type === "text" && typeof part.text === "string" && !part.synthetic)
      .map((part) => part.text)
      .join("\n")
    return {
      sessionID: typeof info.sessionID === "string" ? info.sessionID : undefined,
      messageID: typeof info.id === "string" ? info.id : undefined,
      objective: text.slice(0, OBJECTIVE_LIMIT),
    }
  }
  return undefined
}

// The captures live in the module, keyed by session, so a title's system.transform cannot consume the
// turn's objective before the turn reads it.
const captures = new Map()

function pruneCaptures(now) {
  for (const [sessionID, entry] of captures) {
    if (now - entry.at > CAPTURE_TTL_MS) captures.delete(sessionID)
  }
  while (captures.size > MAX_SESSIONS) {
    const oldest = captures.keys().next().value
    if (oldest === undefined) break
    captures.delete(oldest)
  }
}

function capture(sessionID, messageID, objective) {
  if (typeof sessionID !== "string" || !sessionID) return
  if (typeof messageID !== "string" || !messageID) return
  const now = Date.now()
  pruneCaptures(now)
  // Re-insert so the newest turn is the newest entry for the size bound.
  captures.delete(sessionID)
  captures.set(sessionID, { messageID: messageID, objective: objective, at: now })
}

function freshCapture(sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return undefined
  const entry = captures.get(sessionID)
  if (!entry) return undefined
  return Date.now() - entry.at > CAPTURE_TTL_MS ? undefined : entry
}

// The server renders one fixed, names-only box and the plugin is the last line of trust: it must not
// push whatever a peer that happens to hold the loopback port answers. The shape is kept in step with
// skill-line.ts (packages/harness-server/src/adaptive/skill-line.ts): the same prefix and suffix, the
// same NAME as skills.ts, and the same top-3 the default relevance config allows. Anything that is
// not exactly that box — extra text, a nested tag, an unknown token — is refused, so a hostile or
// tampered answer leaves the system prompt byte-identical.
const SKILL_LINE_PREFIX = "<skill_relevance>Possibly relevant skills: "
const SKILL_LINE_SUFFIX = ". Consider loading one only if it clearly applies; otherwise ignore.</skill_relevance>"
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i
const MAX_LINE_SKILLS = 3

// Shape is not enough: a hostile peer that holds the loopback port could answer with a shape-valid
// token of kilobytes (system-prompt bloat) or hyphenated tokens that read as instructions. A
// legitimate name is a short folder name, so both caps are refused outright when exceeded.
const MAX_SKILL_NAME_LENGTH = 64
const MAX_LINE_LENGTH = 300

function namesOnlyLine(value) {
  if (typeof value !== "string") return undefined
  if (value.length > MAX_LINE_LENGTH) return undefined
  if (!value.startsWith(SKILL_LINE_PREFIX) || !value.endsWith(SKILL_LINE_SUFFIX)) return undefined
  const middle = value.slice(SKILL_LINE_PREFIX.length, value.length - SKILL_LINE_SUFFIX.length)
  const names = middle.split(", ")
  if (names.length < 1 || names.length > MAX_LINE_SKILLS) return undefined
  if (!names.every((name) => SKILL_NAME.test(name) && name.length <= MAX_SKILL_NAME_LENGTH)) return undefined
  return value
}

// A non-200, malformed JSON, a null/empty line or any body that is not the fixed box is the inert
// answer. The fetch is bounded with a timeout and the caller catches everything.
async function requestLine(base, token, projectID, sessionID, messageID, objective) {
  const response = await fetch(base + "/harness/adaptive/relevance", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ projectID: projectID, sessionID: sessionID, messageID: messageID, objective: objective }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const body = await response.json().catch(() => undefined)
  const data = body && typeof body === "object" ? body.data : undefined
  const line = data && typeof data === "object" ? data.line : undefined
  return namesOnlyLine(line)
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
export const flupcodeRelevance = async (input) => {
  const base = harnessBaseURL()
  // A base that is not loopback is refused before the token is read: no token leaves the machine.
  if (base === undefined) return {}
  const token = await readToken()
  if (token === undefined) return {}
  // The harness's adaptive project id is the project directory, which the plugin factory is handed.
  const projectID = input && typeof input.directory === "string" ? input.directory : undefined

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const objective = lastUserObjective(output && output.messages)
        if (objective) capture(objective.sessionID, objective.messageID, objective.objective)
      } catch {
        // A capture that cannot be read must never fail the turn; there is simply no objective.
      }
    },
    "experimental.chat.system.transform": async (hookInput, output) => {
      try {
        const pending = freshCapture(hookInput && hookInput.sessionID)
        if (!pending || !Array.isArray(output && output.system)) return
        const line = await requestLine(
          base,
          token,
          projectID,
          hookInput.sessionID,
          pending.messageID,
          pending.objective,
        )
        if (line) output.system.push(line)
      } catch {
        // Any failure - an absent server, a timeout, a non-200, bad JSON - is inert: the system
        // prompt is left exactly as it arrived and the turn is unaffected.
      }
    },
  }
}
`,
}

/**
 * guardrails: feeds the harness's failure/loop detector with opaque digests of tool calls and tool
 * errors (FH-060–063, ADR-0023). It is a thin proxy: it hashes the call's arguments (or the error
 * message) with a canonical `sha256`, `POST`s the digest to the loopback harness, and ignores the
 * answer. It decides nothing, holds no product state, never pauses a turn, never reads the verdict
 * and never mutates `output`.
 *
 * The server is the only policy point, so the plugin registers whenever base and token resolve, even
 * with the feature off; every failure — absent server, timeout, non-200, malformed JSON — is inert.
 * The `POST` is fire-and-forget: it never blocks the tool path.
 */
export const GUARDRAILS_PLUGIN = {
  file: "flupcode-guardrails.js",
  source: String.raw`// Installed by FlupCode. Feeds the harness's failure/loop detector with opaque digests of tool calls
// and tool errors. It sends no arguments, messages or output, decides nothing and never blocks the
// tool path. Regenerated when FlupCode starts the engine; edits here are overwritten.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// The server's own hot deadline is 300 ms (DEFAULT_GUARDRAILS_CONFIG.timeoutMs in
// packages/harness-server/src/adaptive/config.ts), so this stays above it. It is a defence against a
// hung server, not product policy.
const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_GUARDRAILS_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 500
})()

// Same shape the harness uses (packages/harness-server/src/browser-token.ts), read here without
// importing it: the plugin has no package imports.
function flupcodeConfigDir() {
  if (process.env.FLUPCODE_CONFIG_DIR) return process.env.FLUPCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "flupcode")
}

function harnessBaseURL() {
  const raw =
    process.env.FLUPCODE_HARNESS_SERVER_URL ||
    "http://127.0.0.1:" + (process.env.FLUPCODE_HARNESS_PORT || "4097")
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  // The bearer token is only ever sent to the loopback harness: a remote URL would leak it.
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1" && url.hostname !== "localhost")
    return undefined
  return url.origin
}

async function readToken() {
  // The adaptive line has its own secret (FH-04, ADR-0022): the browser bearer is a different
  // credential and must not open this route. The harness-owned file is the only source.
  const text = await readFile(path.join(flupcodeConfigDir(), "adaptive-token"), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const token = text.trim()
  return token === "" ? undefined : token
}

// A stable digest: JSON with sorted object keys, so a reordered argument map hashes the same, then
// sha256 hex. Only this digest travels; the arguments themselves never leave the process.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    const sorted = {}
    for (const key of Object.keys(value).sort()) sorted[key] = canonical(value[key])
    return sorted
  }
  return value
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value === undefined ? null : value))).digest("hex")
}

function send(base, token, payload) {
  return fetch(base + "/harness/adaptive/guardrails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
}

// Only an errored tool part that is not an abort or a cancellation says the work failed. Kept in
// step with EPISODE_EVENTS_PLUGIN's selection.
function erroredTool(properties) {
  const part = properties && properties.part
  if (!part || part.type !== "tool") return undefined
  const state = part.state
  if (!state || state.status !== "error") return undefined
  if (state.metadata && state.metadata.interrupted === true) return undefined
  if (state.error === "Tool execution aborted" || state.error === "Cancelled") return undefined
  if (typeof part.tool !== "string" || !part.tool) return undefined
  return {
    tool: part.tool,
    callID: typeof part.callID === "string" && part.callID ? part.callID : undefined,
    error: typeof state.error === "string" ? state.error : "",
  }
}

// Only this is exported: the engine treats every exported function as a plugin of its own.
export const flupcodeGuardrails = async (input) => {
  const base = harnessBaseURL()
  // A base that is not loopback is refused before the token is read: no token leaves the machine.
  if (base === undefined) return {}
  const token = await readToken()
  if (token === undefined) return {}
  // The harness's adaptive project id is the project directory, which the plugin factory is handed.
  const projectID = input && typeof input.directory === "string" ? input.directory : undefined

  function observe(sessionID, observation) {
    if (typeof sessionID !== "string" || !sessionID) return
    if (typeof projectID !== "string" || !projectID) return
    // Fire-and-forget: the tool path never waits and any failure is swallowed.
    void send(base, token, { projectID: projectID, sessionID: sessionID, observation: observation }).catch(() => {})
  }

  return {
    "tool.execute.before": async (hookInput, output) => {
      const tool = hookInput && hookInput.tool
      if (typeof tool !== "string" || !tool) return
      const callID = hookInput && typeof hookInput.callID === "string" && hookInput.callID ? hookInput.callID : undefined
      observe(hookInput && hookInput.sessionID, {
        kind: "call",
        tool: tool,
        argsDigest: digest(output && output.args),
        ...(callID ? { callID: callID } : {}),
      })
    },
    event: async ({ event }) => {
      if (!event || event.type !== "message.part.updated") return
      const properties = event.properties
      const failed = erroredTool(properties)
      if (!failed) return
      observe(properties && properties.sessionID, {
        kind: "error",
        tool: failed.tool,
        errorDigest: digest(failed.error),
        ...(failed.callID ? { callID: failed.callID } : {}),
      })
    },
  }
}
`,
}

/** The engine plugins FlupCode owns. */
const PLUGINS = [
  REASONING_VARIANTS_PLUGIN,
  TOOL_USES_PLUGIN,
  RUNTIME_PROBE_PLUGIN,
  SYSTEM_PROMPT_PLUGIN,
  ARTIFACT_WRITE_PLUGIN,
  DELIVERY_PLUGIN,
  WEB_ACTIONS_PLUGIN,
  EPISODE_EVENTS_PLUGIN,
  RELEVANCE_PLUGIN,
  GUARDRAILS_PLUGIN,
]

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
