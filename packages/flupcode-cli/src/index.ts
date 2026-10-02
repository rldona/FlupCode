#!/usr/bin/env bun
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { dirname, join } from "node:path"
import { parseArgs } from "node:util"
import { createRemoteHost, PAIRING_TTL, type RemoteHostState, type RemoteHostStore } from "@flupcode/remote"
import { detectEngine, openCodeV2Locked } from "@flupcode/remote/engine-kind"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import { startEngineProxy, WEB_ORIGINS } from "@flupcode/remote/engine-proxy"
import {
  openCodeV2Database,
  openCodeV2Env,
  OPENCODE_V2_VERSION,
  resolveOpenCodeV2,
} from "@flupcode/remote/opencode-v2"
import { diagnosticsBundle } from "@flupcode/remote/diagnostics"
import { engineConfigDir } from "@flupcode/remote/engine-plugins"
import {
  engineEnvBesideHarness,
  harnessHealthy,
  harnessServerEnv,
  resolveHarnessServer,
} from "@flupcode/remote/harness-host"
import { flupcodeDataDir, reapOrphan, superviseChild } from "@flupcode/remote/supervisor"
import QRCode from "qrcode"
import pkg from "../package.json"

/** `flupcode remote`: host remote control from a terminal, like `claude remote-control` (F8-11). */

const HELP = `FlupCode ${pkg.version}

Usage:
  flupcode remote [options]        Let a phone control this computer's OpenCode sessions
  flupcode remote devices          List paired devices
  flupcode remote revoke <device>  Remove a paired device (number from "devices", id or name)
  flupcode serve [--port 4096]     Run OpenCode 2 and FlupCode's harness for the web app on this computer
  flupcode serve --install         Run it whenever you log in (macOS, Linux); --uninstall undoes it
  flupcode pair                    Print a one-time code that pairs a web app tab with this computer
  flupcode pair revoke             Unpair every web app tab
  flupcode engine install          Fetch the pinned OpenCode 2 engine and print where it is
  flupcode engine import-v1        Copy OpenCode 1.x history into FlupCode's OpenCode 2 engine
  flupcode engine import-memory    Copy a running OpenCode 1.x engine's memories into it
  flupcode engine rollback-import  Put FlupCode's OpenCode 2 database back as it was before
  flupcode diagnostics             Print versions, the engine's state and log, and config, secrets removed

Options:
  --engine <url>   OpenCode server to expose (default: http://127.0.0.1:4096)
  --relay <url>    Relay (default: wss://relay.flupcode.com)
  --app <url>      Web app that opens pairing links (default: https://app.flupcode.com/)
  --no-serve       Do not start "opencode serve" when the engine is not running
  --harness-port <port>  serve, pair: where FlupCode's harness listens (default: 4097)
  --from <path|url>  import-v1: the 1.x database (default: ~/.local/share/opencode/opencode.db);
                     import-memory: the running 1.x engine (default: http://127.0.0.1:4096)
  -h, --help       Show this help
  -v, --version    Show the version

While running, type: p (new pairing code), d (devices), r <n> (remove device), q (quit).

Environment: OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME for a password-protected engine,
FLUPCODE_CONFIG_DIR to change where the host identity, devices and tokens are stored,
FLUPCODE_WEB_ORIGINS for the places besides app.flupcode.com the web app is served from (comma-separated).
FLUPCODE_HARNESS_SERVER names the harness server binary; by default it is flupcode-harness beside
this one. An OpenCode 2 engine
always runs behind a password, so one flupcode starts gets a password of its own, and its own
database: OpenCode 1.x history reaches it only through "flupcode engine import-v1".
The engine flupcode starts is OpenCode 2 (the pinned engine, or FLUPCODE_OPENCODE); OpenCode 1.x is
no longer supported. FLUPCODE_V1_PASSWORD signs in to the 1.x engine import-memory reads.`

const tty = process.stdout.isTTY === true
const paint = (code: number) => (text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text)
const dim = paint(2)
const bold = paint(1)
const green = paint(32)
const yellow = paint(33)
const red = paint(31)

function fail(message: string): never {
  console.error(red(`error: ${message}`))
  process.exit(1)
}

const configDir = () =>
  process.env.FLUPCODE_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "flupcode")
const storeFile = () => join(configDir(), "remote.json")
const lockFile = () => join(configDir(), "remote.lock")

function readStore(): RemoteHostStore {
  if (!existsSync(storeFile())) return { enabled: false, devices: [] }
  const stored = JSON.parse(readFileSync(storeFile(), "utf8")) as Partial<RemoteHostStore>
  return {
    enabled: stored.enabled === true,
    relay: stored.relay,
    identity: stored.identity,
    devices: stored.devices ?? [],
  }
}

