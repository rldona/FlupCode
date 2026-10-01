/**
 * FlupCode's engine plugins for OpenCode 2 (V2-30), written into the same `plugins` folder under the
 * same file names as the 1.x ones (`engine-plugins.ts`), so installing one line's set replaces the
 * other's.
 *
 * 2.x refuses the 1.x shape (named exports returning hooks) at load time; it takes one default export
 * `{ id, setup(ctx) }` and hands `setup` the plugin context: `ctx.tool.hook("execute.before" |
 * "execute.after")`, `ctx.tool.transform` to add tools, `ctx.session.hook("context")` for the request
 * a turn sends, `ctx.event.subscribe` for the engine's events, and `ctx.model.transform` for the
 * catalog. Transform editors are synchronous, so anything they need is read before registering.
 *
 * Each plugin is plain JavaScript with no package imports, like the 1.x ones, and writes the same
 * files in the same shape, so harness-server reads them back unchanged. Where 2.x renamed a tool the
 * 1.x name is what is written (`shell` is recorded as `bash`, `patch` as `apply_patch`, `subagent` as
 * `task`), since that is what every reader keys on.
 */
import { CACHE_SELECTION_SOURCE } from "./cache-selection-source"

/** reasoning-variants: effort levels for models 2.x's catalog lists without any. */
export const REASONING_VARIANTS_PLUGIN_V2 = {
  file: "flupcode-reasoning-variants.js",
  source: `// Installed by FlupCode for OpenCode 2. Adds reasoning effort levels to the models the catalog lists
// without any, from the models.dev data the engine caches. Regenerated when FlupCode starts the engine;
// edits here are overwritten.
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
  if (!option || !Array.isArray(option.values)) return []
  return option.values.filter((value) => typeof value === "string")
}

export default {
  id: "flupcode-reasoning-variants",
  setup: async (ctx) => {
    // The editor is synchronous, so the data is read before the transform is registered.
    const data = await loadModelsDev()
    await ctx.model.transform((editor) => {
      for (const model of editor.list()) {
        // 2.x already carries levels for most models; only an empty list is filled.
        if (Array.isArray(model.variants) && model.variants.length) continue
        const provider = data[model.providerID]
        const levels = efforts(provider && provider.models && provider.models[model.id])
        if (!levels.length) continue
        editor.update(model.providerID, model.id, (draft) => {
          draft.variants = levels.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }))
        })
      }
    })
  },
}
`,
}

/** tool-uses: which tools a session ran, how long each took, and the evidence a call left. */
export const TOOL_USES_PLUGIN_V2 = {
  file: "flupcode-tool-uses.js",
  source: `// Installed by FlupCode for OpenCode 2. Records which tools each session ran and how long each took,
// and the evidence a call left (a shell's command, exit code and output tail, the paths an edit
// touched), in the files the Context screen, the supervisor and the episodes read. Regenerated when
// FlupCode starts the engine; edits here are overwritten.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with toolUsesDirectory() in packages/harness-server/src/context.ts.
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

// Every reader keys on the 1.x names.
const LEGACY_NAMES = { shell: "bash", patch: "apply_patch", subagent: "task" }

const MOST = 200
const MOST_CALLS = 500
const MOST_SIGNALS = 200
const OUT_LIMIT = 4096
const COMMAND_LIMIT = 500
const PATHS_PER_CALL = 20
const PATH_LIMIT = 1000

// Two tools of one step read-modify-writing the same file would lose one another.
const queues = new Map()
// When each running call started, by the id the engine gave it.
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

function validSession(sessionID) {
  return typeof sessionID === "string" && /^[A-Za-z0-9_-]+$/.test(sessionID)
}

async function began(sessionID, tool, id) {
  if (!validSession(sessionID) || !tool) return
  running.set(sessionID + "|" + id, Date.now())
  if (running.size > 1000) running.delete(running.keys().next().value)
  const folder = directory()
  const file = path.join(folder, sessionID + ".json")
  await serial(file, async () => {
    const previous = await load(file)
    const tools = previous && previous.tools && typeof previous.tools === "object" ? previous.tools : {}
    const known = tools[tool]
    if (!known && Object.keys(tools).length >= MOST) return
    tools[tool] = { count: (known && typeof known.count === "number" ? known.count : 0) + 1, last: Date.now() }
    await mkdir(folder, { recursive: true })
    await writeFile(file, JSON.stringify({ at: Date.now(), tools, calls: callsOf(previous) }))
  })
}

function textOf(result) {
  const output = result && result.output
  if (output && typeof output.output === "string") return output.output
  if (typeof (result && result.content) === "string") return result.content
  const parts = result && Array.isArray(result.content) ? result.content : []
  const text = parts.filter((part) => part && part.type === "text").map((part) => part.text).join("\\n")
  return text || undefined
}

// What one finished call left behind, or nothing: a read or a grep says nothing an episode can use.
function signalEntry(tool, input, after, start) {
  const args = input && typeof input === "object" ? input : {}
  const result = after.status === "completed" ? after.result : undefined
  const metadata = result && result.metadata && typeof result.metadata === "object" ? result.metadata : {}
  const entry = { tool, ok: after.status === "completed", paths: [] }
  if (start !== undefined) {
    entry.start = start
    entry.ms = Math.max(0, Date.now() - start)
  }
  if (tool === "bash") {
    if (typeof args.command === "string" && args.command) entry.command = args.command.slice(0, COMMAND_LIMIT)
    const exit = result && result.output && typeof result.output.exit === "number" ? result.output.exit : metadata.exit
    if (typeof exit === "number") entry.exit = exit
    const text = textOf(result)
    if (text) {
      entry.out = text.length > OUT_LIMIT ? text.slice(-OUT_LIMIT) : text
      if (text.length > OUT_LIMIT) entry.truncated = true
    }
  } else if (tool === "edit" || tool === "write") {
    const file = typeof args.path === "string" ? args.path : args.filePath
    if (typeof file === "string" && file) entry.paths = [file.slice(0, PATH_LIMIT)]
  } else if (tool === "apply_patch") {
    const files = Array.isArray(metadata.files) ? metadata.files : []
    entry.paths = files
      .map((file) => (file && typeof file.relativePath === "string" ? file.relativePath.slice(0, PATH_LIMIT) : undefined))
      .filter((file) => file)
      .slice(0, PATHS_PER_CALL)
  }
  const evidence =
    entry.command !== undefined || entry.exit !== undefined || entry.out !== undefined || entry.paths.length > 0 || !entry.ok
  return evidence ? entry : undefined
}

// Atomic and user-only: the signal carries a shell's command and output.
async function storeSignals(target, data) {
  const temp = target + ".tmp-" + process.pid + "-" + Date.now()
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 })
  try {
    await rename(temp, target)
  } catch (cause) {
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
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o700).catch(() => {})
    await storeSignals(file, { at: Date.now(), calls: calls.slice(-MOST_SIGNALS) })
  })
}

async function finished(sessionID, tool, after) {
  if (!validSession(sessionID) || !tool) return
  const key = sessionID + "|" + after.id
  const start = running.get(key)
  running.delete(key)
  const entry = signalEntry(tool, after.input, after, start)
  if (entry) await recordSignal(sessionID, entry).catch(() => {})
  if (start === undefined) return
  const folder = directory()
  const file = path.join(folder, sessionID + ".json")
  await serial(file, async () => {
    const previous = await load(file)
    const tools = previous && previous.tools && typeof previous.tools === "object" ? previous.tools : {}
    const calls = callsOf(previous)
    calls.push({ tool, start, ms: Math.max(0, Date.now() - start) })
    await mkdir(folder, { recursive: true })
    await writeFile(file, JSON.stringify({ at: Date.now(), tools, calls }))
  })
}

const named = (tool) => LEGACY_NAMES[tool] || tool

export default {
  id: "flupcode-tool-uses",
  setup: async (ctx) => {
    await ctx.tool.hook("execute.before", (input) => {
      began(input.sessionID, named(input.tool), input.id).catch(() => {})
    })
    await ctx.tool.hook("execute.after", (input) => {
      finished(input.sessionID, named(input.tool), input).catch(() => {})
    })
  },
}
`,
}

