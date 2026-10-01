import { Database } from "bun:sqlite"
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
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

/**
 * A stand-in OpenCode 2 binary: `--version` names 2.0.20 and `serve` answers `/api/info` only with the
 * password it was started with, telling which database and user name it was given. The migration
 * status says the import finished, as the real one does once it has.
 */
function fakeOpenCodeV2() {
  const bin = mkdtempSync(join(tmpdir(), "flupcode-cli-bin-"))
  const server = join(bin, "server.ts")
  writeFileSync(
    server,
    `const port = Number(process.argv[process.argv.indexOf("--port") + 1])
const expected = "Basic " + btoa("opencode:" + process.env.OPENCODE_SERVER_PASSWORD)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: (request) => {
    if (!process.env.OPENCODE_SERVER_PASSWORD || request.headers.get("authorization") !== expected)
      return Response.json({ _tag: "UnauthorizedError" }, { status: 401 })
    const path = new URL(request.url).pathname
    if (path === "/api/info")
      return Response.json({ version: "2.0.20", db: process.env.OPENCODE_DB, user: process.env.OPENCODE_SERVER_USERNAME ?? null })
    if (path === "/api/experimental/migration/v1") return Response.json({ status: "completed" })
    return Response.json({ _tag: "NotFound" }, { status: 404 })
  },
})
`,
  )
  const binary = join(bin, "opencode")
  writeFileSync(
    binary,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v2.0.20"; exit 0; fi\nexec "${process.execPath}" "${server}" "$@"\n`,
  )
  chmodSync(binary, 0o755)
  return { bin, binary }
}

function freePort() {
  const free = Bun.serve({ port: 0, fetch: () => new Response() })
  const port = free.port
  free.stop(true)
  return port
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
    const { bin } = fakeOpenCodeV2()
    const port = freePort()
    const data = mkdtempSync(join(tmpdir(), "flupcode-cli-data-"))
    const ownDir = mkdtempSync(join(tmpdir(), "flupcode-cli-v2-"))
    try {
      const host = cliWith(
        {
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          FLUPCODE_CONFIG_DIR: ownDir,
          OPENCODE_SERVER_PASSWORD: undefined,
          OPENCODE_SERVER_USERNAME: "someone",
          XDG_DATA_HOME: data,
          // The `opencode` on the PATH, which here is a 2.x: it still gets FlupCode's environment.
          FLUPCODE_ENGINE: "v1",
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
      // FlupCode's own database, never 1.x's `opencode.db`, and the user name 2.x expects (V2-60).
      expect(await (await tunnel.fetch("https://remote.invalid/api/info")).json()).toEqual({
        version: "2.0.20",
        db: join(data, "flupcode", "opencode-v2", "opencode.db"),
        user: null,
      })
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
      rmSync(data, { recursive: true, force: true })
    }
  }, 60_000)

  // OpenCode 2 is the default (V2-70), named explicitly: whatever `opencode` the PATH holds is not run.
  test("starts the named OpenCode 2 binary by default, not the opencode on the PATH", async () => {
    const { bin, binary } = fakeOpenCodeV2()
    const decoy = mkdtempSync(join(tmpdir(), "flupcode-cli-decoy-"))
    writeFileSync(join(decoy, "opencode"), `#!/bin/sh\necho "opencode 1.4.0"\nexit 3\n`)
    chmodSync(join(decoy, "opencode"), 0o755)
    const ownDir = mkdtempSync(join(tmpdir(), "flupcode-cli-v2-"))
    const data = mkdtempSync(join(tmpdir(), "flupcode-cli-data-"))
    try {
      const host = cliWith(
        {
          PATH: `${decoy}:${process.env.PATH ?? ""}`,
          FLUPCODE_ENGINE: undefined,
          FLUPCODE_OPENCODE: binary,
          FLUPCODE_CONFIG_DIR: ownDir,
          OPENCODE_SERVER_PASSWORD: undefined,
          XDG_DATA_HOME: data,
        },
        "remote",
        "--engine",
        `http://127.0.0.1:${freePort()}`,
        "--relay",
        relay.url,
      )
      const out = reader(host.stdout)
      await out.wait(/Engine: OpenCode 2\.0\.20/)
      host.stdin.write("q\n")
      expect(await host.exited).toBe(0)
    } finally {
      for (const folder of [bin, decoy, ownDir, data]) rmSync(folder, { recursive: true, force: true })
    }
  }, 60_000)
})

describe("flupcode engine", () => {
  /** A database with 1.x's session and message tables. */
  function v1Database(folder: string) {
    const path = join(folder, "opencode.db")
    const db = new Database(path)
    db.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
    db.run("CREATE TABLE message (id TEXT PRIMARY KEY)")
    db.run("INSERT INTO session VALUES ('ses_1')")
    db.run("INSERT INTO message VALUES ('msg_1'), ('msg_2')")
    db.close()
    return path
  }

  test("import-v1 copies the 1.x history, lets OpenCode 2 import it, and rollback-import undoes it", async () => {
    const { bin, binary } = fakeOpenCodeV2()
    const data = mkdtempSync(join(tmpdir(), "flupcode-cli-data-"))
    const source = v1Database(data)
    const env = { FLUPCODE_OPENCODE: binary, XDG_DATA_HOME: data, OPENCODE_SERVER_PASSWORD: undefined }
    const target = join(data, "flupcode", "opencode-v2", "opencode.db")
    try {
      const imported = cliWith(
        env,
        "engine",
        "import-v1",
        "--from",
        source,
        "--engine",
        `http://127.0.0.1:${freePort()}`,
      )
      const output = await new Response(imported.stdout).text()
      expect(await imported.exited).toBe(0)
      expect(output).toContain("Copied 1 sessions (2 messages)")
      expect(output).toContain("Imported.")
      expect(existsSync(target)).toBe(true)

      const rolledBack = cliWith(env, "engine", "rollback-import", "--engine", `http://127.0.0.1:${freePort()}`)
      expect(await new Response(rolledBack.stdout).text()).toContain("empty again")
      expect(await rolledBack.exited).toBe(0)
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(bin, { recursive: true, force: true })
      rmSync(data, { recursive: true, force: true })
    }
  }, 60_000)

  test("refuses to change FlupCode's OpenCode 2 database while an OpenCode 2 engine answers", async () => {
    const running = Bun.serve({
      port: 0,
      fetch: () => Response.json({ _tag: "UnauthorizedError" }, { status: 401 }),
    })
    const data = mkdtempSync(join(tmpdir(), "flupcode-cli-data-"))
    try {
      const refused = cliWith(
        { XDG_DATA_HOME: data },
        "engine",
        "import-v1",
        "--from",
        v1Database(data),
        "--engine",
        running.url.href.replace(/\/$/, ""),
      )
      expect(await new Response(refused.stderr).text()).toContain("stop it first")
      expect(await refused.exited).toBe(1)
      expect(existsSync(join(data, "flupcode", "opencode-v2", "opencode.db"))).toBe(false)
    } finally {
      running.stop(true)
      rmSync(data, { recursive: true, force: true })
    }
  })
})
