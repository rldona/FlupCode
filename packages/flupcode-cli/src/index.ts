#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { createRemoteHost, PAIRING_TTL, type RemoteHostState, type RemoteHostStore } from "@flupcode/remote"
import QRCode from "qrcode"
import pkg from "../package.json"

/** `flupcode remote`: host remote control from a terminal, like `claude remote-control` (F8-11). */

const HELP = `FlupCode ${pkg.version}

Usage:
  flupcode remote [options]        Let a phone control this computer's OpenCode sessions
  flupcode remote devices          List paired devices
  flupcode remote revoke <device>  Remove a paired device (number from "devices", id or name)

Options:
  --engine <url>   OpenCode server to expose (default: http://127.0.0.1:4096)
  --relay <url>    Relay (default: wss://relay.flupcode.com)
  --app <url>      Web app that opens pairing links (default: https://app.flupcode.com/)
  --no-serve       Do not start "opencode serve" when the engine is not running
  -h, --help       Show this help
  -v, --version    Show the version

While running, type: p (new pairing code), d (devices), r <n> (remove device), q (quit).

Environment: OPENCODE_SERVER_PASSWORD / OPENCODE_SERVER_USERNAME for a password-protected engine,
FLUPCODE_CONFIG_DIR to change where the host identity and devices are stored.`

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

async function engineHealthy(engine: string, credentials: string | undefined) {
  return fetch(new URL("/global/health", engine), {
    headers: credentials ? { authorization: `Basic ${credentials}` } : {},
    signal: AbortSignal.timeout(1500),
  })
    .then((response) => response.ok)
    .catch(() => false)
}

async function ensureEngine(engine: string, credentials: string | undefined, serve: boolean) {
  if (await engineHealthy(engine, credentials)) return undefined
  const hint = `start it with "opencode serve --port ${new URL(engine).port || 4096}" or pass --engine`
  if (!serve) fail(`no OpenCode server at ${engine}; ${hint}`)
  if (spawnSync("opencode", ["--version"], { stdio: "ignore", shell: process.platform === "win32" }).error)
    fail(`no OpenCode server at ${engine} and the opencode CLI is not installed; ${hint}`)
  console.log(dim(`Starting opencode serve on ${engine}…`))
  const url = new URL(engine)
  const child = spawn("opencode", ["serve", "--hostname", url.hostname, "--port", url.port || "4096"], {
    stdio: "ignore",
    shell: process.platform === "win32",
  })
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await engineHealthy(engine, credentials)) return child
    await Bun.sleep(500)
  }
  child.kill()
  fail(`opencode serve did not become ready at ${engine}`)
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
  const credentials = engineCredentials()
  const engineProcess: ChildProcess | undefined = await ensureEngine(options.engine, credentials, options.serve)

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
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
})

if (args.values.version) {
  console.log(pkg.version)
  process.exit(0)
}

const [command, subcommand, ...rest] = args.positionals
if (args.values.help || command !== "remote") {
  console.log(HELP)
  process.exit(args.values.help || !command ? 0 : 1)
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
