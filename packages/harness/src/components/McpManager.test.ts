import { describe, expect, test } from "bun:test"
import { DEFAULT_MCP_SCOPE, needsOAuth, pairsFrom, pairsToText } from "./McpManager"

describe("reading KEY=value lines", () => {
  test("one per line, trimmed, blanks and lines without a separator skipped", () => {
    expect(pairsFrom("API_KEY=abc\n\n  DEBUG = true  \nbroken\nEMPTY=\n")).toEqual({
      API_KEY: "abc",
      DEBUG: "true",
      EMPTY: "",
    })
  })

  test("a value with equals signs keeps them", () => {
    expect(pairsFrom("TOKEN=a=b=c")).toEqual({ TOKEN: "a=b=c" })
  })

  test("a line that starts with the separator is not a key", () => {
    expect(pairsFrom("=nope\nKEY=yes")).toEqual({ KEY: "yes" })
  })

  test("nothing at all is an empty map", () => {
    expect(pairsFrom("")).toEqual({})
  })
})

describe("writing them back", () => {
  test("round-trips, and nothing is an empty string", () => {
    const map = { A: "1", B: "two three" }
    expect(pairsFrom(pairsToText(map))).toEqual(map)
    expect(pairsToText(undefined)).toBe("")
  })
})

describe("which servers need OAuth", () => {
  const server = (status: unknown) => ({ name: "x", status }) as never
  test("only needs_auth does; the rest keep plain connect", () => {
    expect(needsOAuth(server({ status: "needs_auth" }))).toBe(true)
    expect(needsOAuth(server({ status: "connected" }))).toBe(false)
    expect(needsOAuth(server({ status: "failed", error: "nope" }))).toBe(false)
    expect(needsOAuth(server({ status: "disabled" }))).toBe(false)
    expect(needsOAuth(server(undefined))).toBe(false)
  })
})

describe("where a new server is written", () => {
  test("the editor defaults to Global", () => {
    expect(DEFAULT_MCP_SCOPE).toBe("global")
  })
})
