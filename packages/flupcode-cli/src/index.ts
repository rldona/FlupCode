#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { createRemoteHost, PAIRING_TTL, type RemoteHostState, type RemoteHostStore } from "@flupcode/remote"
import { detectEngine, openCodeLineOf, openCodeV2Locked } from "@flupcode/remote/engine-kind"
import { installEnginePlugins } from "@flupcode/remote/engine-plugins"
import {
  openCodeV2Database,
  openCodeV2Env,
  OPENCODE_V2_VERSION,
  resolveOpenCodeV2,
  wantsOpenCodeV2,
} from "@flupcode/remote/opencode-v2"
import QRCode from "qrcode"
import pkg from "../package.json"

/** `flupcode remote`: host remote control from a terminal, like `claude remote-control` (F8-11). */

const HELP = `FlupCode ${pkg.version}

Usage:
  flupcode remote [options]        Let a phone control this computer's OpenCode sessions
  flupcode remote devices          List paired devices
  flupcode remote revoke <device>  Remove a paired device (number from "devices", id or name)
  flupcode engine install          Fetch the pinned OpenCode 2 engine and print where it is
  flupcode engine import-v1        Copy OpenCode 1.x history into FlupCode's OpenCode 2 engine
  flupcode engine import-memory    Copy a running OpenCode 1.x engine's memories into it
  flupcode engine rollback-import  Put FlupCode's OpenCode 2 database back as it was before

Options:
  --engine <url>   OpenCode server to expose (default: http://127.0.0.1:4096)
  --relay <url>    Relay (default: wss://relay.flupcode.com)
  --app <url>      Web app that opens pairing links (default: https://app.flupcode.com/)
  --no-serve       Do not start "opencode serve" when the engine is not running
  --from <path|url>  import-v1: the 1.x database (default: ~/.local/share/opencode/opencode.db);
                     import-memory: the running 1.x engine (default: http://127.0.0.1:4096)
  -h, --help       Show this help
  -v, --version    Show the version

While running, type: p (new pairing code), d (devices), r <n> (remove device), q (quit).

Environment: OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME for a password-protected engine,
FLUPCODE_CONFIG_DIR to change where the host identity and devices are stored. An OpenCode 2 engine
always runs behind a password, so one flupcode starts gets a password of its own, and its own
database: OpenCode 1.x history reaches it only through "flupcode engine import-v1".
FLUPCODE_ENGINE=v2 starts OpenCode 2 (the pinned engine, or FLUPCODE_OPENCODE) instead of the
"opencode" on the PATH. FLUPCODE_V1_PASSWORD signs in to the 1.x engine import-memory reads.`

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
 * so one it starts is given its own; a 1.x engine still starts without one, as the browser on this
 * computer has no way to send it.
 */
async function ensureEngine(engine: string, credentials: string | undefined, serve: boolean) {
  const running = await runningEngine(engine, credentials)
  // Plugins live in this computer's OpenCode config, so they only matter for a local engine.
  const local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(engine).hostname)
  if (running.kind === "v2") {
    const plugins = local ? await installEnginePlugins(undefined, "v2") : undefined
    if (plugins?.changed) console.log(dim("Restart opencode serve to load FlupCode's engine plugins."))
    noteV2(running.version)
    return { child: undefined, credentials }
  }
  if (await openCodeV2Locked(engine))
    fail(
      `the engine at ${engine} is OpenCode 2 and wants a password; ` +
        "set OPENCODE_SERVER_PASSWORD to the one it was started with, or stop it and let flupcode start its own",
    )
  if (running.kind === "v1") {
    const plugins = local ? await installEnginePlugins(undefined, "v1") : undefined
    if (plugins?.changed) console.log(dim("Restart opencode serve to load FlupCode's engine plugins (reasoning effort levels, context capture)."))
    return { child: undefined, credentials }
  }
  const hint = `start it with "opencode serve --port ${new URL(engine).port || 4096}" or pass --engine`
  if (!serve) fail(`no OpenCode server at ${engine}; ${hint}`)
  // `FLUPCODE_ENGINE=v2` asks for OpenCode 2 (V2-60): the pinned binary or `FLUPCODE_OPENCODE`, never
  // whichever `opencode` the PATH happens to hold.
  const command = wantsOpenCodeV2()
    ? await resolveOpenCodeV2().catch((cause: unknown) =>
        fail(
          `could not get OpenCode ${OPENCODE_V2_VERSION}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
      )
    : "opencode"
  const version = spawnSync(command, ["--version"], { encoding: "utf8", shell: process.platform === "win32" })
  if (version.error) fail(`no OpenCode server at ${engine} and the opencode CLI is not installed; ${hint}`)
  const line = wantsOpenCodeV2() ? "v2" : openCodeLineOf(version.stdout)
  // Before it starts: an engine reads its plugins once, at startup.
  if (local) await installEnginePlugins(undefined, line)
  const password = process.env.OPENCODE_SERVER_PASSWORD || (line === "v2" ? randomBytes(24).toString("hex") : undefined)
  // 2.x has no user name setting: it always signs in as "opencode".
  const username = line === "v2" ? "opencode" : (process.env.OPENCODE_SERVER_USERNAME ?? "opencode")
  const signIn = password ? btoa(`${username}:${password}`) : undefined
  console.log(dim(`Starting opencode serve on ${engine}…`))
  const url = new URL(engine)
  const child = spawn(command, ["serve", "--hostname", url.hostname, "--port", url.port || "4096"], {
    stdio: "ignore",
    shell: process.platform === "win32",
    // A 2.x engine gets FlupCode's own database: it would migrate 1.x's `opencode.db` one way (V2-61).
    env:
      line === "v2" && password
        ? openCodeV2Env({ password })
        : password
          ? { ...process.env, OPENCODE_SERVER_USERNAME: username, OPENCODE_SERVER_PASSWORD: password }
          : process.env,
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    const started = await runningEngine(engine, signIn)
    if (started.kind === "v1") return { child, credentials: signIn }
    if (started.kind === "v2") {
      noteV2(started.version)
      return { child, credentials: signIn }
    }
    await Bun.sleep(500)
  }
  child.kill()
  fail(`opencode serve did not become ready at ${engine}`)
}

/** OpenCode 2 runs FlupCode's 2.x plugins; it is said once, so the line in use is never a guess. */
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
  await installEnginePlugins(undefined, "v2")
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
  const engineProcess: ChildProcess | undefined = engine.child

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
    engineProcess?.kill()
    rmSync(lockFile(), { force: true })
    process.exit(0)
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
    from: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
})

if (args.values.version) {
  console.log(pkg.version)
  process.exit(0)
}

const [command, subcommand, ...rest] = args.positionals
if (args.values.help || (command !== "remote" && command !== "engine")) {
  console.log(HELP)
  process.exit(args.values.help || !command ? 0 : 1)
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
