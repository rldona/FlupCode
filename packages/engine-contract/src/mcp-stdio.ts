import { answer } from "./mcp"

/** The stdio MCP server of `mcpStdioCommand`: one JSON-RPC message per line, each way. */
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
