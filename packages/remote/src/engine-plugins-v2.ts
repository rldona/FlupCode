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

export const PLUGINS_V2 = [
  REASONING_VARIANTS_PLUGIN_V2,
  TOOL_USES_PLUGIN_V2,
  SYSTEM_PROMPT_PLUGIN_V2,
  ARTIFACT_WRITE_PLUGIN_V2,
  EPISODE_EVENTS_PLUGIN_V2,
]