function writeStore(stored: RemoteHostStore) {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  writeFileSync(storeFile(), JSON.stringify(stored, null, 2), { mode: 0o600 })
  chmodSync(storeFile(), 0o600)
}

/** The pid of a running `flupcode remote`, if any. */
function runningHost() {
  if (!existsSync(lockFile())) return undefined
  const pid = Number(readFileSync(lockFile(), "utf8"))
  if (!Number.isInteger(pid) || pid === process.pid) return undefined
  try {
    process.kill(pid, 0)
    return pid
  } catch {
    return undefined
  }
}

function ago(timestamp: number) {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours} h ago` : new Date(timestamp).toLocaleDateString()
}

function printDevices(
  devices: Array<{
    name: string
    id: string
    lastSeen: number
    connected?: boolean
    notifications?: boolean
    push?: unknown
  }>,
) {
  if (devices.length === 0) return console.log(dim("No paired devices."))
  devices.forEach((device, index) =>
    console.log(
      `  ${index + 1}. ${bold(device.name)} ${dim(device.id)}  ${device.connected ? green("connected") : dim(`last seen ${ago(device.lastSeen)}`)}${device.notifications || device.push ? dim("  notifications on") : ""}`,
    ),
  )
}

function resolveDevice(devices: Array<{ id: string; name: string }>, query: string) {
  const index = Number(query)
  if (Number.isInteger(index) && index >= 1 && index <= devices.length) return devices[index - 1]
  return devices.find((device) => device.id === query) ?? devices.find((device) => device.name === query)
}

function engineCredentials() {
  const password = process.env.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  return btoa(`${process.env.OPENCODE_SERVER_USERNAME ?? "opencode"}:${password}`)
}

function runningEngine(engine: string, credentials: string | undefined) {
  return detectEngine(engine, fetch, { headers: credentials ? { authorization: `Basic ${credentials}` } : {} })
}

/**
 * The engine to expose, started when nothing answers and `serve` allows it, and the credentials the
 * relay signs in with. OpenCode 2 always runs behind a password (it makes one up when none is set),
 * so one it starts is given its own.
 */
async function ensureEngine(engine: string, credentials: string | undefined, serve: boolean) {
  const running = await runningEngine(engine, credentials)
  // Plugins live in this computer's OpenCode config, so they only matter for a local engine.
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(engine).hostname)
  if (running.kind === "v2") {
    const plugins = local ? await installEnginePlugins() : undefined
    if (plugins?.changed) console.log(dim("Restart opencode serve to load FlupCode's engine plugins."))
    noteV2(running.version)
    return { child: undefined, credentials }
  }
  if (await openCodeV2Locked(engine))
    fail(
      `the engine at ${engine} is OpenCode 2 and wants a password; ` +
        "set OPENCODE_SERVER_PASSWORD to the one it was started with, or stop it and let flupcode start its own",
    )
  if (running.kind === "v1")
    fail(
      `the engine at ${engine} is OpenCode 1.x, which FlupCode no longer supports; ` +
        "stop it and let flupcode start OpenCode 2 (flupcode engine import-v1 brings its history over)",
    )
  if (!serve) fail(`no OpenCode server at ${engine}; start one with "flupcode serve" or pass --engine`)
  // The pinned binary or `FLUPCODE_OPENCODE`, never whichever `opencode` the PATH happens to hold.
  const command = await resolveOpenCodeV2().catch((cause: unknown) =>
    fail(`could not get OpenCode ${OPENCODE_V2_VERSION}: ${cause instanceof Error ? cause.message : String(cause)}`),
  )
  // Before it starts: an engine reads its plugins once, at startup.
  if (local) await installEnginePlugins()
  const password = process.env.OPENCODE_SERVER_PASSWORD || randomBytes(24).toString("hex")
  // 2.x has no user name setting: it always signs in as "opencode".
  const signIn = btoa(`opencode:${password}`)
  console.log(dim(`Starting opencode serve on ${engine}…`))
  const url = new URL(engine)
  // Kept alive like the one `flupcode serve` starts (HE-03), with its own log and pid file.
  const child = superviseChild({
    name: "remote-engine",
    command,
    args: ["serve", "--hostname", url.hostname, "--port", url.port || "4096"],
    options: {
      shell: process.platform === "win32",
      // FlupCode's own database: 2.x would migrate 1.x's `opencode.db` one way (V2-61).
      env: openCodeV2Env({ password }),
    },
    dir: flupcodeDataDir(),
    ready: async () => (await runningEngine(engine, signIn)).kind === "v2",
  })
  const state = await child.start()
  if (state.phase !== "running")
    fail(`opencode serve did not become ready at ${engine}: ${state.failure?.message ?? ""}\nLog: ${state.log}`)
  const started = await runningEngine(engine, signIn)
  noteV2(started.kind === "v2" ? started.version : OPENCODE_V2_VERSION)
  return { child, credentials: signIn }
}

/** OpenCode 2 runs FlupCode's 2.x plugins; it is said once, so the engine in use is never a guess. */
function noteV2(version: string) {
  console.log(dim(`Engine: OpenCode ${version}`))
}

/**
 * `flupcode engine …` (V2-60, V2-61): the OpenCode 2 engine FlupCode starts, and bringing 1.x history
 * into it when asked. Both imports change FlupCode's 2.x database, so they refuse while an OpenCode 2
 * engine answers at `--engine`, and run their own private engine for the part that needs one.
 */
async function runEngineCommand(subcommand: string | undefined, options: { engine: string; from?: string }) {
  if (subcommand === "install") {
    console.log(await resolveOpenCodeV2())
    return
  }
  const { importV1History, importV1Memories, rollbackV1Import } = await import("@flupcode/remote/v1-import")
  const target = openCodeV2Database()
  if (subcommand === "rollback-import") {
    await refuseWhileRunning(options.engine)
    const result = rollbackV1Import({ target })
    console.log(
      result.restored
        ? `Restored FlupCode's OpenCode 2 database from ${result.restored}`
        : "FlupCode's OpenCode 2 database is empty again",
    )
    console.log(dim(`The one it replaced is kept at ${result.aside}`))
    return
  }
  if (subcommand === "import-v1") {
    await refuseWhileRunning(options.engine)
    const copied = importV1History({ ...(options.from ? { source: options.from } : {}), target })
    console.log(`Copied ${copied.sessions} sessions (${copied.messages} messages) from ${copied.source}`)
    if (copied.backup) console.log(dim(`The previous OpenCode 2 database is kept at ${copied.backup}`))
    // 2.x imports the copy when it starts; a private engine runs it now, so the reader sees it finish.
    const engine = await privateOpenCodeV2()
    try {
      for (;;) {
        const status = (await (
          await fetch(`${engine.url}/api/experimental/migration/v1`, {
            headers: { authorization: engine.authorization },
          })
        ).json()) as {
          status: string
          error?: string
          progress?: { label: string; numerator?: number; denominator?: number }
        }
        if (status.status === "completed") break
        if (status.status === "error") fail(`OpenCode 2 could not import the history: ${status.error}`)
        if (status.progress)
          console.log(
            dim(
              `${status.progress.label}${status.progress.denominator ? ` ${status.progress.numerator ?? 0}/${status.progress.denominator}` : ""}`,
            ),
          )
        await Bun.sleep(500)
      }
    } finally {
      engine.stop()
    }
    console.log(green(`Imported. "flupcode engine rollback-import" undoes it.`))
    return
  }
  if (subcommand === "import-memory") {
    await refuseWhileRunning(options.engine)
    const from = options.from ?? "http://127.0.0.1:4096"
    const password = process.env.FLUPCODE_V1_PASSWORD
    const authorization = password ? `Basic ${btoa(`opencode:${password}`)}` : undefined
    const v1 = await detectEngine(from, fetch, authorization ? { headers: { authorization } } : {})
    if (v1.kind !== "v1") fail(`no OpenCode 1.x engine at ${from}; start it, or pass --from <url>`)
    const engine = await privateOpenCodeV2()
    try {
      const result = await importV1Memories({
        from: { url: from, ...(authorization ? { authorization } : {}) },
        to: { url: engine.url, authorization: engine.authorization },
      })
      console.log(green(`Imported ${result.imported} of ${result.found} memories`))
    } finally {
      engine.stop()
    }
    return
  }
  fail(`unknown command "engine${subcommand ? ` ${subcommand}` : ""}"; see flupcode --help`)
}

