/**
 * Recovery end to end (AH-D02): the installed engine plugin against the real harness routes and store.
 *
 * The plugin source is the one FlupCode writes into the engine's config folder
 * (`packages/remote/src/engine-plugins.ts`). It is loaded at runtime from its path, not imported as
 * a package, so harness-server takes no dependency on the remote package. A trimmed output must read
 * back byte for byte through `evidence_read`, only from the session that produced it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { resolveAdaptiveConfig } from "./config"

const ADAPTIVE = "adaptive-e2e-secret"
const ENGINE_PLUGINS = resolve(import.meta.dir, "../../../remote/src/engine-plugins.ts")

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  delete process.env.FLUPCODE_CONFIG_DIR
  delete process.env.FLUPCODE_HARNESS_SERVER_URL
})

async function start() {
  const repository = new SqliteRoutineRepository(":memory:")
  const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
  const config = () =>
    resolveAdaptiveConfig({ block: { toolTrim: { enabled: true, thresholdBytes: 4_096, readBytes: 2_000 } }, env: {} })
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: createHarnessHandler(repository, scheduler, { adaptiveToken: ADAPTIVE, toolTrimConfig: config }),
  })
  const dir = await mkdtemp(join(tmpdir(), "fc-tool-trim-e2e-"))
  await writeFile(join(dir, "adaptive-token"), ADAPTIVE)
  process.env.FLUPCODE_CONFIG_DIR = dir
  process.env.FLUPCODE_HARNESS_SERVER_URL = server.url.origin
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  cleanups.push(() => repository.close())
  cleanups.push(() => void server.stop(true))

  const plugins: { installEnginePlugins: (dir: string) => Promise<{ paths: string[] }> } = await import(
    pathToFileURL(ENGINE_PLUGINS).href
  )
  const installed = await plugins.installEnginePlugins(join(dir, "engine"))
  const file = installed.paths.find((entry) => entry.endsWith("flupcode-tool-trim.js"))
  expect(file).toBeDefined()
  const module: { flupcodeToolTrim: () => Promise<PluginHooks> } = await import(pathToFileURL(file!).href)
  return { hooks: await module.flupcodeToolTrim(), server, repository }
}

type PluginHooks = {
  "tool.execute.after": (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: { title: string; output: string; metadata: Record<string, unknown> },
  ) => Promise<void>
  tool: { evidence_read: { execute: (args: { ref: string; range: string }, context: { sessionID: string }) => Promise<string> } }
}

/** Every line of a stored output, read back range by range the way the model is told to. */
async function readAll(hooks: PluginHooks, sessionID: string, ref: string) {
  const lines: string[] = []
  let range = "1-"
  for (let guard = 0; guard < 200 && range; guard++) {
    const text = await hooks.tool.evidence_read.execute({ ref, range }, { sessionID })
    const [header, ...rest] = text.split("\n")
    expect(header).toMatch(/^\[evidence:[0-9a-f]{16} lines \d+-\d+ of \d+\]$/)
    const next = /\n\[more: call evidence_read with range "([^"]+)"\]$/.exec(text)
    lines.push(...(next ? rest.slice(0, -1) : rest))
    range = next ? next[1]! : ""
  }
  return lines
}

describe("tool-output trim recovery, plugin to store and back (AH-D02)", () => {
  test("a trimmed output is recoverable in full, and only by its own session", async () => {
    const { hooks } = await start()
    const original = Array.from({ length: 600 }, (_, index) => `${index + 1}\t${"payload ".repeat(6)}é`)
    const output = { title: "bash", output: original.join("\n"), metadata: {} as Record<string, unknown> }

    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_e2e", callID: "call_1", args: {} }, output)

    const ref = /evidence:([0-9a-f]{16})/.exec(output.output)?.[1]
    expect(ref).toBeDefined()
    expect(output.metadata.evidenceRef).toBe(ref)
    expect(output.output.length).toBeLessThan(original.join("\n").length / 4)
    expect(output.output).toContain(`call evidence_read with ref "${ref}"`)

    expect(await readAll(hooks, "ses_e2e", ref!)).toEqual(original)
    const middle = await hooks.tool.evidence_read.execute({ ref: `evidence:${ref}`, range: "300-301" }, { sessionID: "ses_e2e" })
    expect(middle).toBe(`[evidence:${ref} lines 300-301 of 600]\n${original[299]}\n${original[300]}`)

    const stranger = await hooks.tool.evidence_read.execute({ ref: ref!, range: "1-5" }, { sessionID: "ses_other" })
    expect(stranger).toContain("is not available")
  })

  test("with the harness gone the output reaches the model untouched", async () => {
    const { hooks, server } = await start()
    await server.stop(true)
    const text = "line\n".repeat(2_000)
    const output = { title: "bash", output: text, metadata: {} }
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "ses_e2e", callID: "call_2", args: {} }, output)
    expect(output.output).toBe(text)
    expect(output.metadata).toEqual({})
  })
})
