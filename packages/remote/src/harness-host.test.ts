import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { engineEnvBesideHarness, harnessServerEnv, resolveHarnessServer } from "./harness-host"

const root = mkdtempSync(join(tmpdir(), "flupcode-harness-host-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("the harness a host starts (HE-01)", () => {
  test("is the named one, then a compiled binary, then a checkout's source", () => {
    const checkout = join(root, "harness-server")
    mkdirSync(join(checkout, "src"), { recursive: true })
    writeFileSync(join(checkout, "src", "index.ts"), "")
    const binary = join(root, "flupcode-harness")
    expect(resolveHarnessServer({ binaries: [binary], checkout, bun: "/bin/bun", env: {} })).toEqual({
      command: "/bin/bun",
      args: ["run", "./src/index.ts"],
      cwd: checkout,
    })
    writeFileSync(binary, "")
    expect(resolveHarnessServer({ binaries: [binary], checkout, env: {} })).toEqual({ command: binary, args: [] })
    expect(resolveHarnessServer({ binaries: [binary], checkout, env: { FLUPCODE_HARNESS_SERVER: "/x" } })).toEqual({
      command: "/x",
      args: [],
    })
    expect(resolveHarnessServer({ binaries: [], checkout: join(root, "none"), env: {} })).toBeUndefined()
  })

  test("gets the engine and its secrets; the engine gets none of them", () => {
    const env = { PATH: "/bin", FLUPCODE_BROWSER_TOKEN: "ui", FLUPCODE_PLUGIN_TOKEN: "p", FLUPCODE_VAULT_KEY: "k" }
    expect(
      harnessServerEnv({ env, engineUrl: "http://127.0.0.1:9", port: 4111, authorization: "YTpi" }),
    ).toMatchObject({
      PATH: "/bin",
      FLUPCODE_ENGINE_URL: "http://127.0.0.1:9",
      FLUPCODE_HARNESS_PORT: "4111",
      FLUPCODE_ENGINE_AUTH: "YTpi",
    })
    expect(engineEnvBesideHarness({ ...env, FLUPCODE_ENGINE_AUTH: "YTpi" }, "http://127.0.0.1:4111")).toEqual({
      PATH: "/bin",
      FLUPCODE_HARNESS_SERVER_URL: "http://127.0.0.1:4111",
    })
  })
})
