import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import { setEngineTransport } from "../transport"
import { createV2Domains } from "./v2"

/**
 * Memory on OpenCode 2 (V2-32), end to end: FlupCode's memory plugin loaded into the pinned 2.x
 * engine, and the app's adapter reaching it over the plugin RPC. What the memory screens do (create,
 * list, verify, remove), a "remember that" turn kept, and the next turn about it carrying the memory
 * to the model. Runs on the v2 line only:
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-memory.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({
    modelUrl: model.url,
    // Plugins load only outside pure mode.
    env: { OPENCODE_PURE: undefined },
    flupcodePlugins: true,
  })
  setEngineTransport({
    fetch: (input, init) => {
      const request = new Request(input, init)
      request.headers.set("authorization", engine.authorization)
      return fetch(request)
    },
    socket: () => {
      throw new Error("not used")
    },
  })
  domains = createV2Domains(engine.url)
}, 120_000)

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("memory on the OpenCode 2 adapter", () => {
  test("the memory screens create, list, verify and remove through the plugin", async () => {
    // The plugin registers once the location boots, a moment after its first request.
    const created = await until(
      () =>
        domains.memory
          .create({ title: "Lint", content: "Run bun run lint before pushing", scope: "global" })
          .catch(() => undefined),
      (value) => value !== undefined,
    )
    expect(created!.data).toMatchObject({ title: "Lint", scope: "global", status: "active", source: "manual" })
    expect((await domains.memory.list({ text: "lint" })).data.map((memory) => memory.id)).toEqual([created!.data.id])
    expect((await domains.memory.verify({ id: created!.data.id })).data.validation?.anchors).toEqual([
      expect.objectContaining({ kind: "command", value: "bun run lint" }),
    ])
    await domains.memory.remove({ id: created!.data.id })
    expect((await domains.memory.list({ text: "lint" })).data).toEqual([])
  })

  test("a remembered fact is kept from the prompt and reaches the model on the next turn about it", async () => {
    const session = await domains.session.create({ location: { directory: engine.project } })
    model.push({ type: "text", text: "Noted" })
    await domains.session.prompt({
      sessionID: session.id,
      text: "Remember that releases are cut from the power branch.",
    })
    await until(
      async () => (await domains.memory.list({ text: "power branch" })).data,
      (memories) => memories.length === 1,
    )
    await until(
      async () => (await domains.session.active()).has(session.id),
      (busy) => !busy,
    )

    const before = model.requests.length
    model.push({ type: "text", text: "From power" })
    await domains.session.prompt({ sessionID: session.id, text: "Which branch are releases cut from?" })
    const request = await until(
      async () => model.requests.slice(before).find((body) => JSON.stringify(body).includes("<memory>")),
      (found) => found !== undefined,
    )
    expect(JSON.stringify(request)).toContain("releases are cut from the power branch")
    expect((await domains.memory.used({ sessionID: session.id })).data.map((memory) => memory.title)).toEqual([
      "Releases are cut from the power branch",
    ])
  })
  test("a candidate stays out of the prompt until it is approved", async () => {
    const candidate = await domains.memory.create({
      title: "Amber branch",
      content: "Hotfixes are tagged from the amber branch",
      scope: "global",
      status: "candidate",
    })
    expect(candidate.data).toMatchObject({ status: "candidate" })
    const session = await domains.session.create({ location: { directory: engine.project } })
    const ask = async (text: string) => {
      const before = model.requests.length
      model.push({ type: "text", text: "Noted" })
      await domains.session.prompt({ sessionID: session.id, text })
      const request = await until(
        async () => model.requests.slice(before).find((body) => JSON.stringify(body).includes(text)),
        (found) => found !== undefined,
      )
      await until(
        async () => (await domains.session.active()).has(session.id),
        (busy) => !busy,
      )
      return JSON.stringify(request)
    }

    expect(await ask("Which branch are hotfixes tagged from?")).not.toContain("amber branch")
    expect((await domains.memory.used({ sessionID: session.id })).data.map((memory) => memory.id)).not.toContain(
      candidate.data.id,
    )

    await domains.memory.update({ id: candidate.data.id, status: "active" })
    expect(await ask("Which branch are hotfixes tagged from, again?")).toContain(
      "Hotfixes are tagged from the amber branch",
    )
  })
})

describe.skipIf(!run)("memory refuses credentials", () => {
  test("a memory that looks like a key is refused with the reason", async () => {
    const key = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"
    await expect(
      domains.memory.create({ title: "CI token", content: "The CI token is " + key, scope: "global" }),
    ).rejects.toThrow("Not kept: it looks like a credential (GitHub token)")
    expect((await domains.memory.list({ text: "CI token" })).data).toEqual([])
  })
})

async function until<T>(read: () => Promise<T>, match: (value: T) => boolean) {
  const deadline = Date.now() + 30_000
  for (;;) {
    const value = await read()
    if (match(value)) return value
    if (Date.now() > deadline) throw new Error(`Never matched: ${JSON.stringify(value).slice(0, 300)}`)
    await Bun.sleep(200)
  }
}
