import { describe, expect, test } from "bun:test"
import { applyMention, filterCommands, mentionItems, mentionToken, refsIn, slashQuery } from "./composer-menus"

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

  test("HF-6: inline artifacts are offered by title and cite by id", () => {
    const items = mentionItems("verif", {
      files: [],
      agents: [],
      artifacts: [
        { path: "reports/review.md", title: "Review" },
        { id: "abc123-def", title: "verify — passed", kind: "verdict" },
      ],
    })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: "artifact",
      value: "artifact:abc123-def",
      label: "@verify — passed",
      hint: "verdict",
    })
  })

  test("a pack is offered, and carries the refs it stands for", () => {
    const [pack] = mentionItems("rev", {
      files: [],
      agents: [],
      artifacts: [],
      packs: [{ name: "review", refs: ["@src/a.ts", "@artifact:report"] }],
    })
    expect(pack).toMatchObject({ kind: "pack", value: "review", label: "@review", insert: "@src/a.ts @artifact:report" })
  })
})

describe("the refs in a draft", () => {
  test("every @token, in order and without repeats", () => {
    expect(refsIn("@src/a.ts and @artifact:report, again @src/a.ts")).toEqual(["@src/a.ts", "@artifact:report"])
  })

  test("a draft with no mention has none", () => {
    expect(refsIn("just words")).toEqual([])
    expect(refsIn("an email me@here.com")).toEqual(["@here.com"])
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
