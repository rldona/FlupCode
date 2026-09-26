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
    if (response.status !== 200) return undefined
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
  if (code === "unknown_action") return "Esa acción ya no existe; reinicia el motor."
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

/** The engine plugins FlupCode owns. */
const PLUGINS = [
  REASONING_VARIANTS_PLUGIN,
  TOOL_USES_PLUGIN,
  SYSTEM_PROMPT_PLUGIN,
  ARTIFACT_WRITE_PLUGIN,
  DELIVERY_PLUGIN,
  WEB_ACTIONS_PLUGIN,
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
