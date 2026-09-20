import { describe, expect, test } from "bun:test"
import { agentAllows, mcpAccess } from "./mcp-access"
import type { AgentFile } from "./types"

const agent = (name: string, tools?: Record<string, unknown>): AgentFile => ({
  name,
  path: `/agents/${name}.md`,
  scope: "project",
  root: "/agents",
  fields: tools ? { tools } : {},
  prompt: "",
  bytes: 0,
})

describe("who can use an MCP server (H-34)", () => {
  test("a tool named after the server is access, and one named for the server is too", () => {
    expect(agentAllows("github", { github_search: true })).toBe(true)
    expect(agentAllows("github", { github: true })).toBe(true)
    expect(agentAllows("github", { "github_*": true })).toBe(true)
    expect(agentAllows("github", { "*": true })).toBe(true)
    // Nothing said is not access: a server nobody allowed is not silently on.
    expect(agentAllows("github", {})).toBe(false)
    expect(agentAllows("github", { github_search: false })).toBe(false)
    // And a disabled server is not rescued by a tool of another name.
    expect(agentAllows("github", { github: false, other_tool: true })).toBe(false)
  })

  test("lists the agents that allow each server, in file order", () => {
    const access = mcpAccess(
      ["github", "sentry"],
      [
        agent("build", { github_search: true, sentry: true }),
        agent("plan", { github: true }),
        agent("review", { "*": true }),
      ],
    )
    expect(access).toEqual([
      { server: "github", agents: ["build", "plan", "review"] },
      { server: "sentry", agents: ["build", "review"] },
    ])
  })

  test("an agent with no tools map allows nothing", () => {
    expect(mcpAccess(["github"], [agent("build")])).toEqual([{ server: "github", agents: [] }])
  })
})
