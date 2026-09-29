import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { applyEditsToFile, ConfigWriteError, readConfigText, requireReadable, serial, writeAtomic } from "./config-write"

const FORMAT = { insertSpaces: true, tabSize: 2 } as const

const scratch = (): { dir: string; path: string } => {
  const dir = mkdtempSync(join(tmpdir(), "flupcode-config-write-"))
  return { dir, path: join(dir, "opencode.jsonc") }
}

/** An edit to one leaf, the way both writers compose theirs. */
const editLeaf = (text: string, segments: string[], value: unknown): string =>
  applyEdits(text, modify(text, ["flupcode", "adaptive", ...segments], value, { formattingOptions: FORMAT }))

describe("reading a config file", () => {
  test("a missing file reads as an empty document, an existing one keeps its bytes", () => {
    const { dir, path } = scratch()
    expect(readConfigText(path)).toBe("")
    writeFileSync(path, '{ "theme": "dark" }\n')
    expect(readConfigText(path)).toBe('{ "theme": "dark" }\n')
    rmSync(dir, { recursive: true, force: true })
  })

  test("requireReadable accepts comments and trailing commas but refuses malformed JSONC", () => {
    expect(() => requireReadable('{ // note\n  "a": 1,\n}\n', "x")).not.toThrow()
    expect(() => requireReadable('{ "a": }', "x")).toThrow(ConfigWriteError)
    expect(() => requireReadable('{ "a": }', "x")).toThrow(/not valid JSONC/)
  })

  test("a path that exists but cannot be read is config_unreadable, told apart from ENOENT", () => {
    const { dir, path } = scratch()
    // A directory at the candidate name makes `readFileSync` fail with something other than ENOENT —
    // the same shape as an unreadable file, reproducible without `chmod` and without root.
    mkdirSync(path)
    const failure = (() => {
      try {
        readConfigText(path)
        return undefined
      } catch (cause) {
        return cause
      }
    })()
    expect(failure).toBeInstanceOf(ConfigWriteError)
    expect(failure).toMatchObject({ status: 500, code: "config_unreadable" })
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("writing one leaf", () => {
  test("keeps comments, order and every other key untouched", async () => {
    const { dir, path } = scratch()
    writeFileSync(
      path,
      `{
  // the theme, do not lose me
  "theme": "dark",
  "flupcode": {
    "actions": {
      "keep": { "tool": "do_keep" }
    },
    "adaptive": { "enabled": true }
  },
  "small_model": "openai/gpt-4o-mini"
}
`,
    )

    await applyEditsToFile(path, (text) => editLeaf(text, ["shadow"], false))

    const after = readFileSync(path, "utf8")
    expect(after).toContain("// the theme, do not lose me")
    expect(after).toContain('"small_model": "openai/gpt-4o-mini"')
    expect(after).toContain('"keep"')
    const parsed = parse(after, [], { allowTrailingComma: true }) as {
      theme: string
      flupcode: { adaptive: unknown; actions: Record<string, unknown> }
    }
    expect(parsed.theme).toBe("dark")
    expect(parsed.flupcode.adaptive).toEqual({ enabled: true, shadow: false })
    expect(parsed.flupcode.actions.keep).toEqual({ tool: "do_keep" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("null removes only that leaf", async () => {
    const { dir, path } = scratch()
    writeFileSync(path, '{ "flupcode": { "adaptive": { "enabled": false, "shadow": true } } }\n')

    await applyEditsToFile(path, (text) => editLeaf(text, ["shadow"], undefined))

    expect(JSON.parse(readFileSync(path, "utf8")).flupcode.adaptive).toEqual({ enabled: false })
    rmSync(dir, { recursive: true, force: true })
  })

  test("a malformed file is refused and left byte-identical", async () => {
    const { dir, path } = scratch()
    const broken = '{ "a": }'
    writeFileSync(path, broken)

    await expect(applyEditsToFile(path, (text) => editLeaf(text, ["shadow"], false))).rejects.toMatchObject({
      code: "invalid_config",
    })
    expect(readFileSync(path, "utf8")).toBe(broken)
    rmSync(dir, { recursive: true, force: true })
  })

  test("writes atomically: no temp file survives a successful write", async () => {
    const { dir, path } = scratch()
    writeFileSync(path, "{}\n")

    await applyEditsToFile(path, (text) => editLeaf(text, ["enabled"], true))

    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  test("refuses a target it cannot read, leaving no temp file behind", async () => {
    const { dir, path } = scratch()
    mkdirSync(path)

    await expect(applyEditsToFile(path, (text) => editLeaf(text, ["shadow"], false))).rejects.toMatchObject({
      status: 500,
      code: "config_unreadable",
    })
    expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("the shared serial queue", () => {
  test("serializes read-modify-write passes, so neither increment is lost", async () => {
    const { dir, path } = scratch()
    writeFileSync(path, JSON.stringify({ n: 0 }))

    const increment = () =>
      serial(async () => {
        const value = (JSON.parse(readConfigText(path)) as { n: number }).n
        // Yield between read and write so an unserialized writer would interleave here.
        await Bun.sleep(5)
        await writeAtomic(path, JSON.stringify({ n: value + 1 }))
      })

    await Promise.all([increment(), increment()])

    expect((JSON.parse(readFileSync(path, "utf8")) as { n: number }).n).toBe(2)
    rmSync(dir, { recursive: true, force: true })
  })

  test("an action-like pass and an adaptive-like pass share the queue and both survive", async () => {
    const { dir, path } = scratch()
    writeFileSync(path, '{ "flupcode": { "adaptive": {}, "actions": {} } }\n')

    const adaptive = applyEditsToFile(path, (text) => {
      const once = editLeaf(text, ["enabled"], false)
      return applyEdits(once, modify(once, ["flupcode", "adaptive", "budget", "monthlyTokens"], 5000, { formattingOptions: FORMAT }))
    })
    const action = serial(async () => {
      const text = readConfigText(path)
      requireReadable(text, path)
      await writeAtomic(
        path,
        applyEdits(text, modify(text, ["flupcode", "actions", "keep"], { tool: "do_keep" }, { formattingOptions: FORMAT })),
      )
    })

    await Promise.all([adaptive, action])

    const parsed = JSON.parse(readFileSync(path, "utf8"))
    expect(parsed.flupcode.adaptive).toEqual({ enabled: false, budget: { monthlyTokens: 5000 } })
    expect(parsed.flupcode.actions.keep).toEqual({ tool: "do_keep" })
    rmSync(dir, { recursive: true, force: true })
  })
})