/**
 * `flupcode serve` (2.1, HE-01): OpenCode 2 and FlupCode's harness for the web app, with nothing to
 * type in but a pairing code. 2.x always asks for a password and a page cannot send one, so the
 * engine runs on a private port and a proxy at the port the web app asks signs in for it, serving only
 * FlupCode's web app among browser pages. The harness (runs, routines, artifacts) listens on the
 * loopback beside it and answers a hosted tab only once that tab paired with a code this prints.
 */
async function runServe(port: number, harnessPort: number) {
  const address = `http://127.0.0.1:${port}`
  if ((await runningEngine(address, engineCredentials())).kind !== "none" || (await openCodeV2Locked(address)))
    fail(`an engine already answers at ${address}; stop it, or pass --port`)
  const harnessUrl = `http://127.0.0.1:${harnessPort}`
  if (await harnessHealthy(harnessUrl))
    fail(`a harness already answers at ${harnessUrl} (the desktop app?); quit it, or pass --harness-port`)
  const password = randomBytes(24).toString("hex")
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const enginePort = probe.port
  probe.stop(true)
  const engineUrl = `http://127.0.0.1:${enginePort}`
  // First, as the desktop does: the engine's plugins read the plugin token the harness writes when
  // it starts, and an engine reads its plugins once.
  const harness = await supervisedHarness({ engineUrl, password, port: harnessPort })
  const engine = await supervisedOpenCodeV2({ password, port: enginePort, harnessUrl })
  // The desktop app, opened while this runs, uses this engine rather than starting one: its window is
  // served too.
  const proxy = await startEngineProxy({
    port,
    engine: engine.url,
    authorization: engine.authorization,
    origins: ["oc://renderer"],
  }).catch(async (cause: unknown) => {
    await Promise.all([engine.stop(), harness?.stop()])
    return fail(`could not listen on ${address}: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
  const info = (await (
    await fetch(`${engine.url}/api/info`, { headers: { authorization: engine.authorization } })
  ).json()) as {
    version?: string
  }
  console.log(
    `${bold("OpenCode")} ${info.version ?? OPENCODE_V2_VERSION} ${dim("for FlupCode's web app at")} ${proxy.url}`,
  )
  if (harness) console.log(`${bold("Harness")} ${dim("(runs, routines, artifacts) at")} ${harnessUrl}`)
  console.log(dim(`Open ${WEB_ORIGINS[0]} and connect to ${proxy.url}. Ctrl-C stops it.`))
  if (harness) await printPairingCode(harnessUrl)
  console.log(dim(`Logs: ${engine.log}${harness ? `, ${harness.log}` : ""}`))
  const stop = () => {
    void proxy.close().finally(async () => {
      await Promise.all([engine.stop(), harness?.stop()])
      process.exit(0)
    })
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  await new Promise(() => undefined)
}

/**
 * The harness `flupcode serve` keeps running (HE-01, HE-03), as the desktop starts it: the compiled
 * `flupcode-harness` beside this binary (or `FLUPCODE_HARNESS_SERVER`, or a checkout's source), on the
 * loopback, driving the engine with its password. Without one, `serve` still serves the engine and
 * says what is missing.
 */
async function supervisedHarness(input: { engineUrl: string; password: string; port: number }) {
  const extension = process.platform === "win32" ? ".exe" : ""
  const binary = `flupcode-harness${extension}`
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string]
  const server = resolveHarnessServer({
    // As released (`flupcode-harness-darwin-arm64`), or renamed like `flupcode` itself.
    binaries: [binary, `flupcode-harness-${os}-${process.arch}${extension}`].map((name) => join(dirname(process.execPath), name)),
    // From a checkout, Bun runs this file and the harness's source sits two folders up.
    checkout: join(import.meta.dir, "..", "..", "harness-server"),
    bun: process.execPath,
  })
  if (!server) {
    console.log(
      yellow(
        `FlupCode's harness was not found (put ${binary} beside flupcode, or name it with FLUPCODE_HARNESS_SERVER): ` +
          "the web app gets the engine, but no runs, routines or artifacts.",
      ),
    )
    return undefined
  }
  const url = `http://127.0.0.1:${input.port}`
  const dir = flupcodeDataDir()
  await reapOrphan({ dir, name: "harness", probe: async (record) => typeof record.meta?.url === "string" && (await harnessHealthy(record.meta.url)) })
  let announced = "starting"
  const harness = superviseChild({
    name: "harness",
    command: server.command,
    args: server.args,
    options: {
      ...(server.cwd ? { cwd: server.cwd } : {}),
      env: harnessServerEnv({
        // Never on another address: the harness is the agent's controls (HE-01).
        env: { ...process.env, FLUPCODE_HARNESS_HOST: "127.0.0.1" },
        engineUrl: input.engineUrl,
        port: input.port,
        authorization: btoa(`opencode:${input.password}`),
      }),
    },
    dir,
    ready: () => harnessHealthy(url),
    meta: { url },
    onChange: (state) => {
      if (state.phase === announced) return
      if (state.phase === "restarting") console.log(yellow(`The harness stopped (${state.failure?.message}), restarting…`))
      if (state.phase === "running" && announced === "restarting") console.log(green("The harness is back."))
      if (state.phase === "failed" && announced !== "starting")
        console.log(red(`The harness stopped and could not be restarted: ${state.failure?.message}`))
      announced = state.phase
    },
  })
  const state = await harness.start()
  if (state.phase !== "running")
    fail(
      `FlupCode's harness ${state.failure?.message ?? "did not start"}\n${(state.failure?.lastLines ?? []).join("\n")}\nLog: ${state.log}`,
    )
  return { log: state.log, stop: () => harness.stop() }
}