/** system-prompt: the system prompt each request was given, for the Context screen. */
export const SYSTEM_PROMPT_PLUGIN_V2 = {
  file: "flupcode-system-prompt.js",
  source: `// Installed by FlupCode for OpenCode 2. Records the system prompt the engine assembles for each
// request, so the Context screen can show what a turn was actually given. Regenerated when FlupCode
// starts the engine; edits here are overwritten.
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with systemPromptsDirectory() in packages/harness-server/src/context.ts.
function directory() {
  if (process.env.FLUPCODE_SYSTEM_PROMPTS_DIR) return process.env.FLUPCODE_SYSTEM_PROMPTS_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "system-prompts")
}

const KEEP = 6

// The file name orders the recordings, and two requests can land in the same millisecond.
let last = 0
function stamp() {
  const now = Date.now()
  last = now > last ? now : last + 1
  return last
}

async function prune(folder) {
  const files = (await readdir(folder)).filter((file) => file.endsWith(".json")).sort()
  for (const file of files.slice(0, Math.max(0, files.length - KEEP)))
    await unlink(path.join(folder, file)).catch(() => {})
}

async function record(sessionID, system, model) {
  if (typeof sessionID !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionID)) return
  const folder = path.join(directory(), sessionID)
  await mkdir(folder, { recursive: true })
  const at = stamp()
  await writeFile(
    path.join(folder, at + "-" + Math.random().toString(36).slice(2, 8) + ".json"),
    JSON.stringify({ at, providerID: model && model.providerID, modelID: model && model.id, system }),
  )
  await prune(folder)
}

export default {
  id: "flupcode-system-prompt",
  setup: async (ctx) => {
    await ctx.session.hook("context", (input) => {
      // 2.x hands the system prompt as parts; the reader keeps the 1.x list of strings.
      const system = (input.system || []).map((part) => (part && typeof part.text === "string" ? part.text : ""))
      record(input.sessionID, system, input.model).catch(() => {})
    })
  },
}
`,
}

/** artifact-write: the tool that keeps a document where the Artifacts screen shows it. */
export const ARTIFACT_WRITE_PLUGIN_V2 = {
  file: "flupcode-artifact-write.js",
  source: `// Installed by FlupCode for OpenCode 2. Lets the agent keep a generated document where the Artifacts
// screen indexes it: .flupcode/artifacts inside the project. Regenerated when FlupCode starts the
// engine; edits here are overwritten.
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

// A path a model writes must not escape the folder.
function fileName(value) {
  const base = path.basename(String(value || "document.md")).replace(/[^A-Za-z0-9._-]/g, "-")
  return base && base !== "." && base !== ".." ? base : "document.md"
}

export default {
  id: "flupcode-artifact-write",
  setup: async (ctx) => {
    // A plugin runs per location, so the project folder is the location's.
    const directory = ctx.location && ctx.location.directory
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "artifact_write",
        description:
          "Keep a document you produced (a page, a report, an image note) so the reader finds it under Artifacts. Writes it to .flupcode/artifacts in the project and returns its path.",
        input: {
          type: "object",
          properties: {
            title: { type: "string", description: "A short title the reader will see in the Artifacts list." },
            filename: { type: "string", description: "The file name to write, including its extension, e.g. report.html." },
            content: { type: "string", description: "The document itself, in full." },
          },
          required: ["title", "filename", "content"],
        },
        // Called by name, like the built-in tools, rather than from Code Mode's script.
        options: { codemode: false },
        execute: async (input) => {
          if (!directory) return { content: "This session has no project folder to keep a document in." }
          const name = fileName(input && input.filename)
          const folder = path.join(directory, ".flupcode", "artifacts")
          await mkdir(folder, { recursive: true })
          await writeFile(path.join(folder, name), String((input && input.content) || ""), "utf8")
          return { content: "Kept " + name + " in .flupcode/artifacts. It appears under Artifacts for this project." }
        },
      })
    })
  },
}
`,
}

