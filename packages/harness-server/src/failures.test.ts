import { describe, expect, test } from "bun:test"
import { FAILURE_LIMIT, failureLine, locate, parseFailures } from "./failures"

const DIRECTORY = "/work/demo"

/**
 * The samples below are **copied from real runs** on 17/09/2026, not written from memory of the
 * formats: `tsgo --noEmit`, `bun test` and `oxlint` against a deliberately broken file. Only the
 * paths were shortened. A parser tested against invented output is a parser tested against the
 * author's assumptions.
 */

const TSC = `../../../tmp/fix/src/broken.ts(4,7): error TS2322: Type 'number' is not assignable to type 'string'.
../../../tmp/fix/src/broken.ts(5,28): error TS2339: Property 'nope' does not exist on type 'string'.`

const BUN_TEST = `bun test v1.4.2 (744846f84)

src/a.test.ts:
1 | import { expect, test } from "bun:test"
2 | test("adds", () => {
3 |   expect(1 + 1).toBe(3)
                    ^
error: expect(received).toBe(expected)

Expected: 3
Received: 2

      at <anonymous> (/work/demo/src/a.test.ts:3:17)
(fail) adds [3.67ms]
1 | import { expect, test } from "bun:test"
2 | test("adds", () => {
3 |   expect(1 + 1).toBe(3)
4 | })
5 | test("throws", () => {
6 |   throw new Error("boom")
                            ^
error: boom
      at <anonymous> (/work/demo/src/a.test.ts:6:25)
(fail) throws [0.38ms]

 1 pass
 2 fail
 2 expect() calls
Ran 3 tests across 1 file. [23.00ms]`

const OXLINT = `  x eslint(no-debugger): \`debugger\` statement is not allowed
   ,-[src/lint.ts:2:3]
 1 | export function bad(a) {
 2 |   debugger
   :   ^^^^^^^^
 3 |   const dup = { x: 1, x: 2 }
   \`----
  help: Remove the debugger statement

  x eslint(no-dupe-keys): Duplicate key 'x'
   ,-[src/lint.ts:3:17]
 2 |   debugger
 3 |   const dup = { x: 1, x: 2 }
   :                 |     |
   \`----
  help: Consider removing the duplicated key

Found 0 warnings and 2 errors.`

describe("tsc and tsgo", () => {
  test("reads the file, the line, the code and the message", () => {
    const { failures } = parseFailures(TSC, DIRECTORY)

    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({
      line: 4,
      column: 7,
      rule: "TS2322",
      message: "Type 'number' is not assignable to type 'string'.",
    })
    // The path is relative to the command's directory and climbs out of the project; it stays
    // absolute rather than being pretended into a file the diff could show.
    expect(failures[0]!.file).toBe("/tmp/fix/src/broken.ts")
  })

  test("a path inside the project comes back relative, so it can anchor on a diff", () => {
    const { failures } = parseFailures("src/a.ts(1,1): error TS1005: ';' expected.", DIRECTORY)
    expect(failures[0]!.file).toBe("src/a.ts")
  })
})

describe("bun test", () => {
  test("anchors each failure on the line the stack points at", () => {
    const { failures } = parseFailures(BUN_TEST, DIRECTORY)

    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({
      file: "src/a.test.ts",
      line: 3,
      column: 17,
      message: "expect(received).toBe(expected)",
      rule: "adds",
    })
    expect(failures[1]).toMatchObject({ line: 6, message: "boom", rule: "throws" })
  })

  test("the passing test does not become a failure", () => {
    // Three tests ran and one passed. A reader who sees three findings stops trusting the number.
    expect(parseFailures(BUN_TEST, DIRECTORY).failures.some((failure) => failure.rule === "passes")).toBe(false)
  })
})

describe("oxlint", () => {
  test("splits the rule from the message and reads the location under it", () => {
    const { failures } = parseFailures(OXLINT, DIRECTORY)

    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({
      file: "src/lint.ts",
      line: 2,
      column: 3,
      rule: "eslint(no-debugger)",
      message: "`debugger` statement is not allowed",
    })
    expect(failures[1]).toMatchObject({ line: 3, rule: "eslint(no-dupe-keys)" })
  })

  test("the `help:` line is not a second finding", () => {
    expect(parseFailures(OXLINT, DIRECTORY).failures.every((failure) => !failure.message.startsWith("Remove"))).toBe(
      true,
    )
  })
})

/**
 * The same oxlint run, as the server actually receives it: Unicode markers, box drawing, and 24-bit
 * colour codes **inside the path**. Copied byte for byte from a spawn on 17/09/2026, because the
 * ASCII sample above — which is what the same command prints when piped from a terminal — hid all
 * three differences and the reader written against it found nothing here.
 */
