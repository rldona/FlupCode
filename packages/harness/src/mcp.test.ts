import { describe, expect, test } from "bun:test"
import { mcpToolName, mcpToolUses } from "./mcp"
import type { McpServer } from "./engine-types"

const server = (name: string) => ({ name, status: { status: "connected" } }) as unknown as McpServer

describe("mcpToolUses", () => {
  test("reads the tools a session ran back into the servers that offer them", () => {
    const servers = [server("docs"), server("linear")]
    const uses = mcpToolUses(servers, {
      [mcpToolName("docs", "search")]: { count: 2 },
      [mcpToolName("docs", "read")]: { count: 5 },
      [mcpToolName("linear", "create_issue")]: { count: 1 },
      bash: { count: 9 },
      read: { count: 3 },
    })

    // Only the MCP servers, and the busiest tool first.
    expect(uses).toEqual([
      { server: "docs", tools: [{ name: "read", count: 5 }, { name: "search", count: 2 }] },
      { server: "linear", tools: [{ name: "create_issue", count: 1 }] },
    ])
  })

  test("finds a server whose name the engine had to rewrite", () => {
    // The engine writes `my docs` into a tool name as `my_docs`.
    const uses = mcpToolUses([server("my docs")], { [mcpToolName("my docs", "search")]: { count: 1 } })
    expect(uses).toEqual([{ server: "my docs", tools: [{ name: "search", count: 1 }] }])
  })

  test("says nothing about a server that ran nothing, or about a tool that is not one", () => {
    const uses = mcpToolUses([server("docs"), server("linear")], { [mcpToolName("linear", "create_issue")]: { count: 1 } })
    expect(uses.map((entry) => entry.server)).toEqual(["linear"])
    expect(mcpToolUses([server("docs")], { bash: { count: 4 } })).toEqual([])
  })
})