/** episode-events: the failures a tool's own hooks cannot explain, for the episodes. */
export const EPISODE_EVENTS_PLUGIN_V2 = {
  file: "flupcode-episode-events.js",
  source: `// Installed by FlupCode for OpenCode 2. Records a tool that ended in error and a run that failed, in
// the per-session ring the adaptive coordinator reads back to fill an episode's failures.
// Regenerated when FlupCode starts the engine; edits here are overwritten.
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with episodeEventsDirectory() in packages/harness-server/src/adaptive/events.ts.
function directory() {
  if (process.env.FLUPCODE_EPISODE_EVENTS_DIR) return process.env.FLUPCODE_EPISODE_EVENTS_DIR
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "events")
}

const LEGACY_NAMES = { shell: "bash", patch: "apply_patch", subagent: "task" }
const MOST = 200
const MESSAGE_LIMIT = 1000
// Not failures of the work: the reader stopping it, and a context the engine compacts past.
const RECOVERABLE = /abort|interrupt|cancel|overflow/i

const queues = new Map()
// A failed call's event names the call, not the tool; the tool came with the call.
const toolNames = new Map()

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

function selection(event) {
  const data = (event && event.data) || {}
  if (event.type === "session.tool.input.started" || event.type === "session.tool.called") {
    if (typeof data.id === "string" && typeof data.name === "string") {
      toolNames.set(data.id, data.name)
      if (toolNames.size > 1000) toolNames.delete(toolNames.keys().next().value)
    }
    return
  }
  if (event.type === "session.tool.failed") {
    const error = data.error || {}
    const name = toolNames.get(data.id)
    toolNames.delete(data.id)
    if (!name || RECOVERABLE.test(String(error.type || ""))) return
    return {
      sessionID: data.sessionID,
      entry: {
        kind: "tool.error",
        tool: LEGACY_NAMES[name] || name,
        ...(typeof data.id === "string" ? { callID: data.id } : {}),
        message: typeof error.message === "string" ? error.message : "",
      },
    }
  }
  if (event.type === "session.execution.failed") {
    const error = data.error || {}
    if (typeof error.type !== "string" || !error.type || RECOVERABLE.test(error.type)) return
    return {
      sessionID: data.sessionID,
      entry: { kind: "session.error", error: error.type, message: typeof error.message === "string" ? error.message : "" },
    }
  }
}

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

async function record(event) {
  const selected = selection(event)
  if (!selected) return
  const sessionID = selected.sessionID
  if (typeof sessionID !== "string" || !/^[A-Za-z0-9_-]+$/.test(sessionID)) return
  const folder = directory()
  const file = path.join(folder, sessionID + ".json")
  await serial(file, async () => {
    const previous = await load(file)
    const events = previous && Array.isArray(previous.events) ? previous.events.slice(-MOST) : []
    const message = selected.entry.message
    events.push({
      seq: stamp(),
      at: Date.now(),
      ...selected.entry,
      message: message.length > MESSAGE_LIMIT ? message.slice(0, MESSAGE_LIMIT) : message,
    })
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await chmod(folder, 0o700).catch(() => {})
    await store(file, { at: Date.now(), events: events.slice(-MOST) })
  })
}

export default {
  id: "flupcode-episode-events",
  setup: async (ctx) => {
    const directoryOf = ctx.location && ctx.location.directory
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // The stream carries every location's events and this plugin runs once per location: only
        // this location's are recorded, or each would land once per open location.
        if (event.location && event.location.directory && event.location.directory !== directoryOf) continue
        await record(event).catch(() => {})
      }
    })().catch(() => {})
    return () => controller.abort()
  },
}
`,
}

/**
 * What every adaptive plugin needs to reach harness-server, inlined into each one (a plugin may import
 * no package): the loopback base URL, which is the only place the bearer may go, and the adaptive
 * token the harness writes. Kept in step with the 1.x plugins in `engine-plugins.ts`.
 */
const ADAPTIVE_HELPERS = String.raw`function flupcodeConfigDir() {
  if (process.env.FLUPCODE_CONFIG_DIR) return process.env.FLUPCODE_CONFIG_DIR
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "flupcode")
}

// The bearer token is only ever sent to the loopback harness: a remote URL would leak it.
function harnessBaseURL() {
  const raw =
    process.env.FLUPCODE_HARNESS_SERVER_URL || "http://127.0.0.1:" + (process.env.FLUPCODE_HARNESS_PORT || "4097")
  if (!URL.canParse(raw)) return undefined
  const url = new URL(raw)
  if (url.hostname !== "127.0.0.1" && url.hostname !== "[::1]" && url.hostname !== "::1" && url.hostname !== "localhost")
    return undefined
  return url.origin
}

// The harness-owned file is the only source of the adaptive token, never an environment variable.
async function readToken() {
  const text = await readFile(path.join(flupcodeConfigDir(), "adaptive-token"), "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const token = text.trim()
  return token === "" ? undefined : token
}

// Every reader keys on the 1.x tool names.
const LEGACY_NAMES = { shell: "bash", patch: "apply_patch", subagent: "task" }
const named = (tool) => LEGACY_NAMES[tool] || tool`

/**
 * runtime-probe: the canary harness-server reads to tell whether the engine's plugin hooks fire. On
 * 2.x that proof is the `context` hook, which fires on every request, so it is recorded as the hook
 * the classifier needs (`hookAt`); the boot token, pid and `loadedAt` work as on 1.x.
 */
export const RUNTIME_PROBE_PLUGIN_V2 = {
  file: "flupcode-runtime-probe.js",
  source: String.raw`// Installed by FlupCode for OpenCode 2. Writes the runtime probe canary the harness reads to tell
// whether the engine's plugin hooks fire. Regenerated when FlupCode starts the engine; edits here are
// overwritten.
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Kept in step with runtimeProbeFilePath() in packages/harness-server/src/adaptive/runtime.ts.
function filePath() {
  if (process.env.FLUPCODE_RUNTIME_PROBE_FILE) return process.env.FLUPCODE_RUNTIME_PROBE_FILE
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "flupcode", "runtime-probe.json")
}

let tail = Promise.resolve()
function serial(work) {
  const next = tail.then(work, work)
  tail = next.catch(() => {})
  return next
}

function load(target) {
  return readFile(target, "utf8").then(JSON.parse).catch(() => ({}))
}

async function store(data) {
  const target = filePath()
  await mkdir(path.dirname(target), { recursive: true })
  const temp = target + ".tmp-" + process.pid + "-" + Date.now()
  await writeFile(temp, JSON.stringify(data))
  try {
    await rename(temp, target)
  } catch (cause) {
    await rm(temp, { force: true }).catch(() => {})
    throw cause
  }
}

// The token carries the process start, so a reused pid cannot pass as this process.
const boot = process.pid + ":" + Math.round(Date.now() - process.uptime() * 1000)

function stamp() {
  return serial(async () => {
    const previous = await load(filePath())
    if (previous && previous.token === boot) return
    await store({ token: boot, pid: process.pid, loadedAt: Date.now(), hookAt: 0, v2At: 0, event: null })
  })
}

// One mark per process is enough proof; the context hook fires on every request.
let marked = false
function markHook() {
  if (marked) return Promise.resolve()
  marked = true
  return serial(async () => {
    const previous = await load(filePath())
    if (!previous || previous.token !== boot) return
    await store({ ...previous, hookAt: Date.now(), hook: "session.context" })
  })
}

export default {
  id: "flupcode-runtime-probe",
  setup: async (ctx) => {
    await stamp().catch(() => {})
    await ctx.session.hook("context", () => {
      markHook().catch(() => {})
    })
  },
}
`,
}

