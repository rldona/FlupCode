import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, resolveConfig } from "vite"
import { DEV_TOKEN_PATH, devTokenPlugin, devTokenScript, readDevToken } from "./vite-dev-token"

const made: string[] = []
afterAll(() => made.forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const TOKEN = "a".repeat(64)

const configDir = () => {
  const root = mkdtempSync(join(tmpdir(), "flupcode-dev-token-"))
  made.push(root)
  const dir = join(root, "flupcode")
  mkdirSync(dir)
  writeFileSync(join(dir, "browser-token"), `${TOKEN}\n`)
  return { root, dir }
}

test("reads the token the harness server compares, and nothing when there is none", () => {
  const config = configDir()
  expect(readDevToken({ FLUPCODE_CONFIG_DIR: config.dir }, "/nowhere")).toBe(TOKEN)
  expect(readDevToken({ XDG_CONFIG_HOME: config.root }, "/nowhere")).toBe(TOKEN)
  expect(readDevToken({ FLUPCODE_BROWSER_TOKEN: " env-token ", FLUPCODE_CONFIG_DIR: config.dir }, "/nowhere")).toBe(
    "env-token",
  )
  expect(readDevToken({ FLUPCODE_CONFIG_DIR: join(config.root, "missing") }, "/nowhere")).toBeUndefined()
})

test("the script only defines window.flupcode when the desktop has not", () => {
  expect(devTokenScript(undefined)).toBe("")
  const context = { window: { flupcode: { browserToken: "desktop" } } as { flupcode?: { browserToken: string } } }
  new Function("window", devTokenScript(TOKEN))(context.window)
  expect(context.window.flupcode?.browserToken).toBe("desktop")
  const tab: { flupcode?: { browserToken: string } } = {}
  new Function("window", devTokenScript(TOKEN))(tab)
  expect(tab.flupcode?.browserToken).toBe(TOKEN)
})

// The token must never reach `dist/`: a build or a preview does not run the plugin at all.
test("a build or a preview leaves the plugin out", async () => {
  const env = { FLUPCODE_CONFIG_DIR: configDir().dir }
  for (const [command, mode] of [
    ["build", "production"],
    ["serve", "production"],
  ] as const) {
    const config = await resolveConfig(
      { configFile: false, logLevel: "silent", plugins: [devTokenPlugin(env)] },
      command,
      mode,
      mode,
      command === "serve",
    )
    expect(config.plugins.some((plugin) => plugin.name === "flupcode-dev-token")).toBe(false)
  }
  const served = await resolveConfig({ configFile: false, logLevel: "silent", plugins: [devTokenPlugin(env)] }, "serve")
  expect(served.plugins.some((plugin) => plugin.name === "flupcode-dev-token")).toBe(true)
})

test("the dev server names the script, and only a same-origin loopback request gets the token", async () => {
  const root = mkdtempSync(join(tmpdir(), "flupcode-dev-root-"))
  made.push(root)
  writeFileSync(join(root, "index.html"), "<!doctype html><html><head></head><body></body></html>")
  const server = await createServer({
    configFile: false,
    root,
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
    plugins: [devTokenPlugin({ FLUPCODE_CONFIG_DIR: configDir().dir })],
  })
  await server.listen()
  const address = server.httpServer?.address()
  const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
  try {
    const html = await fetch(base).then((response) => response.text())
    expect(html).toContain(`<script src="${DEV_TOKEN_PATH}"></script>`)
    expect(html).not.toContain(TOKEN)

    const sameOrigin = await fetch(`${base}${DEV_TOKEN_PATH}`, { headers: { "sec-fetch-site": "same-origin" } })
    expect(sameOrigin.headers.get("cache-control")).toBe("no-store")
    expect(await sameOrigin.text()).toContain(TOKEN)
    for (const site of ["same-site", "cross-site"]) {
      const foreign = await fetch(`${base}${DEV_TOKEN_PATH}`, { headers: { "sec-fetch-site": site } })
      expect(await foreign.text()).toBe("")
    }
    expect(await fetch(`${base}${DEV_TOKEN_PATH}`).then((response) => response.text())).toBe("")
  } finally {
    await server.close()
  }
})
