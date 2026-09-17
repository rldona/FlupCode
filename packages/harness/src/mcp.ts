import type { McpServer } from "./engine-types"

/**
 * The engine names an MCP tool after the server that offers it: the server's name, then the tool's,
 * with everything outside letters, digits, `_` and `-` turned into an underscore (`mcp/catalog.ts`).
 * The rule is reproduced here so a name can be read back into the two halves it was built from.
 */
export const mcpName = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export const mcpToolName = (server: string, tool: string) => `${mcpName(server)}_${mcpName(tool)}`

export type McpToolUse = {
  server: string
  tools: Array<{ name: string; count: number }>
}

/**
 * Which of the tools a session ran belong to which of its MCP servers.
 *
 * The engine never reports what a server offers, so this is the other half of the answer: the calls
 * it made, read back into servers. Anything that matches no server is not an MCP tool — the engine's
 * own tools carry no prefix — and servers that ran nothing are left out rather than listed empty.
 */
export function mcpToolUses(
  servers: McpServer[],
  tools: Record<string, { count: number }>,
): McpToolUse[] {
  return servers.flatMap((server) => {
    const prefix = `${mcpName(server.name)}_`
    const mine = Object.entries(tools)
      .filter(([name]) => name.startsWith(prefix))
      .map(([name, use]) => ({ name: name.slice(prefix.length), count: use.count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    return mine.length > 0 ? [{ server: server.name, tools: mine }] : []
  })
}