/**
 * The engine `flupcode serve` keeps running (HE-03): restarted on the same private port and password
 * when it stops, so the proxy in front of it keeps working, and its output kept in
 * `$XDG_DATA_HOME/flupcode/logs/engine.log`. One an earlier `serve` left behind when it was killed is
 * stopped first: nobody has its password any more. None of the harness's secrets reach it.
 */
async function supervisedOpenCodeV2(input: { password: string; port: number; harnessUrl: string }) {
  const binary = await resolveOpenCodeV2()
  await installEnginePlugins()
  const dir = flupcodeDataDir()
  await reapOrphan({
    dir,
    name: "engine",
    probe: async (record) => typeof record.meta?.url === "string" && (await openCodeV2Locked(record.meta.url)),
  })
  const url = `http://127.0.0.1:${input.port}`
  const authorization = `Basic ${btoa(`opencode:${input.password}`)}`
  let announced = "running"
  const engine = superviseChild({
    name: "engine",
    command: binary,
    args: ["serve", "--hostname", "127.0.0.1", "--port", String(input.port)],
    options: { env: openCodeV2Env({ password: input.password, env: engineEnvBesideHarness(process.env, input.harnessUrl) }) },
    dir,
    ready: async () => (await detectEngine(url, fetch, { headers: { authorization } })).kind === "v2",
    meta: { url },
    onChange: (state) => {
      if (state.phase === announced) return
      if (state.phase === "restarting") console.log(yellow(`The engine stopped (${state.failure?.message}), restarting…`))
      if (state.phase === "running" && announced === "restarting") console.log(green("The engine is back."))
      if (state.phase === "failed" && announced !== "starting")
        console.log(red(`The engine stopped and could not be restarted: ${state.failure?.message}`))
      announced = state.phase
    },
  })
  announced = "starting"
  const state = await engine.start()
  if (state.phase !== "running")
    fail(
      `OpenCode ${OPENCODE_V2_VERSION} ${state.failure?.message ?? "did not start"}\n${(state.failure?.lastLines ?? []).join("\n")}\nLog: ${state.log}`,
    )
  return { url, authorization, log: state.log, stop: () => engine.stop() }
}

