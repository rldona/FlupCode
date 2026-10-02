import { appendFileSync } from "node:fs"

/**
 * A stand-in for Playwright MCP in extension mode (BU-02), for the contract tests: a stdio MCP server
 * that offers four of its tools under their real names (`browser_tabs`, `browser_navigate`,
 * `browser_snapshot`, `browser_click`) and answers in its format (`### Open tabs`, `### Page` with
 * `- Page URL:`). There is no browser: one tab, "handed over" at `FAKE_BROWSER_START`, whose address
 * changes when the agent navigates. Every call that reaches it is appended to `FAKE_BROWSER_LOG`, so a
 * test can tell a refused call never ran.
 */

/** The command an engine config runs to start it, with where it logs and where its tab starts. */
export function mcpBrowserCommand() {
  return [process.execPath, import.meta.path]
}

type Message = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> }

const tools = [
  {
    name: "browser_tabs",
    description: "List, create, close, or select a browser tab.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["list", "new", "close", "select"] }, index: { type: "number" } },
      required: ["action"],
    },
  },
  {
    name: "browser_navigate",
    description: "Navigate to a URL",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "browser_snapshot",
    description: "Capture accessibility snapshot of the current page",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Perform click on a web page",
    inputSchema: {
      type: "object",
      properties: { element: { type: "string" }, ref: { type: "string" } },
      required: ["ref"],
    },
  },
]

let page = process.env.FAKE_BROWSER_START ?? "https://handed.example/"
// A test makes a handful of calls; this many means something is calling in a loop. The server stops
// rather than let its log grow without bound.
const MAX_CALLS = 500
let calls = 0

function call(name: string, args: Record<string, unknown>) {
  if (++calls > MAX_CALLS) {
    process.stderr.write(`fake browser: more than ${MAX_CALLS} calls, stopping\n`)
    process.exit(1)
  }
  if (process.env.FAKE_BROWSER_LOG)
    appendFileSync(process.env.FAKE_BROWSER_LOG, `${JSON.stringify({ name, args, page })}\n`)
  if (name === "browser_navigate" && typeof args.url === "string") page = args.url
  const state = `### Page\n- Page URL: ${page}\n- Page Title: Fake page`
  if (name === "browser_tabs") return `### Open tabs\n- 0: (current) [Fake page](${page})`
  if (name === "browser_snapshot") return `${state}\n### Snapshot\n\`\`\`yaml\n- button "Go" [ref=e1]\n\`\`\``
  if (name === "browser_click") return `### Ran Playwright code\n\`\`\`js\nawait page.click()\n\`\`\`\n${state}`
  return state
}

function answer(message: Message) {
  if (message.id === undefined) return undefined
  const result = (() => {
    if (message.method === "initialize")
      return {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-playwright", version: "1.0.0" },
      }
    if (message.method === "ping") return {}
    if (message.method === "tools/list") return { tools }
    if (message.method === "tools/call") {
      const params = message.params as { name: string; arguments?: Record<string, unknown> }
      return { content: [{ type: "text", text: call(params.name, params.arguments ?? {}) }] }
    }
    return undefined
  })()
  if (result === undefined)
    return { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `No method ${message.method}` } }
  return { jsonrpc: "2.0", id: message.id, result }
}

if (import.meta.main) {
  let buffer = ""
  for await (const chunk of process.stdin) {
    buffer += String(chunk)
    for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end).trim()
      buffer = buffer.slice(end + 1)
      if (!line) continue
      const reply = answer(JSON.parse(line))
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`)
    }
  }
}
