/**
 * The web servers running on this machine, for the preview's empty state (BU-06).
 *
 * Read from the operating system's own list of listening sockets (`lsof` on macOS and Linux,
 * `/proc/net/tcp` where there is no `lsof`, `netstat` on Windows), never by scanning: only sockets a
 * page on this machine can reach through loopback are kept, and each one is asked for `/` once on
 * `127.0.0.1` to tell a web server from a database. Nothing leaves the machine.
 *
 * The parsing is pure and the commands are passed in, so this is tested without the processes.
 */

export type DevServer = {
  port: number
  url: string
  pid?: number
  /** The program that listens, as the system names it (`node`, `bun`, `python3`). */
  process?: string
  /** The folder it was started in, where the system says. */
  cwd?: string
  /** The page's `<title>`, when it answered with one. */
  title?: string
  /** Started inside the folder the panel was opened for. */
  inProject: boolean
}

export type Listener = { port: number; address: string; pid?: number; process?: string }

type Run = (command: string, args: string[]) => Promise<string | undefined>
type Probe = (port: number) => Promise<{ title?: string } | undefined>
type ReadText = (path: string) => Promise<string | undefined>

export async function listDevServers(input: {
  platform: NodeJS.Platform
  run: Run
  probe: Probe
  readText?: ReadText
  /** Ports that are FlupCode's own (its engine, its harness, its renderer in development). */
  exclude?: ReadonlySet<number>
  /** The project folder: servers started inside it come first. */
  directory?: string
}): Promise<DevServer[]> {
  const listeners = await readListeners(input)
  const byPort = new Map<number, Listener>()
  listeners
    .filter((entry) => reachableOnLoopback(entry.address) && !input.exclude?.has(entry.port))
    .forEach((entry) => byPort.set(entry.port, { ...byPort.get(entry.port), ...entry }))
  const cwds = await cwdsOf(input, [...byPort.values()].flatMap((entry) => (entry.pid ? [entry.pid] : [])))
  const answered = await Promise.all(
    [...byPort.values()].map(async (entry) => ({ entry, page: await input.probe(entry.port).catch(() => undefined) })),
  )
  const directory = input.directory?.replace(/[\\/]+$/, "")
  return answered
    .filter((item) => item.page !== undefined)
    .map(({ entry, page }) => {
      const cwd = entry.pid ? cwds.get(entry.pid) : undefined
      return {
        port: entry.port,
        url: `http://localhost:${entry.port}/`,
        ...(entry.pid ? { pid: entry.pid } : {}),
        ...(entry.process ? { process: entry.process } : {}),
        ...(cwd ? { cwd } : {}),
        ...(page?.title ? { title: page.title } : {}),
        inProject: !!directory && !!cwd && (cwd === directory || cwd.startsWith(`${directory}/`) || cwd.startsWith(`${directory}\\`)),
      }
    })
    .sort((left, right) => Number(right.inProject) - Number(left.inProject) || left.port - right.port)
}

async function readListeners(input: { platform: NodeJS.Platform; run: Run; readText?: ReadText }) {
  if (input.platform === "win32") return parseNetstat((await input.run("netstat", ["-ano"])) ?? "")
  const lsof = await input.run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])
  if (lsof !== undefined) return parseLsof(lsof)
  if (input.platform !== "linux" || !input.readText) return []
  const [v4, v6] = await Promise.all([input.readText("/proc/net/tcp"), input.readText("/proc/net/tcp6")])
  return [...parseProcNetTcp(v4 ?? ""), ...parseProcNetTcp(v6 ?? "")]
}

/** Where each process was started, from `lsof`; Windows has no such list and says nothing. */
async function cwdsOf(input: { platform: NodeJS.Platform; run: Run }, pids: number[]) {
  if (input.platform === "win32" || pids.length === 0) return new Map<number, string>()
  const text = await input.run("lsof", ["-a", "-d", "cwd", "-p", [...new Set(pids)].join(","), "-Fpn"])
  return parseLsofCwd(text ?? "")
}

/** `lsof -F pcn`: a `p` line opens a process, `c` names it, each `n` is one listening address. */
export function parseLsof(text: string): Listener[] {
  const state = { pid: undefined as number | undefined, process: undefined as string | undefined }
  return text.split("\n").flatMap((line) => {
    const field = line[0]
    const value = line.slice(1).trim()
    if (field === "p") {
      state.pid = Number(value)
      state.process = undefined
      return []
    }
    if (field === "c") {
      state.process = value
      return []
    }
    if (field !== "n") return []
    const split = splitAddress(value)
    if (!split) return []
    return [{ ...split, ...(state.pid ? { pid: state.pid } : {}), ...(state.process ? { process: state.process } : {}) }]
  })
}

export function parseLsofCwd(text: string) {
  const pid = { value: undefined as number | undefined }
  return new Map(
    text.split("\n").flatMap((line) => {
      if (line.startsWith("p")) pid.value = Number(line.slice(1))
      if (!line.startsWith("n") || pid.value === undefined) return []
      return [[pid.value, line.slice(1).trim()] as const]
    }),
  )
}

/** `netstat -ano`: `TCP  127.0.0.1:5173  0.0.0.0:0  LISTENING  1234`, IPv6 inside brackets. */
export function parseNetstat(text: string): Listener[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const parts = line.trim().split(/\s+/)
    if (parts[0] !== "TCP" || parts[3] !== "LISTENING") return []
    const split = splitAddress(parts[1] ?? "")
    const pid = Number(parts[4])
    return split ? [{ ...split, ...(pid > 0 ? { pid } : {}) }] : []
  })
}

/** `/proc/net/tcp` and `tcp6`: hex `address:port` in the second column, state `0A` is listening. */
export function parseProcNetTcp(text: string): Listener[] {
  return text
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const parts = line.trim().split(/\s+/)
      if (parts[3] !== "0A") return []
      const [hex = "", portHex = ""] = (parts[1] ?? "").split(":")
      const port = parseInt(portHex, 16)
      if (!Number.isInteger(port) || port <= 0) return []
      return [{ port, address: procAddress(hex) }]
    })
}

/** The kernel writes each 32-bit word in host (little-endian) order. */
function procAddress(hex: string) {
  const words = hex.match(/.{8}/g) ?? []
  const bytes = words.flatMap((word) => (word.match(/../g) ?? []).reverse().map((byte) => parseInt(byte, 16)))
  if (bytes.length === 4) return bytes.join(".")
  if (bytes.every((byte) => byte === 0)) return "::"
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return "::1"
  // An IPv4 address mapped into IPv6 (`::ffff:127.0.0.1`) is that IPv4 address.
  if (bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 255 && bytes[11] === 255)
    return bytes.slice(12).join(".")
  return "ipv6"
}

function splitAddress(value: string) {
  const at = value.lastIndexOf(":")
  if (at <= 0) return undefined
  const port = Number(value.slice(at + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  return { port, address: value.slice(0, at).replace(/^\[|\]$/g, "") }
}

/** A socket a page on this machine reaches through loopback: bound to loopback, or to every address. */
export function reachableOnLoopback(address: string) {
  const host = address.toLowerCase()
  return (
    host === "*" ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host === "localhost" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "::ffff:127.0.0.1" ||
    host === "::ffff:0.0.0.0"
  )
}

/** The page's title, from the first bytes of an HTML answer. */
export function titleOf(html: string) {
  const match = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)
  return match?.[1]?.replace(/\s+/g, " ").trim() || undefined
}
