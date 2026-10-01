import type { AgentFile } from "./types"

/**
 * Which agents can use which MCP server (H-34), by the rules OpenCode 2 applies.
 *
 * The engine names a server's tools `<server>_<tool>` and checks every call against the agent's
 * rules: its `permission` map (`{"*": "deny", "github_search": "allow"}`), and the 1.x `tools` map it
 * still reads (`{"github_search": true}`, `{"github": false}` for the whole server). The last rule that
 * matches wins, and nothing said is allowed. A tool whose rule is `deny` is not offered at all.
 *
 * Code Mode (the default for a server) does not offer the tools one by one either: the model reaches
 * them through the engine's `execute` tool. An agent that denies `execute` (an agent written for 1.x
 * with `"*": "deny"` and a list of tools) then never sees the server, though every tool is allowed.
 */

export const CODE_MODE_TOOL = "execute"

export type McpAccess = {
  server: string
  /** The agents that can use it, by name, in the order the files were listed. */
  agents: string[]
  /** The agents that allow its tools but deny `execute`, so Code Mode hides the server from them. */
  blocked: string[]
}

export function mcpAccess(servers: { name: string; codeMode: boolean }[], agents: AgentFile[]): McpAccess[] {
  const active = agents.filter((agent) => agent.fields.disable !== true)
  return servers.map((server) => {
    const reaching = active.filter((agent) => allowsTools(server.name, agent.fields))
    const blocked = server.codeMode ? reaching.filter((agent) => effect(CODE_MODE_TOOL, agent.fields) === "deny") : []
    return {
      server: server.name,
      agents: reaching.filter((agent) => !blocked.includes(agent)).map((agent) => agent.name),
      blocked: blocked.map((agent) => agent.name),
    }
  })
}

/** Whether any tool of the server can be allowed: one the rules name, or one they do not. */
export function allowsTools(server: string, fields: Record<string, unknown>) {
  const prefix = `${server}_`
  // An unnamed tool stands for every tool the rules do not mention by name.
  const probes = [
    `${prefix}\u0000`,
    ...rules(fields).flatMap((rule) => (rule.action.startsWith(prefix) ? [rule.action] : [])),
  ]
  return probes.some((action) => effect(action, fields) !== "deny")
}

/** What the agent's rules say about a tool, called with any input: the last matching rule, else allow. */
export function effect(action: string, fields: Record<string, unknown>) {
  return rules(fields).findLast((rule) => matches(rule.action, action))?.effect ?? "allow"
}

type Effect = "allow" | "ask" | "deny"

/** The agent's rules in the order the engine applies them: the 1.x `tools` map, then `permission`. */
function rules(fields: Record<string, unknown>) {
  const tools = isRecord(fields.tools)
    ? Object.entries(fields.tools).flatMap(([key, value]) =>
        typeof value === "boolean"
          ? // 1.x read a key without an underscore as a whole server as well as a tool of that name.
            [key, ...(key.includes("_") || key.includes("*") ? [] : [`${key}_*`])].map((action) => ({
              action,
              effect: (value ? "allow" : "deny") as Effect,
            }))
          : [],
      )
    : []
  const permission = fields.permission
  if (isEffect(permission)) return [...tools, { action: "*", effect: permission }]
  if (!isRecord(permission)) return tools
  return [
    ...tools,
    ...Object.entries(permission).flatMap(([action, value]) => {
      if (isEffect(value)) return [{ action, effect: value }]
      // A map of input patterns: an MCP tool is checked with `*`, so only a pattern matching that counts.
      if (!isRecord(value)) return []
      const found = Object.entries(value).findLast(([pattern, inner]) => isEffect(inner) && matches(pattern, "*"))
      return found ? [{ action, effect: found[1] as Effect }] : []
    }),
  ]
}

/** The engine's wildcard: `*` is any run of characters and `?` one. */
function matches(pattern: string, value: string) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".")
  return new RegExp(`^${source}$`, "s").test(value)
}

function isEffect(value: unknown): value is Effect {
  return value === "allow" || value === "ask" || value === "deny"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
