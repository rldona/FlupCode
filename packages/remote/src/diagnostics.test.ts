import { afterEach, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { diagnosticsBundle } from "./diagnostics"
import { openLog } from "./supervisor"

/**
 * The diagnostics bundle carries no secret (HE-03): every credential a FlupCode host holds, in every
 * place it can end up — a child's log, the engine's config, the environment — is planted, and none of
 * them may come out.
 */

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

test("the bundle names versions, ports and children, and no secret", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-diagnostics-"))
  dirs.push(dir)
  const password = randomBytes(24).toString("hex")
  const browserToken = randomBytes(32).toString("hex")
  const pluginToken = randomBytes(32).toString("hex")
  const vaultKey = randomBytes(32).toString("base64")
  const basic = Buffer.from(`opencode:${password}`).toString("base64")
  const providerKey = `sk-ant-api03-${"Q".repeat(40)}`
  const openaiKey = `sk-proj-${"Z9".repeat(20)}`
  const githubToken = `ghp_${"A1b2".repeat(9)}`
  const mcpBearer = "mcpBearerSecretValue1234567890"
  const oddHeader = "plain-looking-header-value"

  const log = openLog(path.join(dir, "logs", "engine.log"))
  log.write("server listening on http://127.0.0.1:4098\n")
  log.write(`GET /api/info authorization: Basic ${basic}\n`)
  log.write(`plugin token ${pluginToken} loaded; browser token=${browserToken}\n`)
  log.write(`provider said: invalid key ${providerKey}\n`)
  log.write(`fetching https://user:${password}@example.com/repo\n`)

  const config = path.join(dir, "opencode.jsonc")
  await writeFile(
    config,
    `{
  // the user's own config, with comments
  "model": "anthropic/claude-sonnet",
  "provider": {
    "anthropic": { "options": { "apiKey": "${providerKey}", "baseURL": "https://api.anthropic.com" } },
    "openai": { "options": { "api_key": "${openaiKey}" } },
  },
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://mcp.example.com",
      "headers": { "Authorization": "Bearer ${mcpBearer}", "X-Odd": "${oddHeader}" },
      "environment": { "GITHUB_TOKEN": "${githubToken}" }
    }
  },
  /* a block comment */
}`,
  )

  const bundle = diagnosticsBundle({
    title: "FlupCode diagnostics",
    versions: { app: "3.0.1", engine: "2.0.18" },
    ports: { engine: "4098", harness: "4097" },
    children: [
      {
        name: "engine",
        phase: "restarting",
        restarts: 1,
        failure: { reason: "exit", message: "was stopped by SIGKILL", lastLines: [] },
        log: log.file,
      },
    ],
    configs: [
      { label: "OpenCode", file: config },
      { label: "missing", file: path.join(dir, "nope.json") },
    ],
    env: {
      FLUPCODE_ENGINE_AUTH: basic,
      FLUPCODE_BROWSER_TOKEN: browserToken,
      FLUPCODE_PLUGIN_TOKEN: pluginToken,
      FLUPCODE_VAULT_KEY: vaultKey,
      OPENCODE_SERVER_PASSWORD: password,
      FLUPCODE_HARNESS_PORT: "4097",
      ANTHROPIC_API_KEY: providerKey,
      HOME: "/home/someone",
    },
    secrets: [password, browserToken, pluginToken, vaultKey],
  })

  for (const secret of [
    password,
    browserToken,
    pluginToken,
    vaultKey,
    basic,
    providerKey,
    openaiKey,
    githubToken,
    mcpBearer,
    oddHeader,
  ])
    expect(bundle).not.toContain(secret)
  // What it is for is still there.
  expect(bundle).toContain("engine: 2.0.18")
  expect(bundle).toContain("harness: 4097")
  expect(bundle).toContain("engine: restarting, 1 restarts")
  expect(bundle).toContain("last stop: was stopped by SIGKILL")
  expect(bundle).toContain("server listening on http://127.0.0.1:4098")
  expect(bundle).toContain('"model": "anthropic/claude-sonnet"')
  expect(bundle).toContain('"baseURL": "https://api.anthropic.com"')
  expect(bundle).toContain("FLUPCODE_HARNESS_PORT=4097")
  expect(bundle).toContain("FLUPCODE_ENGINE_AUTH=[REDACTED]")
  expect(bundle).toContain("(not present)")
  // Only FlupCode's and OpenCode's own variables are listed.
  expect(bundle).not.toContain("ANTHROPIC_API_KEY")
  expect(bundle).not.toContain("/home/someone")
})

test("a config that is not JSON is left out, not copied raw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fc-diagnostics-"))
  dirs.push(dir)
  const config = path.join(dir, "opencode.json")
  await writeFile(config, `{ "provider": { "x": { "options": { "apiKey": "unquoted-secret-value" } } } oops`)
  const bundle = diagnosticsBundle({
    title: "t",
    versions: {},
    ports: {},
    children: [],
    configs: [{ label: "OpenCode", file: config }],
    env: {},
    secrets: [],
  })
  expect(bundle).not.toContain("unquoted-secret-value")
  expect(bundle).toContain("(left out: not readable as JSON)")
})