/**
 * The UI's token the harness compares, as the harness reads it: the environment, then the file in
 * FlupCode's config folder. `flupcode` is the person at the terminal, so it may use it to ask for a
 * pairing code; a page never can.
 */
function uiToken() {
  const fromEnv = process.env.FLUPCODE_BROWSER_TOKEN?.trim()
  if (fromEnv) return fromEnv
  const file = join(configDir(), "browser-token")
  return existsSync(file) ? readFileSync(file, "utf8").trim() || undefined : undefined
}

/** Asks the harness at `url` for one of its pairing routes, as the person at the terminal. */
async function askHarness(url: string, path: string, method: string) {
  const token = uiToken()
  if (!token) fail(`no harness token in ${configDir()}; is flupcode serve (or the desktop app) running?`)
  const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}` } }).catch(() =>
    fail(`no harness answers at ${url}; start it with flupcode serve`),
  )
  if (response.status === 404) fail(`the harness at ${url} cannot pair web app tabs; update it`)
  if (!response.ok) fail(`the harness at ${url} refused (${response.status}); it uses another token`)
  return ((await response.json()) as { data: Record<string, unknown> }).data
}

/** A one-time code for the web app, and where to type it (HE-01). */
async function printPairingCode(url: string) {
  const data = (await askHarness(url, "/harness/pair/codes", "POST")) as { code: string; expiresAt: number }
  const minutes = Math.round((data.expiresAt - Date.now()) / 60_000)
  console.log(`\n${bold("Pairing code")} ${bold(green(data.code))} ${dim(`(works once, expires in ${minutes} min)`)}`)
  console.log(
    dim(
      `Type it in FlupCode's web app (${WEB_ORIGINS[0]}) under Runs. If Chrome asks to let the site reach devices on your local network, allow it: that is this computer.`,
    ),
  )
  console.log(dim("flupcode pair prints a new one.\n"))
}

