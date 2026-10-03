import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { tokenLines } from "./markdown-worker-protocol"

describe("code lines from the highlighter's tokens", () => {
  test("one string of HTML per line, each token in its own colour", () => {
    expect(
      tokenLines([
        ["const", "color:var(--syntax-keyword)"],
        [" x = ", "color:var(--syntax-variable)"],
        ["\n", ""],
        ["return", "color:var(--syntax-keyword)"],
      ]),
    ).toEqual([
      '<span style="color:var(--syntax-keyword)">const</span><span style="color:var(--syntax-variable)"> x = </span>',
      '<span style="color:var(--syntax-keyword)">return</span>',
    ])
  })

  test("the code is escaped, and so is the style", () => {
    expect(tokenLines([["a < b && c", 'font-family:"x"']])).toEqual([
      '<span style="font-family:&quot;x&quot;">a &lt; b &amp;&amp; c</span>',
    ])
  })

  test("an empty line stays a line, so line numbers keep matching", () => {
    expect(
      tokenLines([
        ["a", ""],
        ["\n", ""],
        ["\n", ""],
        ["b", ""],
      ]),
    ).toHaveLength(3)
    expect(tokenLines([])).toEqual([""])
  })
})

describe("one highlighter (UX-06)", () => {
  const SRC = join(import.meta.dir, "..")
  const sources = () =>
    readdirSync(SRC, { recursive: true })
      .filter((name): name is string => typeof name === "string" && /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
      .map((name) => ({ name, text: readFileSync(join(SRC, name), "utf8") }))

  test("only the markdown worker and its parts load a highlighter", () => {
    // Everything else asks the worker through markdown/code-lines.ts, so a file, a diff and a code
    // block in a message are coloured by the same grammar and the same theme.
    const loaders = sources()
      .filter((file) => /from "(?:shiki|@shikijs\/[\w-]+|marked-shiki|highlight\.js|prismjs|lowlight)"/.test(file.text))
      .map((file) => file.name)
      .sort()
    expect(loaders).toEqual(["markdown/markdown.worker.ts", "markdown/marked-parser.ts", "markdown/marked-theme.ts"])
  })

  test("and nothing colours code by hand", () => {
    // The regular-expression highlighter this replaced wrote `fc-tok-*` spans.
    const offenders = sources()
      .filter((file) => /fc-tok-/.test(file.text))
      .map((file) => file.name)
    expect(offenders).toEqual([])
    expect(readFileSync(join(SRC, "styles", "shell.css"), "utf8")).not.toContain(".fc-tok-")
  })
})