/** guardrails: opaque digests of tool calls and tool errors for the harness's loop detector. */
export const GUARDRAILS_PLUGIN_V2 = {
  file: "flupcode-guardrails.js",
  source: String.raw`// Installed by FlupCode for OpenCode 2. Feeds the harness's failure/loop detector with opaque digests
// of tool calls and tool errors. It decides nothing and never waits on the harness. Regenerated when
// FlupCode starts the engine; edits here are overwritten.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_GUARDRAILS_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 500
})()
// The reader stopping a call is not a failure the detector should count.
const INTERRUPTED = /abort|interrupt|cancel/i

${ADAPTIVE_HELPERS}

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

export default {
  id: "flupcode-guardrails",
  setup: async (ctx) => {
    const base = harnessBaseURL()
    if (base === undefined) return
    const token = await readToken()
    if (token === undefined) return
    // The harness's adaptive project id is the project directory: the plugin's location.
    const projectID = ctx.location && ctx.location.directory
    const observe = (sessionID, observation) => {
      if (typeof sessionID !== "string" || !sessionID || !projectID) return
      void fetch(base + "/harness/adaptive/guardrails", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ projectID, sessionID, observation }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }).catch(() => {})
    }
    await ctx.tool.hook("execute.before", (input) => {
      if (typeof input.tool !== "string" || !input.tool) return
      observe(input.sessionID, { kind: "call", tool: named(input.tool), argsDigest: digest(input.input), callID: input.id })
    })
    await ctx.tool.hook("execute.after", (input) => {
      if (input.status !== "error" || typeof input.tool !== "string") return
      const message = input.error && typeof input.error.message === "string" ? input.error.message : ""
      if (INTERRUPTED.test(message)) return
      observe(input.sessionID, { kind: "error", tool: named(input.tool), errorDigest: digest(message), callID: input.id })
    })
  },
}
`,
}

/** session-metrics: each step's usage and latency and each tool's output size, for the cost baseline. */
export const SESSION_METRICS_PLUGIN_V2 = {
  file: "flupcode-session-metrics.js",
  source: String.raw`// Installed by FlupCode for OpenCode 2. Posts each model step's token usage, cost and latency, each
// finished tool's output size and each compaction to the loopback harness, which folds them into one
// row per turn. Only counts, ids, names and timings travel. Regenerated when FlupCode starts the
// engine; edits here are overwritten.
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_METRICS_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 2000
})()
const MAX_TRACKED = 2000
const MAX_READ_PATHS = 1000

${ADAPTIVE_HELPERS}

function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_TRACKED) map.delete(map.keys().next().value)
}

const count = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)
const text = (value) => (typeof value === "string" && value ? value : undefined)

function tokensOf(tokens) {
  const cache = tokens && tokens.cache
  return {
    input: count(tokens && tokens.input),
    output: count(tokens && tokens.output),
    reasoning: count(tokens && tokens.reasoning),
    cacheRead: count(cache && cache.read),
    cacheWrite: count(cache && cache.write),
  }
}

function contentBytes(content) {
  if (typeof content === "string") return Buffer.byteLength(content)
  if (!Array.isArray(content)) return 0
  return content.reduce((total, item) => total + (item && typeof item.text === "string" ? Buffer.byteLength(item.text) : 0), 0)
}

// What the inbox holds, by id: only a user's input starts a turn.
const inputs = new Map()
// The user message each session's turn answers.
const prompts = new Map()
const steps = new Map()
const tools = new Map()
const sent = new Map()
// A read of a file the session read before its last compaction is a re-read (AH-D04).
const reads = new Map()

function once(key) {
  if (sent.has(key)) return false
  remember(sent, key, true)
  return true
}

function readsOf(sessionID) {
  const known = reads.get(sessionID)
  if (known) return known
  const fresh = { seen: new Set(), before: new Set() }
  remember(reads, sessionID, fresh)
  return fresh
}

function reread(sessionID, tool, file) {
  if (tool !== "read" || !file) return false
  const state = readsOf(sessionID)
  const again = state.before.delete(file)
  if (state.seen.size < MAX_READ_PATHS) state.seen.add(file)
  return again
}

function firstOutput(stepID) {
  const step = steps.get(stepID)
  if (step && step.firstAt === undefined) step.firstAt = Date.now()
}

function observe(event) {
  const data = (event && event.data) || {}
  const sessionID = text(data.sessionID)
  if (!sessionID) return
  const stepID = text(data.assistantMessageID)
  switch (event.type) {
    case "session.inbox.enqueued":
      if (text(data.inboxID)) remember(inputs, data.inboxID, data.item && data.item.type)
      return
    case "session.inbox.delivered":
      if (inputs.get(data.inboxID) === "user") remember(prompts, sessionID, data.inboxID)
      return
    case "session.step.started": {
      if (!stepID) return
      const model = data.model || {}
      remember(steps, stepID, {
        turnID: prompts.get(sessionID) || stepID,
        providerID: text(model.providerID),
        modelID: text(model.id),
        agent: text(data.agent),
        startedAt: Date.now(),
        firstAt: undefined,
      })
      return
    }
    case "session.text.started":
    case "session.reasoning.started":
      return firstOutput(stepID)
    // The call's name comes as its input starts streaming; its finished input, without the name, after.
    case "session.tool.input.started":
      firstOutput(stepID)
      if (text(data.id) && text(data.name)) remember(tools, data.id, { name: data.name, tool: named(data.name) })
      return
    case "session.tool.called": {
      const tool = text(data.id) ? tools.get(data.id) : undefined
      const input = data.input || {}
      if (!tool) return
      if (tool.name === "skill") tool.skill = text(input.name)
      if (tool.name === "read") tool.file = text(input.path)
      return
    }
    case "session.step.ended": {
      const step = steps.get(stepID)
      if (!step || !once("step:" + stepID)) return
      const now = Date.now()
      return {
        sessionID,
        observation: {
          kind: "step",
          id: stepID,
          turnID: step.turnID,
          ...(step.providerID ? { providerID: step.providerID } : {}),
          ...(step.modelID ? { modelID: step.modelID } : {}),
          ...(step.agent ? { agent: step.agent } : {}),
          tokens: tokensOf(data.tokens),
          cost: count(data.cost),
          ms: Math.max(0, now - step.startedAt),
          ...(step.firstAt !== undefined ? { firstTokenMs: Math.max(0, step.firstAt - step.startedAt) } : {}),
        },
      }
    }
    case "session.tool.success":
    case "session.tool.failed": {
      const callID = text(data.id)
      const tool = callID ? tools.get(callID) : undefined
      if (!tool || !once("tool:" + callID)) return
      const step = steps.get(stepID)
      const again = event.type === "session.tool.success" && reread(sessionID, tool.tool, tool.file)
      return {
        sessionID,
        observation: {
          kind: "tool",
          id: callID,
          turnID: (step && step.turnID) || prompts.get(sessionID) || stepID,
          tool: tool.tool,
          error: event.type === "session.tool.failed",
          bytes: contentBytes(data.content),
          ...(tool.skill ? { skill: tool.skill } : {}),
          ...(again ? { reread: true } : {}),
        },
      }
    }
    case "session.compaction.ended": {
      const id = text(data.inputID) || text(data.messageID)
      if (!id || !once("compaction:" + id)) return
      const state = readsOf(sessionID)
      state.before = new Set(state.seen)
      return { sessionID, observation: { kind: "compaction", id, turnID: id } }
    }
  }
}

export default {
  id: "flupcode-session-metrics",
  setup: async (ctx) => {
    const base = harnessBaseURL()
    if (base === undefined) return
    const token = await readToken()
    if (token === undefined) return
    const projectID = ctx.location && ctx.location.directory
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        // Every location's events, and this plugin runs once per location: only its own count here.
        if (event.location && event.location.directory && event.location.directory !== projectID) continue
        const selected = observe(event)
        if (!selected || !selected.observation.turnID) continue
        void fetch(base + "/harness/adaptive/metrics", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({ ...(projectID ? { projectID } : {}), sessionID: selected.sessionID, observation: selected.observation }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        }).catch(() => {})
      }
    })().catch(() => {})
    return () => controller.abort()
  },
}
`,
}