const OXLINT_SPAWNED = [
  "[38;2;225;80;80;1m×[0m [38;2;225;80;80;1meslint(no-debugger): `debugger` statement is not allowed[0m",
  "   ╭─[[38;2;92;157;255;1msrc/lint.ts[0m:2:3]",
  " [2m1[0m │ export function bad(a) {",
  " [2m2[0m │   debugger",
  "   · [38;2;246;87;248m  ────────[0m",
  " [2m3[0m │   const dup = { x: 1, x: 2 }",
  "   ╰────",
  "[38;2;106;159;181m  help: [0mRemove the debugger statement",
].join("\n")

describe("oxlint as the server receives it", () => {
  test("reads the Unicode form, in colour, the same as the ASCII one", () => {
    const { failures } = parseFailures(OXLINT_SPAWNED, DIRECTORY)

    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({
      file: "src/lint.ts",
      line: 2,
      column: 3,
      rule: "eslint(no-debugger)",
      message: "`debugger` statement is not allowed",
    })
  })

  test("no finding is left with a message that says nothing", () => {
    // Before the reader knew this shape, the generic one matched the frame and produced findings
    // whose entire text was "]". A comment with no words in it is worse than no comment.
    for (const failure of parseFailures(OXLINT_SPAWNED, DIRECTORY).failures) {
      expect(failure.message).toMatch(/\p{L}/u)
    }
  })
})

describe("the last reader", () => {
  test("handles path:line:col, which is what most other tools print", () => {
    // ESLint's compact formatter, ruff, mypy, go vet and most compilers share this shape.
    const { failures } = parseFailures("src/a.ts:12:5: Unexpected console statement", DIRECTORY)
    expect(failures[0]).toMatchObject({ file: "src/a.ts", line: 12, column: 5 })
    expect(failures[0]!.message).toBe("Unexpected console statement")
  })

  test("does not run when a real reader already answered", () => {
    // The bun sample carries `src/a.test.ts:3:17` inside its stack frames. Running both would
    // report the same failure twice, once with the test's name and once without.
    const { failures } = parseFailures(BUN_TEST, DIRECTORY)
    expect(failures.filter((failure) => failure.line === 3)).toHaveLength(1)
  })

  test("ignores node_modules, because nobody can act on a frame inside a framework", () => {
    const stack = "at run (node_modules/vitest/dist/chunk.js:120:9)"
    expect(parseFailures(stack, DIRECTORY).failures).toEqual([])
  })

  test("a version number is not a file", () => {
    expect(parseFailures("bun test v1.4.2 (744846f84)\n 1 pass\n", DIRECTORY).failures).toEqual([])
  })
})

describe("what is kept", () => {
  test("the same failure printed twice is one failure", () => {
    const twice = `src/a.ts(1,1): error TS1005: ';' expected.\nsrc/a.ts(1,1): error TS1005: ';' expected.`
    expect(parseFailures(twice, DIRECTORY).failures).toHaveLength(1)
  })

  test("a flood is capped, and the real number is still reported", () => {
    const many = Array.from({ length: 120 }, (_, i) => `src/a.ts(${i + 1},1): error TS2322: Nope.`).join("\n")
    const parsed = parseFailures(many, DIRECTORY)
    expect(parsed.failures).toHaveLength(FAILURE_LIMIT)
    // The count is of everything found, not of what fitted: a capped list that also caps the number
    // would tell the reader there are fifty problems when there are a hundred and twenty.
    expect(parsed.total).toBe(120)
  })

  test("nothing at all is not an error", () => {
    expect(parseFailures(undefined, DIRECTORY)).toEqual({ failures: [], total: 0 })
    expect(parseFailures("   ", DIRECTORY)).toEqual({ failures: [], total: 0 })
  })

  test("colour codes do not end up inside the message", () => {
    const coloured = "[31msrc/a.ts(2,1): error TS2322: Type 'a' is wrong.[39m"
    expect(parseFailures(coloured, DIRECTORY).failures[0]!.message).toBe("Type 'a' is wrong.")
  })
})

describe("locate", () => {
  test("keeps a file outside the directory absolute", () => {
    expect(locate("/elsewhere/a.ts", DIRECTORY)).toBe("/elsewhere/a.ts")
    expect(locate("/work/demo/src/a.ts", DIRECTORY)).toBe("src/a.ts")
    expect(locate("./src/a.ts", DIRECTORY)).toBe("src/a.ts")
  })
})

describe("failureLine", () => {
  test("reads as one line, with the rule when there is one", () => {
    expect(failureLine({ file: "src/a.ts", line: 4, message: "Nope", rule: "TS2322" })).toBe(
      "src/a.ts:4 — Nope (TS2322)",
    )
    expect(failureLine({ file: "src/a.ts", message: "Nope" })).toBe("src/a.ts — Nope")
  })
})