/** Whether the child `flupcode serve` recorded is still a live process (not that it answers). */
async function servedChildAlive(dir: string, name: string) {
  const file = join(dir, `${name}.pid`)
  if (!existsSync(file)) return false
  const record = (await Bun.file(file)
    .json()
    .catch(() => ({}))) as { pid?: unknown }
  const pid = Number(record.pid)
  return Number.isInteger(pid) && spawnSync("kill", ["-0", String(pid)]).status === 0
}

/** `flupcode diagnostics`: what `flupcode serve` knows about itself, for a bug report, secrets removed. */
async function printDiagnostics() {
  const dir = flupcodeDataDir()
  const tokens = configDir()
  console.log(
    diagnosticsBundle({
      title: "FlupCode diagnostics",
      versions: {
        flupcode: pkg.version,
        "OpenCode (pinned)": OPENCODE_V2_VERSION,
        OS: `${process.platform} ${process.arch}`,
        Bun: Bun.version,
      },
      ports: { "flupcode serve (default)": "http://127.0.0.1:4096", "harness (default)": "http://127.0.0.1:4097" },
      children: await Promise.all(
        ["engine", "harness"]
          .filter((name) => existsSync(join(dir, "logs", `${name}.log`)))
          .map(async (name) => ({
            name,
            phase: (await servedChildAlive(dir, name)) ? "running" : "stopped",
            restarts: 0,
            log: join(dir, "logs", `${name}.log`),
          })),
      ),
      configs: ["opencode.json", "opencode.jsonc"].map((file) => ({ label: "OpenCode", file: join(engineConfigDir(), file) })),
      env: process.env,
      secrets: [
        process.env.OPENCODE_SERVER_PASSWORD,
        ...["browser-token", "plugin-token", "vault-key"].map((file) =>
          existsSync(join(tokens, file)) ? readFileSync(join(tokens, file), "utf8").trim() : undefined,
        ),
      ],
    }),
  )
}

/**
 * `flupcode serve --install` / `--uninstall`: the web app's engine whenever the reader is logged in,
 * so the web app works with nothing to start. A launchd agent on macOS, a systemd user unit on
 * Linux; each restarts it when it stops, and waits while something else (the desktop app) holds the
 * port. `FLUPCODE_SERVICE_MANAGER=none` writes the file without loading it.
 */
async function serveService(action: "install" | "uninstall", port: number, harnessPort: number) {
  const home = process.env.HOME ?? homedir()
  const load = process.env.FLUPCODE_SERVICE_MANAGER !== "none"
  // The compiled binary is itself; from a checkout, Bun runs this file.
  const program = Bun.main.startsWith("/$bunfs") ? [process.execPath] : [process.execPath, Bun.main]
  const args = [...program, "serve", "--port", String(port), "--harness-port", String(harnessPort)]
  if (process.platform === "darwin") {
    const file = join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`)
    const domain = `gui/${process.getuid?.() ?? 0}`
    if (load) spawnSync("launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`], { stdio: "ignore" })
    if (action === "uninstall") {
      rmSync(file, { force: true })
      return console.log(`Removed ${file}`)
    }
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, launchAgent(args, join(home, "Library", "Logs", "flupcode-serve.log")))
    if (load) {
      const loaded = spawnSync("launchctl", ["bootstrap", domain, file], { encoding: "utf8" })
      if (loaded.status !== 0) fail(`launchctl could not load ${file}: ${loaded.stderr.trim()}`)
    }
    return installed(file, port, harnessPort)
  }
  if (process.platform === "linux") {
    const file = join(
      process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
      "systemd",
      "user",
      `${SERVICE_UNIT}.service`,
    )
    if (load) spawnSync("systemctl", ["--user", "disable", "--now", SERVICE_UNIT], { stdio: "ignore" })
    if (action === "uninstall") {
      rmSync(file, { force: true })
      if (load) spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
      return console.log(`Removed ${file}`)
    }
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, systemdUnit(args))
    if (load) {
      spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" })
      const enabled = spawnSync("systemctl", ["--user", "enable", "--now", SERVICE_UNIT], { encoding: "utf8" })
      if (enabled.status !== 0) fail(`systemctl could not start ${SERVICE_UNIT}: ${enabled.stderr.trim()}`)
    }
    return installed(file, port, harnessPort)
  }
  fail("flupcode serve --install supports macOS and Linux; on Windows, run flupcode serve from a startup task")
}

const SERVICE_LABEL = "com.flupcode.serve"
const SERVICE_UNIT = "flupcode-serve"

