import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * The persisted loopback token the desktop shares with the harness and the engine.
 *
 * Same file the standalone harness and a hand-started engine already read
 * (`packages/harness-server/src/browser-token.ts`): reusing it — instead of a fresh random token
 * per launch — keeps web-actions paired across desktop restarts. Never throws: a filesystem the
 * app cannot use resolves to nothing and the caller falls back to an ephemeral token.
 */

export function tokenFileDir(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return env.FLUPCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "flupcode")
}

export function tokenFilePath(dir: string = tokenFileDir()): string {
  return join(dir, "browser-token")
}

/** What this file ever holds: 32 random bytes as hex. Anything else is foreign or truncated. */
const TOKEN_FORMAT = /^[0-9a-f]{64}$/

/** The stored token, or nothing when the file is absent, empty or unreadable. */
export function readFileToken(file: string = tokenFilePath()): string | undefined {
  try {
    if (!existsSync(file)) return undefined
    const token = readFileSync(file, "utf8").trim()
    return token === "" ? undefined : token
  } catch {
    return undefined
  }
}

/** The stored token, creating and persisting one (`0600`) on first use. */
export function readOrCreateFileToken(file: string = tokenFilePath()): string | undefined {
  try {
    const existing = readFileToken(file)
    // A foreign or truncated value would silently disable every consumer that sends it as a
    // bearer, so only a well-formed token is reused; anything else starts over below.
    if (existing !== undefined && TOKEN_FORMAT.test(existing)) {
      chmodSync(file, 0o600)
      return existing
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    try {
      // mkdir does not tighten a directory that already existed with wider modes.
      chmodSync(dirname(file), 0o700)
    } catch {
      // A directory the app cannot chmod still holds a `0600` file, which is the real protection.
    }
    const token = randomBytes(32).toString("hex")
    try {
      writeFileSync(file, token, { mode: 0o600, flag: "wx" })
    } catch (cause) {
      // Lost the creation race: whoever won left a token behind, so use it when well-formed.
      // A malformed leftover helps nobody, so it is replaced instead of kept.
      const raced = cause instanceof Error && "code" in cause ? cause.code : undefined
      if (raced !== "EEXIST") throw cause
      const winner = readFileToken(file)
      if (winner !== undefined && TOKEN_FORMAT.test(winner)) return winner
      writeFileSync(file, token, { mode: 0o600 })
    }
    chmodSync(file, 0o600)
    return token
  } catch {
    return undefined
  }
}
