import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  adaptiveTokenFile,
  bearerFrom,
  browserTokenFile,
  flupcodeConfigDir,
  isLoopbackHostname,
  readAdaptiveToken,
  readBrowserToken,
  readOrCreateAdaptiveToken,
  readOrCreateBrowserToken,
  tokenMatches,
} from "./browser-token"

let directory = ""

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "flupcode-token-"))
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe("the browser token on disk", () => {
  test("a new token is created readable only by its owner", () => {
    const file = join(directory, "browser-token")
    const token = readOrCreateBrowserToken(file)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
  })

  test("reading it again gives back the same value", () => {
    const file = join(directory, "browser-token")
    const token = readOrCreateBrowserToken(file)
    expect(readOrCreateBrowserToken(file)).toBe(token)
  })

  test("reading a token that is not there writes nothing", () => {
    const file = join(directory, "browser-token")
    expect(readBrowserToken(file)).toBeUndefined()
    expect(existsSync(file)).toBe(false)
  })

  test("an empty token file is replaced, not handed back blank", () => {
    const file = join(directory, "browser-token")
    writeFileSync(file, "   \n")
    const token = readOrCreateBrowserToken(file)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(file, "utf8")).toBe(token)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
  })
})

describe("where the token lives", () => {
  test("the config directory follows the environment", () => {
    expect(flupcodeConfigDir({ FLUPCODE_CONFIG_DIR: "/custom" }, "/home/me")).toBe("/custom")
    expect(flupcodeConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/me")).toBe("/xdg/flupcode")
    expect(flupcodeConfigDir({}, "/home/me")).toBe(join("/home/me", ".config", "flupcode"))
  })

  test("the token file sits inside it", () => {
    expect(browserTokenFile("/cfg")).toBe(join("/cfg", "browser-token"))
    expect(adaptiveTokenFile("/cfg")).toBe(join("/cfg", "adaptive-token"))
  })
})

describe("the acting token on disk", () => {
  test("a new dedicated token is created readable only by its owner", () => {
    const file = join(directory, "adaptive-token")
    const token = readOrCreateAdaptiveToken(file)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
  })

  test("reading it again gives back the same value", () => {
    const file = join(directory, "adaptive-token")
    const token = readOrCreateAdaptiveToken(file)
    expect(readOrCreateAdaptiveToken(file)).toBe(token)
  })

  test("reading a token that is not there writes nothing", () => {
    const file = join(directory, "adaptive-token")
    expect(readAdaptiveToken(file)).toBeUndefined()
    expect(existsSync(file)).toBe(false)
  })

  test("an empty token file is replaced, not handed back blank", () => {
    const file = join(directory, "adaptive-token")
    writeFileSync(file, "   \n")
    const token = readOrCreateAdaptiveToken(file)
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(file, "utf8")).toBe(token)
    expect((statSync(file).mode & 0o777).toString(8)).toBe("600")
  })
})

describe("the loopback gate", () => {
  test("only the local hostnames pass, whatever their case", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true)
    expect(isLoopbackHostname("::1")).toBe(true)
    expect(isLoopbackHostname("[::1]")).toBe(true)
    expect(isLoopbackHostname("localhost")).toBe(true)
    expect(isLoopbackHostname("LOCALHOST")).toBe(true)
    expect(isLoopbackHostname(" 127.0.0.1 ")).toBe(true)
  })

  test("anything else is not loopback", () => {
    expect(isLoopbackHostname("0.0.0.0")).toBe(false)
    expect(isLoopbackHostname("192.168.1.7")).toBe(false)
    expect(isLoopbackHostname("harness.example")).toBe(false)
    expect(isLoopbackHostname("")).toBe(false)
  })
})

describe("reading a bearer token", () => {
  test("a bearer header yields its token", () => {
    expect(bearerFrom(new Request("http://x", { headers: { authorization: "Bearer abc123" } }))).toBe("abc123")
  })

  test("a bare scheme or no header yields nothing", () => {
    expect(bearerFrom(new Request("http://x", { headers: { authorization: "Bearer" } }))).toBeUndefined()
    expect(bearerFrom(new Request("http://x"))).toBeUndefined()
  })
})

describe("matching a token", () => {
  test("equal tokens match", () => {
    expect(tokenMatches("abc", "abc")).toBe(true)
  })

  test("a different or absent token does not", () => {
    expect(tokenMatches("abc", "abd")).toBe(false)
    expect(tokenMatches("abc", "abcd")).toBe(false)
    expect(tokenMatches("abc", undefined)).toBe(false)
  })
})
