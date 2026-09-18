import type { AgentFile } from "./types"

/**
 * Which agents can use which MCP server (H-34).
 *
 * An agent's `tools` map is where access lives in the file the engine reads: `{"server_tool": true}`
 * enables one, `{"server": false}` disables the whole server, and `"*"` is everything. This is the
 * same rule the engine applies to the names it prefixes with the server, read here so the MCP panel
 * can say who can reach a server without opening every agent file by hand.
 */

const enabled = (value: unknown) => value !== false

/** Whether a tools map allows a server, by its own key, its prefix, or the wildcard. */
export function agentAllows(server: string, tools: Record<string, unknown> | undefined) {
  if (!tools) return false
  if (tools["*"] === true) return true
  if (server in tools) return enabled(tools[server])
  if (tools[`${server}_*`] === true) return true
  return Object.entries(tools).some(([key, value]) => key.startsWith(`${server}_`) && value === true)
}

export type McpAccess = {
  server: string
  /** The agents whose files allow it, by name, in the order the files were listed. */
  agents: string[]
}

export function mcpAccess(servers: string[], agents: AgentFile[]): McpAccess[] {
  return servers.map((server) => ({
    server,
    agents: agents
      .filter((agent) => {
        const tools = agent.fields.tools
        return !!tools && typeof tools === "object" && agentAllows(server, tools as Record<string, unknown>)
      })
      .map((agent) => agent.name),
  }))
}
