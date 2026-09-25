/**
 * The loopback token a browser session presents to the harness (WA-1).
 *
 * The browser reaches the server from outside the process, so it cannot be trusted by locality alone.
 * A secret that lives in the user's config directory — the same place `flupcode remote` keeps its
 * devices — is what lets the server tell a browser it started from anything else that can open a
 * socket to `127.0.0.1`.
 */

import { randomBytes, timingSafeEqual } from "node:crypto"
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

/** Reads the token if it is already there, and never creates anything: only the entrypoint writes. */
export function readBrowserToken(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const token = readFileSync(file, "utf8").trim()
    return token === "" ? undefined : token
  } catch {
    return undefined
  }
}

export function readOrCreateBrowserToken(file: string): string {
  const existing = readBrowserToken(file)
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

export function bearerFrom(request: Request): string | undefined {
  const header = request.headers.get("authorization")
  if (!header) return undefined
  return /^Bearer (.+)$/.exec(header)?.[1]
}

export function tokenMatches(expected: string, given: string | undefined): boolean {
  if (given === undefined) return false
  const expectedBytes = Buffer.from(expected)
  const givenBytes = Buffer.from(given)
  if (expectedBytes.length !== givenBytes.length) return false
  return timingSafeEqual(expectedBytes, givenBytes)
}
