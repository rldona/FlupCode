import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A pinned OpenCode 2.x binary for the V2 sandbox (V2-05), kept where FlupCode owns it.
 *
 * OpenCode 2.x installs the same `opencode` command as 1.x, and its installer replaces the 1.x one,
 * so it is never installed globally here: the platform package is fetched from the npm registry,
 * checked against the integrity the registry publishes for it, and unpacked under FlupCode's cache.
 * The binary is not run by this module; the contract suite and `script/opencode-v2.ts` do that with
 * an isolated home, so it never opens the user's `opencode.db`.
 */
export const OPENCODE_V2_VERSION = "2.0.20"

const REGISTRY = "https://registry.npmjs.org"

export function openCodeV2Path(version = OPENCODE_V2_VERSION) {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  return join(
    base,
    "flupcode",
    "engines",
    `opencode-${version}`,
    process.platform === "win32" ? "opencode.exe" : "opencode",
  )
}

/** Installs the binary when it is missing, and returns its path. */
export async function installOpenCodeV2(version = OPENCODE_V2_VERSION) {
  const target = openCodeV2Path(version)
  if (existsSync(target)) return target
  const name = `@opencode/cli-${platformPackage()}`
  const manifest = await fetchJson(`${REGISTRY}/${name.replace("/", "%2f")}/${version}`)
  const dist = manifest.dist as { tarball?: string; integrity?: string } | undefined
  if (!dist?.tarball?.startsWith(`${REGISTRY}/`) || !dist.integrity?.startsWith("sha512-"))
    throw new Error(`${name}@${version} has no sha512 tarball on the registry`)
  const tarball = new Uint8Array(await (await fetchOk(dist.tarball)).arrayBuffer())
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`
  if (integrity !== dist.integrity) throw new Error(`${name}@${version} does not match its published integrity`)

  // Unpacked beside the target and moved into place, so an interrupted install leaves no half binary.
  const work = mkdtempSync(join(tmpdir(), "flupcode-opencode-"))
  try {
    await Bun.write(join(work, "package.tgz"), tarball)
    const tar = Bun.spawnSync(["tar", "-xzf", join(work, "package.tgz"), "-C", work])
    if (tar.exitCode !== 0) throw new Error(`Could not unpack ${name}@${version}: ${tar.stderr.toString()}`)
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
