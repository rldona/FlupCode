/**
 * The loopback secrets a peer presents to the harness (WA-1, FH-04).
 *
 * The browser reaches the server from outside the process, so it cannot be trusted by locality alone.
 * A secret that lives in the user's config directory — the same place `flupcode remote` keeps its
 * devices — is what lets the server tell a browser it started from anything else that can open a
 * socket to `127.0.0.1`. The acting relevance line keeps its own token so a squatted port cannot
 * capture the broader browser/artifacts/actions bearer.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export function flupcodeConfigDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.FLUPCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "flupcode")
}

export function browserTokenFile(dir: string = flupcodeConfigDir()): string {
  return join(dir, "browser-token")
}

/**
 * The acting line's own secret (FH-04, ADR-0022): a sibling of `browser-token` in the same config
 * directory. The harness creates it; the relevance plugin reads it, so a squatted loopback port
 * cannot capture the broader browser/artifacts/actions bearer.
 */
export function adaptiveTokenFile(dir: string = flupcodeConfigDir()): string {
  return join(dir, "adaptive-token")
}

/**
 * The engine plugins' own bearer (TI-10): a sibling of `browser-token`. The actions and agents
 * plugins read it instead of the UI's token, so what the engine's process can reach only lists,
 * approves and runs web actions, reads their evidence and asks the plan's hand-off.
 */
export function pluginTokenFile(dir: string = flupcodeConfigDir()): string {
  return join(dir, "plugin-token")
}

/** The one door every token uses; one implementation, several names. */
function readTokenFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const token = readFileSync(file, "utf8").trim()
    return token === "" ? undefined : token
  } catch {
    return undefined
  }
}

function readOrCreateTokenFile(file: string): string {
  const existing = readTokenFile(file)
  if (existing !== undefined) {
    chmodSync(file, 0o600)
    return existing
  }
  const token = randomBytes(32).toString("hex")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, token, { mode: 0o600 })
  chmodSync(file, 0o600)
  return token
}

/** Reads the token if it is already there, and never creates anything: only the entrypoint writes. */
export function readBrowserToken(file: string): string | undefined {
  return readTokenFile(file)
}

export function readOrCreateBrowserToken(file: string): string {
  return readOrCreateTokenFile(file)
}

/** Reads the plugin token if it is already there, and never creates anything: only the entrypoint writes. */
export function readPluginToken(file: string = pluginTokenFile()): string | undefined {
  return readTokenFile(file)
}

export function readOrCreatePluginToken(file: string = pluginTokenFile()): string {
  return readOrCreateTokenFile(file)
}

/** Reads the acting token if it is already there, and never creates anything: only the harness writes. */
export function readAdaptiveToken(file: string = adaptiveTokenFile()): string | undefined {
  return readTokenFile(file)
}

export function readOrCreateAdaptiveToken(file: string = adaptiveTokenFile()): string {
  return readOrCreateTokenFile(file)
}

/**
 * Whether a configured host keeps the server on the machine. Only then is the acting token resolved
 * and the relevance route built; anything else leaves the feature inert rather than exposed.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

export function isLoopbackHostname(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(host.trim().toLowerCase())
}

export function bearerFrom(request: Request): string | undefined {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  return /^Bearer (.+)$/.exec(header)?.[1]
}

/**
 * A fixed-size digest of a token, so two tokens of any length are compared as equal-size buffers:
 * the earlier length check returned before `timingSafeEqual` and leaked the expected length.
 */
const tokenDigest = (token: string): Buffer => createHash("sha256").update(token).digest()

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false
  return timingSafeEqual(tokenDigest(expected), tokenDigest(given))
}