/** compaction-anchors: the goal, the files read and the open errors, handed to the compaction prompt. */
export const COMPACTION_ANCHORS_PLUGIN_V2 = {
  file: "flupcode-compaction-anchors.js",
  source: String.raw`// Installed by FlupCode for OpenCode 2. Hands the engine's compaction request the session's anchors
// (the goal, the files edited and read, the errors still open) as one capped block after its own
// system prompt. Summarising stays the engine's; a slow or absent harness adds nothing. Regenerated
// when FlupCode starts the engine; edits here are overwritten.
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_ANCHORS_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 1000
})()
// Kept in step with ANCHOR_BLOCK_LIMIT, ANCHOR_PREFIX and ANCHOR_SUFFIX in
// packages/harness-server/src/adaptive/compaction-anchors.ts.
const BLOCK_LIMIT = 1536
const PREFIX = "<compaction_anchors>\n"
const SUFFIX = "\n</compaction_anchors>"
const MOST_READS = 30
const GOAL_LIMIT = 300
const PATH_LIMIT = 1000
const MAX_SESSIONS = 500

${ADAPTIVE_HELPERS}

function remember(map, key, value) {
  map.delete(key)
  map.set(key, value)
  if (map.size > MAX_SESSIONS) map.delete(map.keys().next().value)
}

const goals = new Map()
const reads = new Map()

// The session's first user text is its goal; 2.x hands each part as { type: "text", text }.
function firstUserGoal(messages) {
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "user") continue
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
    const text = (Array.isArray(content) ? content : [])
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim()
    if (text) return text.slice(0, GOAL_LIMIT)
  }
  return undefined
}

function recordRead(sessionID, file) {
  if (typeof sessionID !== "string" || !sessionID) return
  if (typeof file !== "string" || !file || file.length > PATH_LIMIT) return
  const previous = (reads.get(sessionID) || []).filter((entry) => entry !== file)
  remember(reads, sessionID, [file, ...previous].slice(0, MOST_READS))
}

// The block is pushed only when it is exactly the harness's box and within the cap.
function anchorBlock(value) {
  if (typeof value !== "string" || Buffer.byteLength(value) > BLOCK_LIMIT) return undefined
  if (!value.startsWith(PREFIX) || !value.endsWith(SUFFIX)) return undefined
  const inner = value.slice(PREFIX.length, value.length - SUFFIX.length)
  return inner.includes("<") || inner.includes(">") ? undefined : value
}

export default {
  id: "flupcode-compaction-anchors",
  setup: async (ctx) => {
    const base = harnessBaseURL()
    if (base === undefined) return
    const token = await readToken()
    if (token === undefined) return
    const projectID = ctx.location && ctx.location.directory
    await ctx.session.hook("context", (input) => {
      if (goals.has(input.sessionID)) return
      const goal = firstUserGoal(input.messages)
      if (goal) remember(goals, input.sessionID, goal)
    })
    await ctx.tool.hook("execute.after", (input) => {
      if (input.tool === "read") recordRead(input.sessionID, input.input && input.input.path)
    })
    await ctx.session.hook("compaction", async (input) => {
      try {
        const goal = goals.get(input.sessionID)
        const response = await fetch(base + "/harness/adaptive/anchors", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer " + token },
          body: JSON.stringify({
            ...(projectID ? { projectID } : {}),
            sessionID: input.sessionID,
            ...(goal ? { goal } : {}),
            reads: reads.get(input.sessionID) || [],
          }),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })
        if (!response.ok) return
        const answer = await response.json().catch(() => undefined)
        const block = anchorBlock(answer && answer.data && answer.data.block)
        // After the engine's own instructions, for the compaction request only.
        if (block) input.system.push({ type: "text", text: block })
      } catch {
        // Compaction never waits on or fails because of the harness.
      }
    })
  },
}
`,
}

