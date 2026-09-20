import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { setLocale, t } from "./i18n"

const source = readFileSync(join(import.meta.dir, "i18n.ts"), "utf8")

/**
 * The Spanish map, read from the source rather than from the module.
 *
 * A duplicate key is a type error, but only once the file is typechecked — and an object literal
 * silently keeps the *last* one, so a translation quietly replaces an earlier one that was right.
 * This has happened four times while the screens of this backlog were being built, every time by
 * appending a block near another block that already had the word.
 */
function keysInOrder() {
  const start = source.indexOf("const ES:")
  const end = source.indexOf("\n}", start)
  const body = source.slice(start, end).split("\n")
  const keys: string[] = []
  for (const line of body) {
    const match = /^ {2}(?:"([^"]+)"|'([^']+)'|([A-Za-z_][A-Za-z0-9_]*)):/.exec(line)
    if (match) keys.push(match[1] ?? match[2] ?? match[3]!)
  }
  return keys
}

describe("the Spanish map", () => {
  test("has no key twice", () => {
    const keys = keysInOrder()
    const seen = new Set<string>()
    const twice = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)))
    expect(twice).toEqual([])
  })

  test("is big enough that the check above is reading the real thing", () => {
    // A regular expression that matched nothing would make the test above pass for ever.
    expect(keysInOrder().length).toBeGreaterThan(300)
  })
})

describe("t", () => {
  test("answers the key itself in English, and the translation in Spanish", () => {
    setLocale("en")
    expect(t("Runs")).toBe("Runs")
    setLocale("es")
    expect(t("Runs")).toBe("Ejecuciones")
    setLocale("en")
  })

  test("fills the holes in a template", () => {
    expect(t("{n} files", { n: 3 })).toBe("3 files")
  })

  test("a key nobody translated is still readable, not blank", () => {
    setLocale("es")
    expect(t("Something nobody translated")).toBe("Something nobody translated")
    setLocale("en")
  })
})
