import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { acceptChannel, connectChannel, createTunnelClient, random, serveTunnel, wirePair } from "@flupcode/remote"
import { readRemoteToken } from "@flupcode/remote/harness-host"
import { createHarnessHandler } from "./api"
import { readOrCreateRemoteToken, remoteTokenFile } from "./browser-token"
import { REFUSED } from "./remote-scope.fixture"
import { SqliteRoutineRepository } from "./repository"
import { RoutineScheduler } from "./scheduler"

/**
 * A paired phone's `/harness/*` calls through the real tunnel to a real harness (HE-02): the host reads
 * the token the harness wrote, the tunnel routes by path, and the harness decides what it reaches.
 */

const config = mkdtempSync(`${tmpdir()}/flupcode-remote-tunnel-`)
const repository = new SqliteRoutineRepository(":memory:")
const scheduler = new RoutineScheduler({ repository, engineURL: "http://127.0.0.1:1" })
const harness = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch: createHarnessHandler(repository, scheduler, {
    token: "ui-token",
    remoteToken: readOrCreateRemoteToken(remoteTokenFile(config)),
    hostname: "127.0.0.1",
  }),
})
const engineCalls: string[] = []
const engine = Bun.serve({
  port: 0,
  fetch(request) {
    engineCalls.push(new URL(request.url).pathname)
    return Response.json({ engine: true })
  },
})

afterAll(() => {
  harness.stop(true)
  engine.stop(true)
  repository.close()
  rmSync(config, { recursive: true, force: true })
})

async function phone() {
  const [clientWire, hostWire] = wirePair()
  const psk = random(32)
  const [client, accepted] = await Promise.all([
    connectChannel(clientWire, { mode: "device", id: "phone", psk }),
    acceptChannel(hostWire, () => psk),
  ])
  serveTunnel(accepted.channel, {
    target: `http://127.0.0.1:${engine.port}`,
    harness: { target: `http://127.0.0.1:${harness.port}`, token: () => readRemoteToken(config) },
  })
  return createTunnelClient(client)
}

describe("the harness over remote control (HE-02)", () => {
  test("a phone reads runs, approves a gate and stops a run through the tunnel", async () => {
    const tunnel = await phone()
    const gate = repository.startRun({ type: "manual" }, Date.now())
    repository.addTasks(gate.id, [{ name: "plan", prompt: "go" }])
    repository.awaitRun(gate.id)
    const held = repository.startRun({ type: "manual" }, Date.now())
    repository.addTasks(held.id, [{ name: "ship", prompt: "go" }])
    repository.awaitRun(held.id)

    const listed = await tunnel.fetch("https://phone.invalid/harness/runs")
    expect(listed.status).toBe(200)
    expect((await listed.json()).data.map((run: { id: string }) => run.id).sort()).toEqual([gate.id, held.id].sort())

    const approved = await tunnel.fetch(`https://phone.invalid/harness/runs/${gate.id}/approve`, { method: "POST" })
    expect(approved.status).toBe(200)
    const stopped = await tunnel.fetch(`https://phone.invalid/harness/runs/${held.id}/stop`, { method: "POST" })
    expect(stopped.status).toBe(200)
    expect(repository.getRun(held.id)?.status).toBe("stopped")
    // The engine's paths are still the engine's.
    await tunnel.fetch("https://phone.invalid/api/session")
    expect(engineCalls).toEqual(["/api/session"])
    const deadline = Date.now() + 10_000
    while (repository.getRun(gate.id)?.status === "running" && Date.now() < deadline) await Bun.sleep(10)
  })

  test("every route outside the remote scope is refused through the tunnel", async () => {
    const tunnel = await phone()
    for (const [method, path] of REFUSED) {
      const refused = await tunnel.fetch(`https://phone.invalid${path}`, {
        method,
        // The phone cannot borrow the window's token: the host replaces whatever it sends.
        headers: { authorization: "Bearer ui-token", "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      })
      expect([method, path, refused.status]).toEqual([method, path, 403])
    }
    expect(repository.list()).toEqual([])
  })

  test("without the token file the harness refuses the phone outright", async () => {
    rmSync(remoteTokenFile(config))
    const tunnel = await phone()
    const refused = await tunnel.fetch("https://phone.invalid/harness/runs")
    expect(refused.status).toBe(403)
    expect((await refused.json()).code).toBe("invalid_token")
  })
})