/** tool-trim: a large tool output stored whole in the harness and replaced by its head, tail and a ref. */
export const TOOL_TRIM_PLUGIN_V2 = {
  file: "flupcode-tool-trim.js",
  source: String.raw`// Installed by FlupCode for OpenCode 2. Replaces a large tool output with its head, tail and an
// evidence ref the harness stores, and registers evidence_read to read any range of it back. Fails
// open: anything short of a confirmed store leaves the output as the tool produced it. Regenerated
// when FlupCode starts the engine; edits here are overwritten.
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const MIN_TRIM_BYTES = 4096
const MAX_TRIM_BYTES = 8 * 1024 * 1024
const EVIDENCE_READ_TOOL = "evidence_read"
const REF = /^[0-9a-f]{16}$/
const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_TOOL_TRIM_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 2000
})()
const BREAKER_THRESHOLD = 3
const BREAKER_OPEN_MS = 60 * 1000
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000
const POLICY_TTL_MS = 30 * 1000

${ADAPTIVE_HELPERS}

let failures = 0
let quietUntil = 0
let probing = false
let policy = undefined

function admit(now) {
  if (now < quietUntil) return false
  if (failures < BREAKER_THRESHOLD) return true
  if (probing) return false
  probing = true
  return true
}

function settle(data, now) {
  probing = false
  if (!data) {
    failures++
    if (failures >= BREAKER_THRESHOLD) quietUntil = now + BREAKER_OPEN_MS
    return
  }
  failures = 0
  const hint = data.retryAfterMs
  if (typeof hint === "number" && Number.isFinite(hint) && hint > 0) quietUntil = now + Math.min(hint, MAX_RETRY_AFTER_MS)
  const next = data.policy
  if (next && typeof next.thresholdBytes === "number" && Array.isArray(next.exempt))
    policy = {
      thresholdBytes: next.thresholdBytes,
      maxStoredBytes: typeof next.maxStoredBytes === "number" ? next.maxStoredBytes : MAX_TRIM_BYTES,
      exempt: next.exempt.filter((tool) => typeof tool === "string"),
      at: now,
    }
}

function candidate(tool, bytes, now) {
  if (tool === EVIDENCE_READ_TOOL) return false
  if (bytes <= MIN_TRIM_BYTES || bytes > MAX_TRIM_BYTES) return false
  if (!policy || now - policy.at > POLICY_TTL_MS) return true
  return bytes > policy.thresholdBytes && bytes <= policy.maxStoredBytes && !policy.exempt.includes(tool)
}

async function call(base, token, route, payload) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  const body = await response.json().catch(() => undefined)
  const data = body && typeof body === "object" ? body.data : undefined
  return { status: response.status, data: data && typeof data === "object" ? data : undefined }
}

function replacementOf(data, original) {
  if (!data || data.trimmed !== true) return undefined
  if (typeof data.ref !== "string" || !REF.test(data.ref)) return undefined
  const text = data.replacement
  if (typeof text !== "string" || text.length >= original.length) return undefined
  return text.includes("evidence:" + data.ref) ? { ref: data.ref, text } : undefined
}

// What the model is sent: a 2.x result's content, as text.
function textOf(result) {
  if (!result) return undefined
  if (typeof result.content === "string") return result.content
  if (!Array.isArray(result.content) || result.content.some((part) => !part || part.type !== "text")) return undefined
  return result.content.map((part) => part.text).join("\n")
}

export default {
  id: "flupcode-tool-trim",
  setup: async (ctx) => {
    const base = harnessBaseURL()
    if (base === undefined) return
    const token = await readToken()
    if (token === undefined) return
    await ctx.tool.hook("execute.after", async (input) => {
      try {
        if (input.status !== "completed" || typeof input.sessionID !== "string") return
        const tool = named(input.tool)
        const original = textOf(input.result)
        if (typeof original !== "string") return
        const now = Date.now()
        if (!candidate(tool, Buffer.byteLength(original), now) || !admit(now)) return
        const answer = await call(base, token, "/harness/adaptive/tool-trim", {
          sessionID: input.sessionID,
          tool,
          callID: input.id,
          output: original,
        }).catch(() => undefined)
        const data = answer && answer.status === 200 ? answer.data : undefined
        settle(data, Date.now())
        const replacement = replacementOf(data, original)
        if (!replacement) return
        // The model reads the content; the structured output stays for the transcript.
        input.result = {
          ...input.result,
          content: [{ type: "text", text: replacement.text }],
          metadata: { ...(input.result.metadata || {}), evidenceRef: replacement.ref },
        }
      } catch {
        // Fails open: the output stays as the tool produced it.
      }
    })
    await ctx.tool.transform((editor) => {
      editor.add({
        name: EVIDENCE_READ_TOOL,
        description:
          "Read back a tool output that was trimmed to save context. A trimmed output says 'evidence:<ref>' and shows only its head and tail; call this with that ref and a range to see any other part of it. Only outputs trimmed in this session can be read.",
        input: {
          type: "object",
          properties: {
            ref: { type: "string", description: "The ref from the trimmed output, e.g. 3f9a1c2b7d4e5f60 (an 'evidence:' prefix is accepted)." },
            range: {
              type: "string",
              description:
                "Which part to read: 'START-END' for 1-based line numbers, inclusive (e.g. '40-120'); 'N' or 'N-' to read from line N; 'bytes:START-END' for byte offsets; or 'all' to read from the start. Each call returns a bounded slice and names the range to read next.",
            },
          },
          required: ["ref", "range"],
        },
        options: { codemode: false },
        execute: async (input, context) => {
          const ref = String((input && input.ref) || "").trim()
          const range = String((input && input.range) || "")
          const answer = await call(base, token, "/harness/adaptive/evidence/read", {
            sessionID: context.sessionID,
            ref,
            range,
          }).catch(() => undefined)
          const say = (content) => ({ content })
          if (!answer) return say("The evidence store is not reachable right now. Try again shortly, or re-run the original tool.")
          if (answer.status === 200 && answer.data && typeof answer.data.text === "string") return say(answer.data.text)
          if (answer.status === 404)
            return say(ref + " is not available: it was evicted from the local evidence store or belongs to another session. Re-run the original tool if you need it.")
          if (answer.status === 400)
            return say("That is not a readable evidence ref or range. Use the 16-character ref from 'evidence:<ref>' and a range such as '40-120'.")
          return say("The evidence store could not answer (HTTP " + answer.status + "). Re-run the original tool if you need the output.")
        },
      })
    })
  },
}
`,
}

/**
 * relevance: the harness's acting relevance line on a user turn (FH-04, ADR-0021), with the same
 * cache discipline as on 1.x: decided once, at the first request of a turn, pinned to that turn's user
 * message and rendered as the same bytes on every later request, never in the system prompt. 2.x hands
 * the request's messages with their ids but not their times, so a turn is decided only when its user
 * message was admitted by this process (the `prompt` hook) a moment ago: a session first seen after a
 * restart never pins a line onto a message the provider already cached without one.
 */
