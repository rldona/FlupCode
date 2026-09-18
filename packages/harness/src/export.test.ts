import { describe, expect, test } from "bun:test"
import { sessionJson, sessionMarkdown } from "./export"

const at = new Date("2026-09-18T12:00:00.000Z")

const messages = [
  { type: "user", text: "Fix the login", files: [{ name: "shot.png", mime: "image/png", uri: "data:image/png;base64,x" }] },
  {
    type: "assistant",
    content: [
      { type: "reasoning", text: "Maybe the token is stale" },
      { type: "text", text: "I changed the token check." },
      {
        type: "tool",
        name: "edit",
        state: { status: "completed", content: [{ type: "text", text: "1 file changed" }] },
      },
    ],
  },
  { type: "compaction", summary: "Earlier turns" },
  { type: "synthetic", text: "ignored" },
]

describe("a session as markdown", () => {
  test("names the title, the date, and both speakers", () => {
    const text = sessionMarkdown("Fix the login", messages, {}, at)
    expect(text).toStartWith("# Fix the login")
    expect(text).toContain("_Exported 2026-09-18T12:00:00.000Z_")
    expect(text).toContain("## User")
    expect(text).toContain("I changed the token check.")
    // A synthetic turn is not part of what a reader wants to read.
    expect(text).not.toContain("ignored")
  })

  test("lists attachments by name, and says which are images", () => {
    expect(sessionMarkdown("t", messages, {}, at)).toContain("- image: shot.png")
  })

  test("reasoning is a collapsed block, and can be left out", () => {
    expect(sessionMarkdown("t", messages, {}, at)).toContain("<summary>Reasoning</summary>")
    expect(sessionMarkdown("t", messages, { reasoning: false }, at)).not.toContain("Maybe the token is stale")
  })

  test("a tool call is named, and its output only when asked for", () => {
    expect(sessionMarkdown("t", messages, {}, at)).toContain("> Tool: edit")
    expect(sessionMarkdown("t", messages, {}, at)).not.toContain("1 file changed")
    expect(sessionMarkdown("t", messages, { toolOutput: true }, at)).toContain("1 file changed")
  })

  test("a compaction is marked, and tools can be dropped entirely", () => {
    expect(sessionMarkdown("t", messages, {}, at)).toContain("Context compacted")
    expect(sessionMarkdown("t", messages, { tools: false }, at)).not.toContain("> Tool:")
  })

  test("no double blank lines, and it ends with one newline", () => {
    const text = sessionMarkdown("t", messages, {}, at)
    expect(text).not.toContain("\n\n\n")
    expect(text.endsWith("\n")).toBe(true)
  })
})

describe("a session as JSON", () => {
  test("keeps the messages exactly, under a title and a date", () => {
    const parsed = JSON.parse(sessionJson("Fix the login", messages, at))
    expect(parsed.title).toBe("Fix the login")
    expect(parsed.exportedAt).toBe("2026-09-18T12:00:00.000Z")
    expect(parsed.messages).toEqual(messages)
  })
})
