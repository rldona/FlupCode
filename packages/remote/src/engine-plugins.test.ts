import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { engineConfigDir, installEnginePlugins } from "./engine-plugins"
import { PLUGINS_V2 } from "./engine-plugins-v2"

const dirs: string[] = []
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-engine-plugins-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("engineConfigDir", () => {
  test("follows OpenCode: OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(engineConfigDir({ OPENCODE_CONFIG_DIR: "/custom" }, "/home/u")).toBe("/custom")
    expect(engineConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(path.join("/xdg", "opencode"))
    expect(engineConfigDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "opencode"))
  })
})

describe("installEnginePlugins", () => {
  test("writes the plugins once, replaces older copies, and leaves up-to-date ones alone", async () => {
    const config = await temp()
    await mkdir(path.join(config, "plugins"))
    await writeFile(path.join(config, "plugins", "reasoning-variants.ts"), "old")
    // What a 1.x FlupCode left: the same file name, a shape 2.x refuses.
    await writeFile(path.join(config, "plugins", PLUGINS_V2[0]!.file), "export const flupcode = async () => ({})")

    const first = await installEnginePlugins(config)
    expect(first.changed).toBe(true)
    expect(first.paths).toHaveLength(PLUGINS_V2.length)
    for (const plugin of PLUGINS_V2)
      expect(await readFile(path.join(config, "plugins", plugin.file), "utf8")).toBe(plugin.source)
    expect((await readdir(path.join(config, "plugins"))).sort()).toEqual(
      PLUGINS_V2.map((plugin) => plugin.file).sort(),
    )

    expect((await installEnginePlugins(config)).changed).toBe(false)
  })

  test("never throws when the folder cannot be written", async () => {
    const config = await temp()
    await writeFile(path.join(config, "plugins"), "a file where the folder should be")
    const result = await installEnginePlugins(config)
    expect(result.changed).toBe(false)
    expect(result.error).toBeDefined()
  })
})
