import { describe, expect, test } from "bun:test"
import { CHIP_TEXT_LIMIT, chipForRef, chipRefs, hunkChip, resolveChips, textChip, withChips, type ContextChip } from "./context-chip"
import { parseHunks } from "./patch"

const annotation: ContextChip = {
  id: "c1",
  type: "preview",
  label: "localhost:5173/settings",
  source: "http://localhost:5173/settings",
  artifactID: "a1",
  image: "data:image/png;base64,AAAA",
  note: "The button overlaps\nthe title",
}

const file = chipForRef("@src/a.ts")!
const artifact = chipForRef("@artifact:art_1", "Run report")!

describe("a context chip (BU-06)", () => {
  test("a preview annotation resolves into a quoted block and its picture", () => {
    const resolved = resolveChips([annotation])
    expect(resolved.files).toEqual([{ uri: "data:image/png;base64,AAAA", name: "preview-a1.png" }])
    expect(resolved.text).toBe(
      [
        "[Preview annotation of http://localhost:5173/settings, artifact a1]",
        "> The button overlaps",
        "> the title",
        "The attached image is the page as FlupCode's preview showed it, with the marked areas numbered.",
      ].join("\n"),
    )
  })

  test("the blocks follow what the reader typed, or stand alone", () => {
    const block = resolveChips([annotation]).text
    expect(withChips("Fix this", block)).toStartWith("Fix this\n\n[Preview annotation of")
    expect(withChips("", block)).toStartWith("[Preview annotation of")
    expect(withChips("Only text", "")).toBe("Only text")
  })

  test("a chip without a kept picture says nothing about an artifact", () => {
    const resolved = resolveChips([{ id: "c2", type: "preview", label: "x", source: "http://localhost:3000/" }])
    expect(resolved.files).toEqual([])
    expect(resolved.text).toStartWith("[Preview annotation of http://localhost:3000/]")
  })
})

describe("one chip model for everything the reader points at (UX-05)", () => {
  test("a ref becomes a file or an artifact chip; anything else stays text", () => {
    expect(file).toMatchObject({ type: "file", ref: "@src/a.ts", label: "src/a.ts" })
    expect(artifact).toMatchObject({ type: "artifact", ref: "@artifact:art_1", label: "Run report" })
    expect(chipForRef("@artifact:verdict")).toMatchObject({ type: "artifact", label: "verdict" })
    expect(chipForRef("@/etc/passwd")).toBeUndefined()
    expect(chipForRef("@../out.ts")).toBeUndefined()
    expect(chipForRef("@https://example.com")).toBeUndefined()
    expect(chipForRef("@")).toBeUndefined()
  })

  test("only files and artifacts are asked of the server, once each", () => {
    expect(chipRefs([file, artifact, annotation, { ...file, id: "again" }])).toEqual(["@src/a.ts", "@artifact:art_1"])
  })

  test("a file resolves to a file part the engine reads, not text", () => {
    const resolved = resolveChips([file], [{ ref: "@src/a.ts", uri: "file:///work/src/a.ts", name: "src/a.ts" }])
    expect(resolved).toEqual({
      text: "",
      files: [{ uri: "file:///work/src/a.ts", name: "src/a.ts" }],
      missing: [],
      cut: [],
    })
  })

  test("an artifact resolves to its quoted content, and says when it was cut", () => {
    const resolved = resolveChips(
      [artifact],
      [{ ref: "@artifact:art_1", quote: "--- Run report (report) ---\nAll green\n---", cut: true }],
    )
    expect(resolved.text).toBe("--- Run report (report) ---\nAll green\n---")
    expect(resolved.files).toEqual([])
    expect(resolved.cut).toEqual([artifact.id])
  })

  test("a file or an artifact the server cannot find is reported, so nothing is sent", () => {
    const resolved = resolveChips(
      [file, artifact],
      [
        { ref: "@src/a.ts", missing: true },
        { ref: "@artifact:art_1", quote: "q", cut: false },
      ],
    )
    expect(resolved.missing).toEqual([file.id])
  })

  test("without a server to ask, a file or an artifact goes as its ref, as typed text did", () => {
    expect(resolveChips([file, artifact])).toEqual({
      text: "@src/a.ts\n\n@artifact:art_1",
      files: [],
      missing: [],
      cut: [],
    })
  })

  test("a diff hunk is quoted with its file and lines", () => {
    const hunk: ContextChip = {
      id: "h1",
      type: "hunk",
      label: "a.ts:10-13",
      source: "src/a.ts",
      path: "src/a.ts",
      lines: "10-13",
      diff: "@@ -10,3 +10,4 @@\n-old\n+new\n",
    }
    expect(resolveChips([hunk]).text).toBe(
      ["[Diff hunk of src/a.ts, lines 10-13]", "```diff", "@@ -10,3 +10,4 @@", "-old", "+new", "```"].join("\n"),
    )
  })

  test("a hunk picked in a diff carries its file, the new file's lines and the hunk itself", () => {
    const [hunk] = parseHunks("@@ -10,3 +10,4 @@ export function handler() {\n   const a = 1\n-  return a\n+  const b = 2\n+  return a + b\n }\n")
    const chip = hunkChip("src/server/handler.ts", hunk!)
    expect(chip).toMatchObject({ type: "hunk", label: "handler.ts:10-13", path: "src/server/handler.ts", lines: "10-13" })
    expect(resolveChips([chip]).text).toBe(
      [
        "[Diff hunk of src/server/handler.ts, lines 10-13]",
        "```diff",
        "@@ -10 +10 @@ export function handler() {",
        "   const a = 1",
        "-  return a",
        "+  const b = 2",
        "+  return a + b",
        " }",
        "```",
      ].join("\n"),
    )
  })

  test("a terminal selection is quoted, in a fence its own backticks cannot close", () => {
    const chip = textChip("terminal", "npm test", "Terminal", "$ echo ```\n```")
    expect(resolveChips([chip]).text).toBe(["[Terminal selection]", "````", "$ echo ```", "```", "````"].join("\n"))
  })

  test("a failing check is quoted with its name and workflow", () => {
    const chip = textChip("check", "test (ubuntu)", "harness", "Error: expected 1 to be 2")
    expect(resolveChips([chip]).text).toBe(
      ["[Failing check test (ubuntu) (harness)]", "```", "Error: expected 1 to be 2", "```"].join("\n"),
    )
  })

  test("a long selection is cut where it is taken, and the chip says so", () => {
    const chip = textChip("terminal", "x", "Terminal", "y".repeat(CHIP_TEXT_LIMIT + 5))
    expect(chip.problem).toBe("cut")
    expect(chip.type === "terminal" && chip.text.length).toBe(CHIP_TEXT_LIMIT)
  })

  test("the blocks keep the chips' order", () => {
    const chip = textChip("terminal", "x", "Terminal", "out")
    const resolved = resolveChips(
      [artifact, chip, file],
      [
        { ref: "@artifact:art_1", quote: "QUOTE", cut: false },
        { ref: "@src/a.ts", uri: "file:///w/src/a.ts", name: "src/a.ts" },
      ],
    )
    expect(resolved.text).toBe("QUOTE\n\n[Terminal selection]\n```\nout\n```")
  })
})
