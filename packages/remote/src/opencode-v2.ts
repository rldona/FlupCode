import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The OpenCode 2 engine FlupCode launches (V2-60): one pinned binary, kept where FlupCode owns it,
 * and the environment every 2.x engine FlupCode starts runs with.
 *
 * OpenCode 2 installs the same `opencode` command as 1.x and its installer replaces the 1.x one, so
 * the binary is never installed globally: the platform package is fetched from the npm registry,
 * checked against the integrity the registry publishes for it, and unpacked under FlupCode's cache.
 * Node and Bun both run this module: the desktop's main process is Electron.
 */
export const OPENCODE_V2_VERSION = "2.0.18"

const REGISTRY = "https://registry.npmjs.org"

export function openCodeV2Path(version = OPENCODE_V2_VERSION, env: NodeJS.ProcessEnv = process.env) {
  const base = env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(
    base,
    "flupcode",
    "engines",
    `opencode-${version}`,
    process.platform === "win32" ? "opencode.exe" : "opencode",
  )
}

/**
 * Installs the binary when it is missing, and returns its path. `minimumReleaseAge` (seconds) refuses a
 * version published too recently, as bun's install does for the repo's packages; the launchers only
 * ever fetch the version pinned here, which met that rule when it was pinned.
 */
export async function installOpenCodeV2(
  input: { version?: string; minimumReleaseAge?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const version = input.version ?? OPENCODE_V2_VERSION
  const target = openCodeV2Path(version, input.env)
  if (existsSync(target)) return target
  const name = `@opencode/cli-${platformPackage()}`
  const packument = await fetchJson(`${REGISTRY}/${name.replace("/", "%2f")}`)
  const published = Date.parse(String((packument.time as Record<string, string> | undefined)?.[version]))
  const age = Math.floor((Date.now() - published) / 1000)
  if (!Number.isFinite(published) || age < (input.minimumReleaseAge ?? 0))
    throw new Error(`${name}@${version} is younger than the minimum release age; pin an older version`)
  const manifest = (packument.versions as Record<string, Record<string, unknown>> | undefined)?.[version]
  const dist = manifest?.dist as { tarball?: string; integrity?: string } | undefined
  if (!dist?.tarball?.startsWith(`${REGISTRY}/`) || !dist.integrity?.startsWith("sha512-"))
    throw new Error(`${name}@${version} has no sha512 tarball on the registry`)
  const tarball = new Uint8Array(await (await fetchOk(dist.tarball)).arrayBuffer())
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`
  if (integrity !== dist.integrity) throw new Error(`${name}@${version} does not match its published integrity`)

  // Unpacked beside the target and moved into place, so an interrupted install leaves no half binary.
  const work = mkdtempSync(join(tmpdir(), "flupcode-opencode-"))
  try {
    writeFileSync(join(work, "package.tgz"), tarball)
    const tar = spawnSync("tar", ["-xzf", join(work, "package.tgz"), "-C", work], { encoding: "utf8" })
    if (tar.status !== 0) throw new Error(`Could not unpack ${name}@${version}: ${tar.stderr}`)
    const binary = join(work, "package", "bin", process.platform === "win32" ? "opencode.exe" : "opencode")
    if (!existsSync(binary)) throw new Error(`${name}@${version} ships no bin/opencode`)
    chmodSync(binary, 0o755)
    mkdirSync(join(target, ".."), { recursive: true })
    renameSync(binary, target)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  return target
}

/**
 * The 2.x binary to start: `FLUPCODE_OPENCODE` when the reader names one, otherwise the pinned binary,
 * fetched on first use. Never `opencode` from the PATH: that name is 1.x or 2.x depending on which
 * installer ran last.
 */
export async function resolveOpenCodeV2(env: NodeJS.ProcessEnv = process.env) {
  const named = env.FLUPCODE_OPENCODE?.trim()
  if (named) return named
  return installOpenCodeV2({ env })
}

/**
 * The database a 2.x engine FlupCode starts uses: FlupCode's own, never 1.x's `opencode.db`. 2.x
 * migrates the database it opens one way (it drops tables 1.x's dev-era core uses and empties the
 * event log), so the reader's 1.x history only reaches 2.x through an explicit import of a copy
 * (`v1-import.ts`, V2-61).
 */
export function openCodeV2Database(env: NodeJS.ProcessEnv = process.env) {
  const base = env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "flupcode", "opencode-v2", "opencode.db")
}

/**
 * The environment a 2.x engine FlupCode starts runs with: always a password, the user name 2.x
 * expects (it has no `OPENCODE_SERVER_USERNAME`), and the isolated database unless the reader set
 * `OPENCODE_DB` on purpose.
 */
export function openCodeV2Env(input: { password: string; env?: NodeJS.ProcessEnv }) {
  const env = input.env ?? process.env
  const database = env.OPENCODE_DB || openCodeV2Database(env)
  mkdirSync(join(database, ".."), { recursive: true })
  const { OPENCODE_SERVER_USERNAME: _username, ...rest } = env
  return { ...rest, OPENCODE_SERVER_PASSWORD: input.password, OPENCODE_DB: database }
}

/** The suffix of the platform package npm would pick for this machine. */
function platformPackage() {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string]
  const cpu = { arm64: "arm64", x64: "x64" }[process.arch as string]
  if (!os || !cpu) throw new Error(`OpenCode 2 ships no binary for ${process.platform}-${process.arch}`)
  // musl Linux (Alpine) has its own build; glibc is the default everywhere else.
  const musl = os === "linux" && existsSync("/etc/alpine-release") ? "-musl" : ""
  return `${os}-${cpu}${musl}`
}

async function fetchOk(url: string) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
  return response
}

async function fetchJson(url: string) {
  return (await (await fetchOk(url)).json()) as Record<string, unknown>
}