export const RELEVANCE_PLUGIN_V2 = {
  file: "flupcode-relevance.js",
  source: String.raw`// Installed by FlupCode for OpenCode 2. Adds the harness's acting relevance line to a user turn. It
// asks the loopback harness once per turn, pins the answer to that turn's user message and renders the
// same bytes on every request, so the prompt cache is never rewritten by it. Regenerated when
// FlupCode starts the engine; edits here are overwritten.
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const OBJECTIVE_LIMIT = 500
const DECIDE_WINDOW_MS = 5 * 60 * 1000
const IDLE_MS = 65 * 60 * 1000
const MAX_SESSIONS = 500
const MAX_LINES_PER_SESSION = 200
const MAX_ADMITTED = 2000
const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_RELEVANCE_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 500
})()
const BREAKER_THRESHOLD = 3
const BREAKER_OPEN_MS = 60 * 1000
const MAX_RETRY_AFTER_MS = 10 * 60 * 1000

// Kept in step with skill-line.ts in packages/harness-server/src/adaptive: anything that is not
// exactly the names-only box is refused, so a hostile peer on the loopback port adds nothing.
const SKILL_LINE_PREFIX = "<skill_relevance>Possibly relevant skills: "
const SKILL_LINE_SUFFIX = ". Consider loading one only if it clearly applies; otherwise ignore.</skill_relevance>"
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i
const MAX_LINE_SKILLS = 3
const MAX_SKILL_NAME_LENGTH = 64
const MAX_LINE_LENGTH = 300

${ADAPTIVE_HELPERS}

let failures = 0
let quietUntil = 0
let probing = false

function admit(now) {
  if (now < quietUntil) return false
  if (failures < BREAKER_THRESHOLD) return true
  if (probing) return false
  probing = true
  return true
}

function settle(answer, now) {
  probing = false
  if (!answer) {
    failures++
    if (failures >= BREAKER_THRESHOLD) quietUntil = now + BREAKER_OPEN_MS
    return
  }
  failures = 0
  const hint = answer.retryAfterMs
  if (typeof hint === "number" && Number.isFinite(hint) && hint > 0) quietUntil = now + Math.min(hint, MAX_RETRY_AFTER_MS)
}

function namesOnlyLine(value) {
  if (typeof value !== "string" || value.length > MAX_LINE_LENGTH) return undefined
  if (!value.startsWith(SKILL_LINE_PREFIX) || !value.endsWith(SKILL_LINE_SUFFIX)) return undefined
  const names = value.slice(SKILL_LINE_PREFIX.length, value.length - SKILL_LINE_SUFFIX.length).split(", ")
  if (names.length < 1 || names.length > MAX_LINE_SKILLS) return undefined
  if (!names.every((name) => SKILL_NAME.test(name) && name.length <= MAX_SKILL_NAME_LENGTH)) return undefined
  return value
}

// The user messages this process admitted, by id: when, and the text the user wrote.
const admitted = new Map()
// Per session: the user message last decided, and the line pinned to each message that got one.
const sessions = new Map()

function touch(sessionID, now) {
  const entry = sessions.get(sessionID) || { decided: undefined, lines: new Map(), at: now }
  entry.at = now
  sessions.delete(sessionID)
  sessions.set(sessionID, entry)
  for (const [id, other] of sessions) {
    if (sessions.size <= 1) break
    if (now - other.at > IDLE_MS || sessions.size > MAX_SESSIONS) sessions.delete(id)
    else break
  }
  return entry
}

function pin(entry, messageID, line) {
  entry.lines.set(messageID, line)
  if (entry.lines.size > MAX_LINES_PER_SESSION) entry.lines.delete(entry.lines.keys().next().value)
}

// Each pinned line after the parts of its own user message, built only from the pinned string.
function render(messages, lines) {
  for (const message of messages) {
    if (!message || message.role !== "user" || typeof message.id !== "string") continue
    const line = lines.get(message.id)
    if (line === undefined) continue
    if (typeof message.content === "string") message.content = [{ type: "text", text: message.content }]
    if (!Array.isArray(message.content)) continue
    if (message.content.some((part) => part && part.type === "text" && part.text === line)) continue
    message.content.push({ type: "text", text: line })
  }
}

async function requestAnswer(base, token, projectID, sessionID, messageID, objective) {
  const response = await fetch(base + "/harness/adaptive/relevance", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + token },
    body: JSON.stringify({ projectID, sessionID, messageID, objective }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) return undefined
  const body = await response.json().catch(() => undefined)
  const data = body && typeof body === "object" ? body.data : undefined
  if (!data || typeof data !== "object") return undefined
  return { line: namesOnlyLine(data.line), retryAfterMs: data.retryAfterMs }
}

export default {
  id: "flupcode-relevance",
  setup: async (ctx) => {
    const base = harnessBaseURL()
    if (base === undefined) return
    const token = await readToken()
    if (token === undefined) return
    const projectID = ctx.location && ctx.location.directory
    await ctx.session.hook("prompt", (input) => {
      const text = input.prompt && typeof input.prompt.text === "string" ? input.prompt.text : ""
      admitted.set(input.messageID, { at: Date.now(), objective: text.slice(0, OBJECTIVE_LIMIT) })
      if (admitted.size > MAX_ADMITTED) admitted.delete(admitted.keys().next().value)
    })
    await ctx.session.hook("context", async (input) => {
      try {
        const messages = input.messages
        const last = Array.isArray(messages) ? messages[messages.length - 1] : undefined
        const now = Date.now()
        const entry = touch(input.sessionID, now)
        const turn = last && last.role === "user" && typeof last.id === "string" ? admitted.get(last.id) : undefined
        if (turn && now - turn.at <= DECIDE_WINDOW_MS && entry.decided !== last.id && !entry.lines.has(last.id)) {
          // Marked before the request: whatever it answers, fails or times out is this turn's pin.
          entry.decided = last.id
          if (admit(now)) {
            const answer = await requestAnswer(base, token, projectID, input.sessionID, last.id, turn.objective).catch(
              () => undefined,
            )
            settle(answer, Date.now())
            if (answer && answer.line) pin(entry, last.id, answer.line)
          }
        }
        render(messages, entry.lines)
      } catch {
        // Any failure adds nothing, and the turn is unaffected.
      }
    })
  },
}
`,
}

/**
 * cache-selection: old, large tool outputs replaced with a placeholder at a cold step (AH-D03,
 * ADR-0024), by the same `selectForCache` the 1.x plugin runs. 2.x hands the `context` hook the
 * request's messages in the provider's shape (a tool's result is a `tool` message after the call) and
 * without times, which the cold boundary is made of. So the plugin keeps each message's time from the
 * events (a user message's delivery, an assistant step's end), lays the request out in the 1.x shape
 * the selection reads, and writes each placeholder back into its `tool-result`. A message whose time
 * it never saw (one from before the engine started) is never a boundary, so nothing is trimmed on a
 * guess.
 */
