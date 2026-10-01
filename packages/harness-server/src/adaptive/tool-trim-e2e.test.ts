/**
 * Recovery end to end (AH-D02): the installed engine plugin against the real harness routes and store.
 *
 * The plugin source is the OpenCode 2 one FlupCode writes into the engine's config folder
 * (TOOL_TRIM_PLUGIN_V2 in `packages/remote/src/engine-plugins-v2.ts`). It is loaded at runtime from its
 * path, not imported as a package, so harness-server takes no dependency on the remote package. A
 * trimmed output must read back byte for byte through `evidence_read`, only from the session that
 * produced it.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { createHarnessHandler } from "../api"
import { SqliteRoutineRepository } from "../repository"
import { RoutineScheduler } from "../scheduler"
import { resolveAdaptiveConfig } from "./config"

const ADAPTIVE = "adaptive-e2e-secret"
const ENGINE_PLUGINS = resolve(import.meta.dir, "../../../remote/src/engine-plugins-v2.ts")

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

  const plugins: { TOOL_TRIM_PLUGIN_V2: { file: string; source: string } } = await import(
    pathToFileURL(ENGINE_PLUGINS).href
  )
  // Written where the engine would find it, and set up against the slice of the 2.x plugin context it uses.
  const file = join(dir, "plugins", plugins.TOOL_TRIM_PLUGIN_V2.file)
  await mkdir(join(dir, "plugins"))
  await writeFile(file, plugins.TOOL_TRIM_PLUGIN_V2.source)
  const module: { default: { setup: (ctx: unknown) => Promise<unknown> } } = await import(pathToFileURL(file).href)
  const hooks = {} as PluginHooks
  await module.default.setup({
    tool: {
      hook: async (name: string, callback: PluginHooks["after"]) => {
        if (name === "execute.after") hooks.after = callback
      },
      transform: async (callback: (editor: { add: (tool: EvidenceRead) => void }) => void) =>
        callback({ add: (tool) => void (hooks.evidenceRead = tool) }),
    },
  })
  return { hooks, server, repository }
}

/** What a 2.x engine hands `execute.after` for a finished call: the result's content is what the model reads. */
type After = {
  sessionID: string
  id: string
  tool: string
  status: "completed"
  result: {
    output: { exit: number }
    content: Array<{ type: "text"; text: string }>
    metadata?: Record<string, unknown>
  }
}
type EvidenceRead = {
  name: string
  execute: (args: { ref: string; range: string }, context: { sessionID: string }) => Promise<{ content: string }>
}
type PluginHooks = { after: (input: After) => Promise<void>; evidenceRead: EvidenceRead }

const finished = (id: string, text: string): After => ({
  sessionID: "ses_e2e",
  id,
  tool: "shell",
  status: "completed",
  result: { output: { exit: 0 }, content: [{ type: "text", text }] },
})

const read = async (hooks: PluginHooks, args: { ref: string; range: string }, sessionID: string) =>
  (await hooks.evidenceRead.execute(args, { sessionID })).content

/** Every line of a stored output, read back range by range the way the model is told to. */
async function readAll(hooks: PluginHooks, sessionID: string, ref: string) {
  const lines: string[] = []
  let range = "1-"
  for (let guard = 0; guard < 200 && range; guard++) {
    const text = await read(hooks, { ref, range }, sessionID)
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
    expect(hooks.evidenceRead.name).toBe("evidence_read")
    const original = Array.from({ length: 600 }, (_, index) => `${index + 1}\t${"payload ".repeat(6)}é`)
    const after = finished("call_1", original.join("\n"))

    await hooks.after(after)

    const trimmed = after.result.content[0]!.text
    const ref = /evidence:([0-9a-f]{16})/.exec(trimmed)?.[1]
    expect(ref).toBeDefined()
    expect(after.result.metadata).toEqual({ evidenceRef: ref })
    // The structured output stays for the transcript; only what the model reads is replaced.
    expect(after.result.output).toEqual({ exit: 0 })
    expect(trimmed.length).toBeLessThan(original.join("\n").length / 4)
    expect(trimmed).toContain(`call evidence_read with ref "${ref}"`)

    expect(await readAll(hooks, "ses_e2e", ref!)).toEqual(original)
    const middle = await read(hooks, { ref: `evidence:${ref}`, range: "300-301" }, "ses_e2e")
    expect(middle).toBe(`[evidence:${ref} lines 300-301 of 600]\n${original[299]}\n${original[300]}`)

    const stranger = await read(hooks, { ref: ref!, range: "1-5" }, "ses_other")
    expect(stranger).toContain("is not available")
  })

  test("with the harness gone the output reaches the model untouched", async () => {
    const { hooks, server } = await start()
    await server.stop(true)
    const text = "line\n".repeat(2_000)
    const after = finished("call_2", text)
    await hooks.after(after)
    expect(after.result).toEqual({ output: { exit: 0 }, content: [{ type: "text", text }] })
  })
})
