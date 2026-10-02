import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  engineConfigDir,
  enginePluginFolders,
  enginePluginsDir,
  installEnginePlugins,
  withEnginePlugins,
} from "./engine-plugins"
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

/** A home of its own: every folder the installer reads or writes lives under it. */
async function home() {
  const root = await temp()
  return { root, env: { XDG_CONFIG_HOME: path.join(root, ".config") } }
}

describe("engineConfigDir", () => {
  test("follows OpenCode: OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(engineConfigDir({ OPENCODE_CONFIG_DIR: "/custom" }, "/home/u")).toBe("/custom")
    expect(engineConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(path.join("/xdg", "opencode"))
    expect(engineConfigDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "opencode"))
  })
})

describe("enginePluginsDir", () => {
  test("is FlupCode's config folder, never OpenCode's", () => {
    expect(enginePluginsDir({ FLUPCODE_CONFIG_DIR: "/fc" }, "/home/u")).toBe(path.join("/fc", "engine-plugins"))
    expect(enginePluginsDir({ XDG_CONFIG_HOME: "/xdg", OPENCODE_CONFIG_DIR: "/oc" }, "/home/u")).toBe(
      path.join("/xdg", "flupcode", "engine-plugins"),
    )
    expect(enginePluginsDir({}, "/home/u")).toBe(path.join("/home/u", ".config", "flupcode", "engine-plugins"))
  })
})

describe("withEnginePlugins", () => {
  const folders = enginePluginFolders({ FLUPCODE_CONFIG_DIR: "/fc" })

  test("names every plugin folder in the engine's config content", () => {
    const env = withEnginePlugins({ FLUPCODE_CONFIG_DIR: "/fc", PATH: "/bin" })
    expect(env.PATH).toBe("/bin")
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ plugins: folders })
    expect(folders).toHaveLength(PLUGINS_V2.length)
  })

  test("keeps the reader's own config content and plugins, and leaves their config folder alone", () => {
    const env = withEnginePlugins({
      FLUPCODE_CONFIG_DIR: "/fc",
      OPENCODE_CONFIG_DIR: "/mine",
      OPENCODE_CONFIG: "/mine/extra.json",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: "a/b", plugins: ["their-plugin"] }),
    })
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT!)).toEqual({ model: "a/b", plugins: ["their-plugin", ...folders] })
    expect(env.OPENCODE_CONFIG_DIR).toBe("/mine")
    expect(env.OPENCODE_CONFIG).toBe("/mine/extra.json")
  })

  test("leaves config content it cannot read as the reader wrote it", () => {
    const env = { FLUPCODE_CONFIG_DIR: "/fc", OPENCODE_CONFIG_CONTENT: "{ // not JSON" }
    expect(withEnginePlugins(env)).toEqual(env)
  })
})

describe("installEnginePlugins", () => {
  test("writes each plugin into its own folder once, and leaves up-to-date ones alone", async () => {
    const { root, env } = await home()
    const first = await installEnginePlugins(env, root)
    expect(first.changed).toBe(true)
    expect(first.paths).toHaveLength(PLUGINS_V2.length)
    for (const [index, folder] of enginePluginFolders(env, root).entries())
      expect(await readFile(path.join(folder, "index.js"), "utf8")).toBe(PLUGINS_V2[index]!.source)
    expect(await readdir(path.join(root, ".config")).then((names) => names.sort())).toEqual(["flupcode"])

    expect((await installEnginePlugins(env, root)).changed).toBe(false)
  })

  test("removes FlupCode's copies from OpenCode's global plugins folder and nothing else there", async () => {
    const { root, env } = await home()
    const global = path.join(root, ".config", "opencode", "plugins")
    await mkdir(global, { recursive: true })
    // What earlier versions left: FlupCode's own files, 1.x and 2.x, under FlupCode's file names.
    await writeFile(path.join(global, PLUGINS_V2[0]!.file), PLUGINS_V2[0]!.source)
    await writeFile(
      path.join(global, PLUGINS_V2[1]!.file),
      "// Installed by FlupCode. A 1.x plugin.\nexport const p = 1\n",
    )
    // The reader's own: a FlupCode file name without FlupCode's first line, another name, other files.
    const theirs = {
      [PLUGINS_V2[2]!.file]: "export default { id: 'mine', setup: async () => {} }\n",
      "flupcode-mine.js": "// Installed by FlupCode\nexport default {}\n",
      "reasoning-variants.ts": "export default {}\n",
      "user-plugin.js": "export default {}\n",
    }
    for (const [file, text] of Object.entries(theirs)) await writeFile(path.join(global, file), text)

    const result = await installEnginePlugins(env, root)
    expect(result.removed.sort()).toEqual(
      [PLUGINS_V2[0]!.file, PLUGINS_V2[1]!.file].map((file) => path.join(global, file)).sort(),
    )
    expect((await readdir(global)).sort()).toEqual(Object.keys(theirs).sort())
    for (const [file, text] of Object.entries(theirs))
      expect(await readFile(path.join(global, file), "utf8")).toBe(text)
  })

  test("also clears the folder OPENCODE_CONFIG_DIR names, where earlier versions wrote when it was set", async () => {
    const { root, env } = await home()
    const custom = path.join(root, "custom-opencode")
    await mkdir(path.join(custom, "plugins"), { recursive: true })
    await writeFile(path.join(custom, "plugins", PLUGINS_V2[0]!.file), PLUGINS_V2[0]!.source)
    await installEnginePlugins({ ...env, OPENCODE_CONFIG_DIR: custom }, root)
    expect(await readdir(path.join(custom, "plugins"))).toEqual([])
  })

  test("never throws when the folder cannot be written", async () => {
    const { root } = await home()
    await writeFile(path.join(root, "flupcode"), "a file where the folder should be")
    const result = await installEnginePlugins({ FLUPCODE_CONFIG_DIR: path.join(root, "flupcode") }, root)
    expect(result.changed).toBe(false)
    expect(result.error).toBeDefined()
  })
})
