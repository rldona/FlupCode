import { describe, expect, test } from "bun:test"
import { allowsTools, effect, mcpAccess } from "./mcp-access"
import type { AgentFile } from "./types"

const agent = (name: string, fields: Record<string, unknown> = {}): AgentFile => ({
  name,
  path: `/agents/${name}.md`,
  scope: "project",
  root: "/agents",
  fields,
  prompt: "",
  bytes: 0,
})

// The agent that found the problem: written for 1.x, it denies everything and names its tools.
const publisher = {
  permission: {
    "*": "deny",
    notes_get_brief: "allow",
    notes_check: "allow",
    publish: "allow",
  },
}

describe("who can use an MCP server (H-34)", () => {
  test("nothing said is allowed, as the engine does", () => {
    expect(allowsTools("github", {})).toBe(true)
    expect(effect("github_search", {})).toBe("allow")
  })

  test("the last matching permission wins, with wildcards", () => {
    expect(allowsTools("notes", publisher)).toBe(true)
    expect(allowsTools("github", publisher)).toBe(false)
    expect(allowsTools("github", { permission: { "github_*": "deny" } })).toBe(false)
    expect(allowsTools("github", { permission: { "*": "deny", "github_*": "ask" } })).toBe(true)
    expect(allowsTools("github", { permission: { "github_*": "allow", "*": "deny" } })).toBe(false)
    expect(allowsTools("github", { permission: "deny" })).toBe(false)
  })

  test("a map of input patterns counts by the pattern an MCP call is checked with", () => {
    expect(allowsTools("github", { permission: { "*": "deny", github_search: { "*": "ask" } } })).toBe(true)
    expect(allowsTools("github", { permission: { "*": "deny", github_search: { "src/*": "allow" } } })).toBe(false)
  })

  test("the 1.x tools map still counts, a bare key being the whole server", () => {
    expect(allowsTools("github", { tools: { github: false } })).toBe(false)
    expect(allowsTools("github", { tools: { github_search: false } })).toBe(true)
    expect(allowsTools("github", { tools: { "*": false, github_search: true } })).toBe(true)
    // `permission` comes after `tools`, so it has the last word.
    expect(allowsTools("github", { tools: { github_search: true }, permission: { "*": "deny" } })).toBe(false)
  })

  test("Code Mode hides a server from an agent that denies execute", () => {
    const agents = [
      agent("publisher", publisher),
      agent("build"),
      agent("coder", { ...publisher, permission: { ...publisher.permission, execute: "allow" } }),
    ]
    expect(mcpAccess([{ name: "notes", codeMode: true }], agents)).toEqual([
      { server: "notes", agents: ["build", "coder"], blocked: ["publisher"] },
    ])
    // Without Code Mode the tools are offered one by one, and the agent's own list is enough.
    expect(mcpAccess([{ name: "notes", codeMode: false }], agents)).toEqual([
      { server: "notes", agents: ["publisher", "build", "coder"], blocked: [] },
    ])
  })

  test("an agent that cannot use the server is neither listed nor blocked, and a disabled one is skipped", () => {
    const agents = [agent("publisher", publisher), agent("off", { disable: true })]
    expect(mcpAccess([{ name: "github", codeMode: true }], agents)).toEqual([
      { server: "github", agents: [], blocked: [] },
    ])
  })
})
