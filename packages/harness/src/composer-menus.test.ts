import { describe, expect, test } from "bun:test"
import { applyMention, filterCommands, mentionItems, mentionToken, slashQuery } from "./composer-menus"

describe("the slash menu", () => {
  test("opens only on a command being typed, and not in a plain chat", () => {
    expect(slashQuery("/rev", false)).toBe("rev")
    expect(slashQuery("/REV", false)).toBe("rev")
    expect(slashQuery("/rev now", false)).toBeUndefined()
    expect(slashQuery("hello", false)).toBeUndefined()
    expect(slashQuery("/rev", true)).toBeUndefined()
  })

  test("filters by name and caps the list", () => {
    const commands = Array.from({ length: 20 }, (_, index) => ({ name: `cmd${index}` }))
    commands.push({ name: "review" })
    expect(filterCommands(commands, "review").map((command) => command.name)).toEqual(["review"])
    expect(filterCommands(commands, "cmd")).toHaveLength(8)
    expect(filterCommands(commands, undefined)).toEqual([])
  })
})

describe("the @ menu", () => {
  test("opens on a mention being typed, and not in a plain chat", () => {
    expect(mentionToken("look at @src", false)).toBe("src")
    expect(mentionToken("look at @src now", false)).toBeUndefined()
    expect(mentionToken("no mention", false)).toBeUndefined()
    expect(mentionToken("@src", true)).toBeUndefined()
  })

  test("offers files, then agents, then artifacts, filtered by the token", () => {
    const items = mentionItems("rev", {
      files: [{ path: "src/review.ts", type: "file" }],
      agents: [{ id: "reviewer" }, { id: "builder" }],
      artifacts: [{ path: "reports/review.md", title: "Review" }],
    })
    expect(items.map((item) => `${item.kind}:${item.value}`)).toEqual([
      "file:src/review.ts",
      "agent:reviewer",
      "artifact:reports/review.md",
    ])
    expect(items[1]!.hint).toBe("agent")
    expect(items[0]!.label).toBe("@src/review.ts")
  })

  test("an empty token offers everything, capped", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ path: `f${index}` }))
    expect(mentionItems("", { files: many, agents: [], artifacts: [] })).toHaveLength(8)
  })
})

describe("picking a mention", () => {
  test("replaces the half-typed token and keeps what came before", () => {
    expect(applyMention("look at @sr", { kind: "file", value: "src/a.ts", label: "@src/a.ts" })).toBe(
      "look at @src/a.ts ",
    )
  })

  test("keeps text that already followed the token", () => {
    expect(applyMention("read @sr and tell me", { kind: "agent", value: "reviewer", label: "@reviewer" })).toContain(
      "and tell me",
    )
  })

  test("with no token it leaves the draft alone", () => {
    expect(applyMention("nothing here", { kind: "file", value: "a", label: "@a" })).toBe("nothing here")
  })
})
