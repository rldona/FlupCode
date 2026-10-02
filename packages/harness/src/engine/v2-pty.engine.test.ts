import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CONTRACT_LINE, startEngine, type Engine } from "@flupcode/engine-contract/engine"
import { startModel } from "@flupcode/engine-contract/model"
import type { EngineSocket } from "@flupcode/remote"
import { setEngineTransport } from "../transport"
import { createV2Domains } from "./v2"

/**
 * The terminal's side of the adapter against a real OpenCode 2 engine (TI-04): a PTY created in the
 * project, connected through the transport's socket with a ticket, typed into, resized and removed.
 *
 *   FLUPCODE_CONTRACT_LINE=v2 bun test src/engine/v2-pty.engine.test.ts
 */
const run = CONTRACT_LINE === "v2"
const model = startModel()
let engine: Engine
let domains: ReturnType<typeof createV2Domains>

beforeAll(async () => {
  if (!run) return
  engine = await startEngine({ modelUrl: model.url })
  // The desktop hands the renderer the engine's credentials; here the transport adds them itself,
  // to the socket as well, which is what a tunnel or the engine proxy does for the app.
  setEngineTransport({
    fetch: (input, init) => {
      const request = new Request(input, init)
      request.headers.set("authorization", engine.authorization)
      return fetch(request)
    },
    socket: (url) =>
      new WebSocket(url, { headers: { authorization: engine.authorization } } as never) as unknown as EngineSocket,
  })
  domains = createV2Domains(engine.url)
})

afterAll(async () => {
  await engine?.stop()
  model.stop()
})

describe.skipIf(!run)("the terminal on OpenCode 2", () => {
  test("a command typed into a PTY prints its answer, a resize reaches the shell, and remove ends it", async () => {
    const id = await domains.pty.create(engine.project)
    let output = ""
    let closed = false
    const terminal = await domains.pty.connect({
      id,
      directory: engine.project,
      onOutput: (data) => void (output += typeof data === "string" ? data : new TextDecoder().decode(data)),
      onClose: () => void (closed = true),
    })

    terminal.send("echo adapter-$((6 * 7))\r")
    await until(() => output.includes("adapter-42"))
    await domains.pty.resize(id, { rows: 33, cols: 99 }, engine.project)
    terminal.send("stty size\r")
    await until(() => output.includes("33 99"))
    // The control frame the engine sends after its replay is not output.
    expect(output).not.toContain("cursor")

    await domains.pty.remove(id, engine.project)
    await until(() => closed)
  })

  test("a PTY that is gone cannot be connected, and says so", async () => {
    const id = await domains.pty.create(engine.project)
    await domains.pty.remove(id, engine.project)
    await expect(
      domains.pty.connect({ id, directory: engine.project, onOutput: () => undefined, onClose: () => undefined }),
    ).rejects.toThrow()
  })
})

async function until(check: () => boolean) {
  const deadline = Date.now() + 15_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out")
    await Bun.sleep(50)
  }
}