export const CACHE_SELECTION_PLUGIN_V2 = {
  file: "flupcode-cache-selection.js",
  source: String.raw`// Installed by FlupCode for OpenCode 2. Replaces old, large tool outputs with a short placeholder at
// the steps where the prompt cache is cold anyway, so they stop costing context. Off unless the
// harness says otherwise; any failure leaves the request exactly as it was. Regenerated when FlupCode
// starts the engine; edits here are overwritten.
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

${CACHE_SELECTION_SOURCE}

const REFRESH_MS = (() => {
  const raw = Number(process.env.FLUPCODE_SELECTION_REFRESH_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 1000
})()
const FETCH_TIMEOUT_MS = (() => {
  const raw = Number(process.env.FLUPCODE_SELECTION_FETCH_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 1000
})()
const POLICY_TTL_MS = 5 * 60 * 1000
const DEFAULT_COLD_GAP_MS = 65 * 60 * 1000
const MAX_KEEP_RECENT_TURNS = 50
const MAX_COLD_GAP_MS = 24 * 60 * 60 * 1000
const OFF = { enabled: false, keepRecentTurns: 2, minSavingsTokens: 4096, coldGapMs: DEFAULT_COLD_GAP_MS }
const MAX_SESSIONS = 500
const MAX_TIMES = 20000

${ADAPTIVE_HELPERS}

let policy = undefined
let timer = undefined
const latches = new Map()
// When each user message was delivered and each assistant message's step ended, by message id.
const created = new Map()
const completed = new Map()

function keep(map, key, value) {
  map.set(key, value)
  if (map.size > MAX_TIMES) map.delete(map.keys().next().value)
}

function integerIn(value, min, max) {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
}

function policyOf(data) {
  if (!data || typeof data !== "object" || typeof data.enabled !== "boolean") return undefined
  if (!integerIn(data.keepRecentTurns, 0, MAX_KEEP_RECENT_TURNS)) return undefined
  if (!integerIn(data.minSavingsTokens, 0, Number.MAX_SAFE_INTEGER)) return undefined
  if (!integerIn(data.coldGapMs, 1, MAX_COLD_GAP_MS)) return undefined
  return {
    enabled: data.enabled,
    keepRecentTurns: data.keepRecentTurns,
    minSavingsTokens: data.minSavingsTokens,
    coldGapMs: data.coldGapMs,
  }
}

function holdoutOf(data) {
  const value = data ? data.holdoutFraction : undefined
  return typeof value === "number" && value >= 0 && value <= 0.5 ? value : 0
}

// A control-arm session of the holdout keeps every output, deterministically by its id.
function control(sessionID, fraction) {
  if (fraction <= 0) return false
  return createHash("sha256").update("selection:" + sessionID).digest().readUInt32BE(0) / 2 ** 32 < fraction
}

function pausedOf(data) {
  const list = data && Array.isArray(data.pausedSessions) ? data.pausedSessions : []
  return new Set(list.filter((id) => typeof id === "string").slice(0, MAX_SESSIONS))
}

async function refresh(base, token) {
  const response = await fetch(base + "/harness/adaptive/selection", {
    headers: { authorization: "Bearer " + token },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => undefined)
  if (!response || !response.ok) return
  const body = await response.json().catch(() => undefined)
  const data = body && typeof body === "object" ? body.data : undefined
  const next = policyOf(data)
  if (next) policy = { ...next, paused: pausedOf(data), holdout: holdoutOf(data), at: Date.now() }
}

function currentPolicy(now) {
  return policy && now - policy.at <= POLICY_TTL_MS ? policy : OFF
}

// The policy changes only at a cold step, so a switch flipped mid-session cannot rewrite a warm cache.
function latched(sessionID, view, current) {
  const held = latches.get(sessionID)
  const next = !held || coldStep(view, current.coldGapMs) ? current : held
  latches.delete(sessionID)
  latches.set(sessionID, next)
  while (latches.size > MAX_SESSIONS) latches.delete(latches.keys().next().value)
  return next
}

// The request in the 1.x shape the selection reads: one entry per user or assistant message, each
// assistant entry carrying its calls' text results as tool parts, which point back at the 2.x part.
function layout(messages) {
  const view = []
  const results = new Map()
  for (const message of messages) {
    if (!message || message.role !== "tool" || !Array.isArray(message.content)) continue
    for (const part of message.content) if (part && part.type === "tool-result") results.set(part.id, part)
  }
  for (const message of messages) {
    if (!message || (message.role !== "user" && message.role !== "assistant")) continue
    const id = typeof message.id === "string" ? message.id : undefined
    if (message.role === "user") {
      view.push({ info: { role: "user", time: { created: id ? created.get(id) : undefined } }, parts: [] })
      continue
    }
    const calls = Array.isArray(message.content) ? message.content.filter((part) => part && part.type === "tool-call") : []
    const parts = calls.flatMap((call) => {
      const result = results.get(call.id)
      if (!result || !result.result || result.result.type !== "text" || typeof result.result.value !== "string") return []
      return [{ type: "tool", tool: named(call.name), state: { status: "completed", output: result.result.value }, origin: result }]
    })
    view.push({ info: { role: "assistant", time: { completed: id ? completed.get(id) : undefined } }, parts })
  }
  return view
}

export default {
  id: "flupcode-cache-selection",
  setup: async (ctx) => {
    const base = harnessBaseURL()
    if (base === undefined) return
    const token = await readToken()
    if (token === undefined) return
    const directory = ctx.location && ctx.location.directory
    if (!timer) {
      void refresh(base, token)
      timer = setInterval(() => void refresh(base, token), REFRESH_MS)
      if (typeof timer.unref === "function") timer.unref()
    }
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.location && event.location.directory && event.location.directory !== directory) continue
        const data = event.data || {}
        if (event.type === "session.inbox.delivered" && typeof data.inboxID === "string") keep(created, data.inboxID, Date.now())
        if (event.type === "session.step.ended" && typeof data.assistantMessageID === "string")
          keep(completed, data.assistantMessageID, Date.now())
      }
    })().catch(() => {})
    await ctx.session.hook("context", (input) => {
      try {
        if (!Array.isArray(input.messages) || input.messages.length === 0) return
        const view = layout(input.messages)
        const current = currentPolicy(Date.now())
        const held = (current.paused && current.paused.has(input.sessionID)) || control(input.sessionID, current.holdout || 0)
        const effective = latched(input.sessionID, view, held ? { ...current, enabled: false } : current)
        if (!effective.enabled) return
        const result = selectForCache(view, effective)
        result.messages.forEach((message, index) => {
          if (message === view[index]) return
          message.parts.forEach((part, at) => {
            const before = view[index].parts[at]
            if (part.state.output !== before.state.output) before.origin.result = { type: "text", value: part.state.output }
          })
        })
      } catch {
        // Any failure leaves the request exactly as it arrived.
      }
    })
    return () => controller.abort()
  },
}
`,
}

export const PLUGINS_V2 = [
  REASONING_VARIANTS_PLUGIN_V2,
  TOOL_USES_PLUGIN_V2,
  SYSTEM_PROMPT_PLUGIN_V2,
  ARTIFACT_WRITE_PLUGIN_V2,
  EPISODE_EVENTS_PLUGIN_V2,
  RUNTIME_PROBE_PLUGIN_V2,
  GUARDRAILS_PLUGIN_V2,
  SESSION_METRICS_PLUGIN_V2,
  COMPACTION_ANCHORS_PLUGIN_V2,
  TOOL_TRIM_PLUGIN_V2,
  RELEVANCE_PLUGIN_V2,
  CACHE_SELECTION_PLUGIN_V2,
]
