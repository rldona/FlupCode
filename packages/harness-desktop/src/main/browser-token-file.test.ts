import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readFileToken, readOrCreateFileToken, tokenFileDir, tokenFilePath } from "./browser-token-file"

const dir = () => mkdtempSync(join(tmpdir(), "flupcode-token-"))

describe("the persisted loopback token", () => {
  test("resolves the config dir like the harness does", () => {
    expect(tokenFileDir({ FLUPCODE_CONFIG_DIR: "/tmp/custom" }, "/home/u")).toBe("/tmp/custom")
    expect(tokenFileDir({}, "/home/u")).toBe("/home/u/.config/flupcode")
    expect(tokenFileDir({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/home/u")).toBe("/tmp/xdg/flupcode")
    expect(tokenFilePath("/tmp/custom")).toBe("/tmp/custom/browser-token")
  })

  test("missing, empty and unreadable files resolve to nothing", () => {
    const base = dir()
    expect(readFileToken(join(base, "absent"))).toBeUndefined()
    const empty = join(base, "empty")
    writeFileSync(empty, "  \n")
    expect(readFileToken(empty)).toBeUndefined()
    expect(readFileToken(join(base, "nope", "nested"))).toBeUndefined()
  })

  test("creates once and reuses the same token afterwards", () => {
    const file = join(dir(), "browser-token")
    const first = readOrCreateFileToken(file)
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(readOrCreateFileToken(file)).toBe(first)
    expect(readFileToken(file)).toBe(first)
  })

  test("an existing well-formed token is kept verbatim", () => {
    const file = join(dir(), "browser-token")
    const kept = "a".repeat(64)
    writeFileSync(file, `  ${kept}  \n`)
    expect(readOrCreateFileToken(file)).toBe(kept)
  })

  test("a malformed stored value is replaced, not reused", () => {
    const file = join(dir(), "browser-token")
    writeFileSync(file, "token-abc")
    const next = readOrCreateFileToken(file)
    expect(next).toMatch(/^[0-9a-f]{64}$/)
    expect(next).not.toBe("token-abc")
    expect(readFileToken(file)).toBe(next)
  })
})
