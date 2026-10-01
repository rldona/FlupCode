import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  connectChannel,
  connectRelayClient,
  createTunnelClient,
  fromBase64Url,
  parsePairingHash,
} from "@flupcode/remote"
import { startRelay } from "../../relay/src/relay"

const relay = startRelay({ port: 0, hostname: "127.0.0.1" })
const engine = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === "/global/health"
      ? Response.json({ healthy: true })
      : new Response("not found", { status: 404 }),
})
const configDir = mkdtempSync(join(tmpdir(), "flupcode-cli-"))
// Where the CLI installs the engine plugins for a local engine: never the real OpenCode config.
const engineConfigDir = mkdtempSync(join(tmpdir(), "flupcode-cli-opencode-"))
const spawned: Array<ReturnType<typeof Bun.spawn>> = []

afterAll(() => {
  spawned.forEach((child) => child.kill())
  relay.stop()
  engine.stop(true)
  rmSync(configDir, { recursive: true, force: true })
  rmSync(engineConfigDir, { recursive: true, force: true })
})

function cli(...args: string[]) {
  return cliWith({}, ...args)
}

function cliWith(env: Record<string, string | undefined>, ...args: string[]) {
  const child = Bun.spawn(["bun", join(import.meta.dir, "../src/index.ts"), ...args], {
    env: {
      ...process.env,
      FLUPCODE_CONFIG_DIR: configDir,
      OPENCODE_CONFIG_DIR: engineConfigDir,
      NO_COLOR: "1",
      ...env,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  spawned.push(child)
  return child
}

/** Collects stdout and resolves once `pattern` appears. */
function reader(stream: ReadableStream<Uint8Array>) {
  let output = ""
  const waiters: Array<{ pattern: RegExp; resolve: (match: RegExpMatchArray) => void }> = []
  void (async () => {
    const source = stream.getReader()
    while (true) {
      const chunk = await source.read()
      if (chunk.done) return
      output += new TextDecoder().decode(chunk.value)
      waiters.splice(0).forEach((waiter) => {
        const match = output.match(waiter.pattern)
        if (match) return waiter.resolve(match)
        waiters.push(waiter)
      })
    }
  })()
  return {
    wait: (pattern: RegExp, timeout = 15_000) =>
      new Promise<RegExpMatchArray>((resolve, reject) => {
        const match = output.match(pattern)
        if (match) return resolve(match)
        waiters.push({ pattern, resolve })
        setTimeout(() => reject(new Error(`timed out waiting for ${pattern}\n${output}`)), timeout)
      }),
    get output() {
      return output
    },
  }
}

describe("flupcode remote", () => {
  test("prints a pairing code, pairs a phone and manages devices", async () => {
    const host = cli("remote", "--no-serve", "--engine", `http://127.0.0.1:${engine.port}`, "--relay", relay.url)
    const out = reader(host.stdout)
    const [url] = await out.wait(/https:\/\/app\.flupcode\.com\/#remote=[\w-]+/)
    await out.wait(/Relay .*online/)

    const link = parsePairingHash(new URL(url).hash)!
    const tunnel = createTunnelClient(
      await connectChannel(await connectRelayClient({ relay: relay.url, hostId: link.host }), {
        mode: "pair",
        id: link.id,
        psk: fromBase64Url(link.secret),
      }),
    )
    await new Promise((resolve) => tunnel.onControl(resolve))
    tunnel.sendControl({ type: "device", name: "Test phone" })
    await out.wait(/Paired Test phone/)
    expect(await (await tunnel.fetch("https://remote.invalid/global/health")).json()).toEqual({ healthy: true })

    const again = cli("remote", "--no-serve", "--engine", `http://127.0.0.1:${engine.port}`)
    expect(await new Response(again.stderr).text()).toContain("already running")

    host.stdin.write("d\n")
    await out.wait(/1\. Test phone .* connected/)
    host.stdin.write("q\n")
    expect(await host.exited).toBe(0)
    tunnel.close()

    expect((statSync(join(configDir, "remote.json")).mode & 0o777).toString(8)).toBe("600")
    const listed = cli("remote", "devices")
    expect(await new Response(listed.stdout).text()).toContain("1. Test phone")

    const revoked = cli("remote", "revoke", "1")
    expect(await new Response(revoked.stdout).text()).toContain("Removed Test phone")
    expect(JSON.parse(readFileSync(join(configDir, "remote.json"), "utf8")).devices).toEqual([])
  }, 60_000)

  test("explains how to start the engine when it is not running", async () => {
    const run = cli("remote", "--no-serve", "--engine", "http://127.0.0.1:9")
    expect(await new Response(run.stderr).text()).toContain("opencode serve --port 9")
    expect(await run.exited).toBe(1)
  })

  test("asks for the password of an OpenCode 2.x engine it did not start", async () => {
    const locked = Bun.serve({
      port: 0,
      fetch: () => Response.json({ _tag: "UnauthorizedError", message: "Authentication required" }, { status: 401 }),
    })
    try {
      const run = cliWith(
        { OPENCODE_SERVER_PASSWORD: undefined },
        "remote",
        "--no-serve",
        "--engine",
        locked.url.href.replace(/\/$/, ""),
      )
      expect(await new Response(run.stderr).text()).toContain("is OpenCode 2 and wants a password")
      expect(await run.exited).toBe(1)
    } finally {
      locked.stop(true)
    }
  })

  // OpenCode 2 always runs behind a password, so the one flupcode starts gets its own, and the relay
  // signs in with it: a paired phone reaches the engine without ever being told the password.
  test("starts an OpenCode 2.x engine with a password of its own and exposes it through the relay", async () => {
    const bin = mkdtempSync(join(tmpdir(), "flupcode-cli-bin-"))
    const server = join(bin, "server.ts")
    writeFileSync(
      server,
      `const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const expected = "Basic " + btoa(process.env.OPENCODE_SERVER_USERNAME + ":" + process.env.OPENCODE_SERVER_PASSWORD)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: (request) => {
    if (!process.env.OPENCODE_SERVER_PASSWORD || request.headers.get("authorization") !== expected)
      return Response.json({ _tag: "UnauthorizedError" }, { status: 401 })
    if (new URL(request.url).pathname === "/api/info") return Response.json({ version: "2.0.20" })
    return Response.json({ _tag: "NotFound" }, { status: 404 })
  },
})
`,
    )
    writeFileSync(
      join(bin, "opencode"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v2.0.20"; exit 0; fi\nexec "${process.execPath}" "${server}" "$@"\n`,
    )
    chmodSync(join(bin, "opencode"), 0o755)
    const free = Bun.serve({ port: 0, fetch: () => new Response() })
    const port = free.port
    free.stop(true)
    const ownDir = mkdtempSync(join(tmpdir(), "flupcode-cli-v2-"))
    try {
      const host = cliWith(
        {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FLUPCODE_CONFIG_DIR: ownDir,
          OPENCODE_SERVER_PASSWORD: undefined,
          OPENCODE_SERVER_USERNAME: undefined,
        },
        "remote",
        "--engine",
        `http://127.0.0.1:${port}`,
        "--relay",
        relay.url,
      )
      const out = reader(host.stdout)
      await out.wait(/Engine: OpenCode 2\.0\.20/)
      const [url] = await out.wait(/https:\/\/app\.flupcode\.com\/#remote=[\w-]+/)
      await out.wait(/Relay .*online/)

      const link = parsePairingHash(new URL(url).hash)!
      const tunnel = createTunnelClient(
        await connectChannel(await connectRelayClient({ relay: relay.url, hostId: link.host }), {
          mode: "pair",
          id: link.id,
          psk: fromBase64Url(link.secret),
        }),
      )
      await new Promise((resolve) => tunnel.onControl(resolve))
      tunnel.sendControl({ type: "device", name: "Test phone" })
      await out.wait(/Paired Test phone/)
      expect(await (await tunnel.fetch("https://remote.invalid/api/info")).json()).toEqual({ version: "2.0.20" })
      // Nobody else can: the engine is not open to a caller without the password.
      expect((await fetch(`http://127.0.0.1:${port}/api/info`)).status).toBe(401)

      // The plugins went to the engine's config before it started, in the set 2.x loads.
      expect(readFileSync(join(engineConfigDir, "plugins", "flupcode-tool-uses.js"), "utf8")).toContain(
        "for OpenCode 2",
      )

      host.stdin.write("q\n")
      expect(await host.exited).toBe(0)
      tunnel.close()
    } finally {
      rmSync(bin, { recursive: true, force: true })
      rmSync(ownDir, { recursive: true, force: true })
    }
  }, 60_000)
})