function installed(file: string, port: number, harnessPort: number) {
  console.log(green(`Installed ${file}`))
  console.log(
    dim(
      `FlupCode's web app finds OpenCode 2 at http://127.0.0.1:${port} and the harness at http://127.0.0.1:${harnessPort} whenever you are logged in.`,
    ),
  )
  console.log(dim("flupcode pair prints the code that pairs a web app tab. flupcode serve --uninstall removes it."))
}

const xml = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

function launchAgent(args: string[], log: string) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${xml(arg)}</string>`).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(process.env.PATH ?? "/usr/bin:/bin")}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`
}

function systemdUnit(args: string[]) {
  const quoted = args.map((arg) =>
    /[\s"\\]/.test(arg) ? `"${arg.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : arg,
  )
  return `[Unit]
Description=OpenCode 2 and FlupCode's harness for the web app (flupcode serve)

[Service]
ExecStart=${quoted.join(" ")}
Environment=PATH=${process.env.PATH ?? "/usr/bin:/bin"}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`
}

/** FlupCode's 2.x database is only changed while no 2.x engine has it open. */
async function refuseWhileRunning(engine: string) {
  const running = await runningEngine(engine, engineCredentials())
  if (running.kind === "v2" || (await openCodeV2Locked(engine)))
    fail(`an OpenCode 2 engine is running at ${engine}; stop it first`)
}

/**
 * An OpenCode 2 engine of its own for one command: the pinned binary on FlupCode's database, a free
 * port and a fresh password, with FlupCode's plugins (the memory import writes through one).
 */
async function privateOpenCodeV2() {
  const binary = await resolveOpenCodeV2()
  await installEnginePlugins()
  const password = randomBytes(24).toString("hex")
  const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = probe.port
  probe.stop(true)
  const child = spawn(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    stdio: "ignore",
    env: openCodeV2Env({ password }),
  })
  const url = `http://127.0.0.1:${port}`
  const authorization = `Basic ${btoa(`opencode:${password}`)}`
  for (let attempt = 0; attempt < 120; attempt++) {
    if ((await detectEngine(url, fetch, { headers: { authorization } })).kind === "v2")
      return { url, authorization, stop: () => child.kill() }
    await Bun.sleep(250)
  }
  child.kill()
  fail(`OpenCode ${OPENCODE_V2_VERSION} did not start on ${openCodeV2Database()}`)
}

async function showPairing(state: RemoteHostState) {
  if (!state.pairing) return
  const minutes = Math.round(PAIRING_TTL / 60_000)
  console.log(`\n${bold("Scan with your phone's camera to pair")} ${dim(`(works once, expires in ${minutes} min)`)}\n`)
  console.log(await QRCode.toString(state.pairing.url, { type: "terminal", small: true }))
  console.log(dim(state.pairing.url))
}

function statusLine(state: RemoteHostState) {
  if (state.connection === "online") return green("● online")
  if (state.connection === "connecting") return yellow(`● connecting${state.detail ? ` (${state.detail})` : ""}`)
  return red(`● offline${state.detail ? ` (${state.detail})` : ""}`)
}

async function runHost(options: { engine: string; relay?: string; app: string; serve: boolean }) {
  const other = runningHost()
  if (other) fail(`flupcode remote is already running (pid ${other})`)
  const engine = await ensureEngine(options.engine, engineCredentials(), options.serve)
  const credentials = engine.credentials
  const engineProcess = engine.child

  mkdirSync(configDir(), { recursive: true, mode: 0o700 })
  writeFileSync(lockFile(), String(process.pid))

  let previous: RemoteHostState | undefined
  let closing = false
  const host = createRemoteHost({
    load: readStore,
    save: writeStore,
    engine: options.engine,
    engineCredentials: credentials,
    defaultRelay: "wss://relay.flupcode.com",
    appUrl: options.app,
    hostName: hostname(),
    secureStorage: false,
    onChange: (state) => {
      if (!previous || closing) return
      if (state.connection !== previous.connection) console.log(`Relay ${statusLine(state)}`)
      state.devices.forEach((device) => {
        const before = previous?.devices.find((entry) => entry.id === device.id)
        // A new device reports its name right after enrolling; announce it then.
        if (!before) return
        if (device.name !== before.name) console.log(green(`Paired ${device.name}`))
        if (device.connected && !before.connected) console.log(green(`${device.name} connected`))
        if (device.notifications !== before.notifications)
          console.log(dim(`${device.name}: notifications ${device.notifications ? "on" : "off"}`))
        if (!device.connected && before.connected) console.log(dim(`${device.name} disconnected`))
      })
      if (previous?.pairing && !state.pairing && state.devices.length === previous.devices.length)
        console.log(dim("The pairing code expired. Type p for a new one."))
      previous = state
    },
  })

  const shutdown = () => {
    closing = true
    host.stop()
    rmSync(lockFile(), { force: true })
    void (engineProcess?.stop() ?? Promise.resolve()).finally(() => process.exit(0))
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)

  if (options.relay) await host.setRelay(options.relay)
  await host.setEnabled(true)
  // Show the pairing code once the relay can reach this computer.
  for (let attempt = 0; attempt < 50 && host.state().connection !== "online"; attempt++) await Bun.sleep(200)
  const started = host.state()
  previous = started
  console.log(`${bold("FlupCode remote control")} ${dim(pkg.version)}`)
  console.log(`  Computer  ${started.hostName}`)
  console.log(`  Engine    ${options.engine}`)
  console.log(`  Relay     ${started.relay}  ${statusLine(started)}`)

  if (started.devices.length === 0) await showPairing(await host.createPairing())
  else {
    console.log("\nPaired devices:")
    printDevices(started.devices)
  }
  console.log(dim("\nType p to pair a phone, d for devices, r <n> to remove one, q to quit.\n"))

  for await (const line of console) {
    const [command, ...rest] = line.trim().split(/\s+/)
    if (command === "q" || command === "quit") shutdown()
    if (command === "p" || command === "pair") await showPairing(await host.createPairing())
    if (command === "d" || command === "devices") {
      console.log(`Relay ${statusLine(host.state())}`)
      printDevices(host.state().devices)
    }
    if (command === "r" || command === "revoke") {
      const device = resolveDevice(host.state().devices, rest.join(" "))
      if (!device) console.log(red("No such device. Type d to list them."))
      else {
        host.revokeDevice(device.id)
        console.log(`Removed ${device.name}`)
      }
    }
  }
  shutdown()
}

const args = parseArgs({
  allowPositionals: true,
  options: {
    engine: { type: "string" },
    relay: { type: "string" },
    app: { type: "string" },
    "no-serve": { type: "boolean" },
    install: { type: "boolean" },
    uninstall: { type: "boolean" },
    from: { type: "string" },
    port: { type: "string" },
    "harness-port": { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
})

if (args.values.version) {
  console.log(pkg.version)
  process.exit(0)
}

const [command, subcommand, ...rest] = args.positionals
if (command === "diagnostics") {
  await printDiagnostics()
  process.exit(0)
}
if (args.values.help || (command !== "remote" && command !== "engine" && command !== "serve" && command !== "pair")) {
  console.log(HELP)
  process.exit(args.values.help || !command ? 0 : 1)
}

const harnessPort = Number(args.values["harness-port"] ?? 4097)
if (command === "serve" && (args.values.install || args.values.uninstall)) {
  await serveService(args.values.install ? "install" : "uninstall", Number(args.values.port ?? 4096), harnessPort)
  process.exit(0)
}
if (command === "serve") await runServe(Number(args.values.port ?? 4096), harnessPort)

if (command === "pair") {
  const url = `http://127.0.0.1:${harnessPort}`
  if (subcommand === "revoke") {
    const data = await askHarness(url, "/harness/pair/tabs", "DELETE")
    console.log(`Unpaired ${String(data.revoked)} tab(s). Each one needs a new code.`)
    process.exit(0)
  }
  if (subcommand) fail(`unknown command "pair ${subcommand}"; see flupcode --help`)
  await printPairingCode(url)
  process.exit(0)
}

if (command === "engine") {
  await runEngineCommand(subcommand, {
    engine: args.values.engine ?? process.env.FLUPCODE_ENGINE_URL ?? "http://127.0.0.1:4096",
    from: args.values.from,
  })
  process.exit(0)
}

if (subcommand === "devices") {
  printDevices(readStore().devices)
  process.exit(0)
}

if (subcommand === "revoke") {
  const pid = runningHost()
  if (pid) fail(`flupcode remote is running (pid ${pid}); remove the device from its prompt with r <n>`)
  const store = readStore()
  const device = resolveDevice(store.devices, rest.join(" "))
  if (!device) fail("no such device; run flupcode remote devices")
  writeStore({ ...store, devices: store.devices.filter((entry) => entry.id !== device.id) })
  console.log(`Removed ${device.name}`)
  process.exit(0)
}

if (subcommand) fail(`unknown command "remote ${subcommand}"; see flupcode --help`)

await runHost({
  engine: args.values.engine ?? process.env.FLUPCODE_ENGINE_URL ?? "http://127.0.0.1:4096",
  relay: args.values.relay ?? process.env.FLUPCODE_RELAY_URL,
  app: args.values.app ?? process.env.FLUPCODE_APP_URL ?? "https://app.flupcode.com/",
  serve: args.values["no-serve"] !== true,
})
