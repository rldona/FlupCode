import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { installOpenCodeV2, OPENCODE_V2_INTEGRITY, OPENCODE_V2_VERSION, openCodeV2Path } from "./opencode-v2"

const scratch = mkdtempSync(join(tmpdir(), "flupcode-opencode-v2-test-"))

/**
 * A registry that serves another tarball under the pinned version and vouches for it with a hash
 * that matches: what a compromised registry or a hijacked publish looks like from the installer.
 */
const tampered = (() => {
  const source = join(scratch, "source")
  mkdirSync(join(source, "package", "bin"), { recursive: true })
  writeFileSync(join(source, "package", "bin", "opencode"), "#!/bin/sh\necho not the engine\n")
  writeFileSync(join(source, "package", "bin", "opencode.exe"), "not the engine")
  const tarball = join(scratch, "package.tgz")
  const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", source, "package"])
  if (tar.exitCode !== 0) throw new Error(`could not pack the tampered tarball: ${tar.stderr.toString()}`)
  return new Uint8Array(readFileSync(tarball))
})()

const registry = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: (request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith(".tgz")) return new Response(tampered)
    return Response.json({
      time: { [OPENCODE_V2_VERSION]: "2020-01-01T00:00:00.000Z" },
      versions: {
        [OPENCODE_V2_VERSION]: {
          dist: {
            tarball: `${url.origin}/engine.tgz`,
            integrity: `sha512-${createHash("sha512").update(tampered).digest("base64")}`,
          },
        },
      },
    })
  },
})

afterAll(async () => {
  await registry.stop(true)
  rmSync(scratch, { recursive: true, force: true })
})

describe("installOpenCodeV2", () => {
  test("refuses a tarball that is not the pinned one, even when the registry vouches for it", async () => {
    const env = { XDG_CACHE_HOME: join(scratch, "cache") }
    const target = openCodeV2Path(OPENCODE_V2_VERSION, env)

    await expect(installOpenCodeV2({ env, registry: `http://127.0.0.1:${registry.port}` })).rejects.toThrow(/pinned/)

    expect(existsSync(target)).toBe(false)
    // Unpacked beside the target, and nothing of it left behind.
    expect(existsSync(dirname(target)) ? readdirSync(dirname(target)) : []).toEqual([])
  })

  test("refuses a version with no pinned hash before it fetches anything", async () => {
    const env = { XDG_CACHE_HOME: join(scratch, "cache") }
    await expect(installOpenCodeV2({ env, version: "2.0.0-unpinned", registry: "http://127.0.0.1:9" })).rejects.toThrow(
      /no pinned sha512/,
    )
  })

  test("pins a sha512 for every platform it can install on", () => {
    expect(Object.keys(OPENCODE_V2_INTEGRITY).sort()).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-arm64-musl",
      "linux-x64",
      "linux-x64-musl",
      "windows-arm64",
      "windows-x64",
    ])
    expect(Object.values(OPENCODE_V2_INTEGRITY).every((hash) => /^sha512-[A-Za-z0-9+/]{86}==$/.test(hash))).toBe(true)
  })
})
