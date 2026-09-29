/**
 * The key the shadow derives opaque ids with (FH-017).
 *
 * An opaque id has to be stable for one value and must not be invertible: a keyless digest of a path
 * or a command is a dictionary oracle, so the id is an HMAC under a key this install owns and never
 * exposes. The vault's key is reused when it exists — it is already the install's secret at rest —
 * and otherwise a local key file is created with `0600` permissions beside the browser token.
 */

import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { flupcodeConfigDir } from "../browser-token"
import { parseVaultKey, readVaultKeyFile, vaultKeyFile } from "../vault"

const KEY_BYTES = 32

/** The fallback key file, in the harness config directory next to the browser token and the vault key. */
export function installationKeyFile(dir: string = flupcodeConfigDir()): string {
  return join(dir, "adaptive-key")
}

/** Reads the key if it is already there, and never creates anything. */
export function readInstallationKeyFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const key = readFileSync(file, "utf8").trim()
    return key === "" ? undefined : key
  } catch {
    return undefined
  }
}

export function readOrCreateInstallationKeyFile(file: string = installationKeyFile()): string {
  const existing = readInstallationKeyFile(file)
  if (existing !== undefined && parseVaultKey(existing) !== undefined) {
    chmodSync(file, 0o600)
    return existing
  }
  // Regenerating would change every id derived under the old key, so the unreadable bytes are kept
  // and the loss is said out loud rather than silently replaced.
  if (existing !== undefined) {
    const backup = `${file}.bak`
    renameSync(file, backup)
    console.warn(`The adaptive key file was not readable; it was moved to ${backup} and a new one was generated.`)
  }
  const key = randomBytes(KEY_BYTES).toString("hex")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, key, { mode: 0o600 })
  chmodSync(file, 0o600)
  return key
}

/** The install's key: the vault's when it exists, a local restricted file otherwise. */
export function resolveInstallationKey(): Buffer {
  const vault = parseVaultKey(readVaultKeyFile(vaultKeyFile()))
  if (vault) return vault
  return parseVaultKey(readOrCreateInstallationKeyFile())!
}
