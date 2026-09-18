import { describe, expect, test } from "bun:test"
import { mcpLatency, mcpToolName, mcpToolUses } from "./mcp"
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

describe("mcpLatency", () => {
  test("averages the timed calls by the server that owns them", () => {
    const servers = [server("docs"), server("linear")]
    const calls = [
      { tool: mcpToolName("docs", "search"), ms: 100 },
      { tool: mcpToolName("docs", "search"), ms: 300 },
      { tool: mcpToolName("linear", "create_issue"), ms: 50 },
      { tool: "bash", ms: 9000 },
    ]

    expect(mcpLatency(servers, calls)).toEqual([
      { server: "docs", calls: 2, averageMs: 200, slowestMs: 300 },
      { server: "linear", calls: 1, averageMs: 50, slowestMs: 50 },
    ])
  })

  test("counts only calls that reported a duration, and says nothing about a server with none", () => {
    const servers = [server("docs"), server("linear")]
    // A call still running has no end, so it is not counted as instantaneous.
    const calls = [
      { tool: mcpToolName("docs", "search"), start: 1_000 },
      { tool: mcpToolName("linear", "create_issue") },
    ]
    expect(mcpLatency(servers, calls)).toEqual([])
  })
})
