import { describe, expect, test } from "bun:test"
import { normaliseSeverity, parseFindings } from "./findings"

const block = (body: string) => `Here is what I found.\n\n\`\`\`json\n${body}\n\`\`\`\n`

describe("parseFindings", () => {
  test("reads a fenced block at the end of an answer", () => {
    const text = block(
      JSON.stringify([
        { file: "src/app.ts", line: 42, severity: "high", title: "Unchecked index", detail: "It can be undefined." },
      ]),
    )
    expect(parseFindings(text)).toEqual({
      findings: [
        {
          file: "src/app.ts",
          line: 42,
          severity: "high",
          title: "Unchecked index",
          detail: "It can be undefined.",
        },
      ],
      unanchored: 0,
    })
  })

  test("accepts the names a model actually uses", () => {
    // The same finding, written three ways. Being strict about spelling loses real findings.
    const text = block(
      JSON.stringify([
        { path: "a.ts", lineNumber: 3, summary: "One", why: "because" },
        { filePath: "b.ts", start_line: "9", issue: "Two", details: "reason" },
        { filename: "c.ts", problem: "Three" },
      ]),
    )
    const { findings } = parseFindings(text)
    expect(findings.map((finding) => [finding.file, finding.line, finding.title])).toEqual([
      ["a.ts", 3, "One"],
      ["b.ts", 9, "Two"],
      ["c.ts", undefined, "Three"],
    ])
  })

  test("takes findings out of an object that wraps them", () => {
    const text = block(JSON.stringify({ findings: [{ file: "a.ts", title: "One" }] }))
    expect(parseFindings(text).findings).toHaveLength(1)
  })

  test("counts what it could not anchor instead of dropping it quietly", () => {
    // A finding with no file cannot become a comment on a line. Losing it in silence would make a
    // review claim to be complete when it is not.
    const text = block(JSON.stringify([{ title: "Something general" }, { file: "a.ts", title: "Anchored" }]))
    expect(parseFindings(text)).toMatchObject({ unanchored: 1 })
    expect(parseFindings(text).findings).toHaveLength(1)
  })

  test("a finding about the file has no line, rather than line zero", () => {
    const text = block(JSON.stringify([{ file: "a.ts", line: 0, title: "The whole file" }]))
    expect(parseFindings(text).findings[0]!.line).toBeUndefined()
  })

  test("normalises the path a model writes it with", () => {
    const text = block(JSON.stringify([{ file: "./src/a.ts", title: "One" }]))
    expect(parseFindings(text).findings[0]!.file).toBe("src/a.ts")
  })

  test("takes the last block, because an answer explains and then lists", () => {
    const text = [
      "Here is an example of the format:",
      "```json",
      '[{"file": "example.ts", "title": "Not a real finding"}]',
      "```",
      "And here is what I actually found:",
      "```json",
      '[{"file": "real.ts", "title": "A real one"}]',
      "```",
    ].join("\n")
    expect(parseFindings(text).findings.map((finding) => finding.file)).toEqual(["real.ts"])
  })

  test("nothing to parse is nothing, not a failure", () => {
    // This runs after every agent task, and most of them are not reviews.
    expect(parseFindings("I changed three files and the tests pass.")).toEqual({ findings: [], unanchored: 0 })
    expect(parseFindings(undefined)).toEqual({ findings: [], unanchored: 0 })
    expect(parseFindings("```json\nnot json at all\n```")).toEqual({ findings: [], unanchored: 0 })
  })

  test("an empty array is a clean review, not a parse failure", () => {
    expect(parseFindings(block("[]"))).toEqual({ findings: [], unanchored: 0 })
  })

  test("an entry with no title at all is not a finding", () => {
    expect(parseFindings(block(JSON.stringify([{ file: "a.ts" }]))).findings).toEqual([])
  })
})

describe("normaliseSeverity", () => {
  test("maps the words a model reaches for", () => {
    expect(normaliseSeverity("critical")).toBe("high")
    expect(normaliseSeverity("Blocker")).toBe("high")
    expect(normaliseSeverity("nit")).toBe("low")
    expect(normaliseSeverity("suggestion")).toBe("low")
  })

  test("anything it does not recognise is middling, never alarming", () => {
    // Guessing "high" for an unknown word would cry wolf on every review.
    expect(normaliseSeverity("spicy")).toBe("medium")
    expect(normaliseSeverity(undefined)).toBe("medium")
    expect(normaliseSeverity(7)).toBe("medium")
  })
})
