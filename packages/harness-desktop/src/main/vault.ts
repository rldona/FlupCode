import { randomBytes } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { app, safeStorage } from "electron"

/**
 * The vault key the desktop hands to the harness server (WA-5).
 *
 * Windows and Linux keep it encrypted with the OS keychain (`safeStorage`), beside `remote.json`.
 * macOS does not: an ad-hoc signed build (F5-4) gets a new code signature on every release, so the
 * keychain would ask for the login password on each update. There the harness owns its `vault-key`
 * file instead, owner-only, and this returns nothing.
 */

type Envelope = { v: 1; encrypted: boolean; data: string }

// `basic_text` is Linux's obfuscation-only backend: it is not a keychain, so a "key" stored with it
// offers no protection and the harness's own `0600` file is the better home.
const usesKeychain = () =>
  process.platform !== "darwin" &&
  safeStorage.isEncryptionAvailable() &&
  safeStorage.getSelectedStorageBackend?.() !== "basic_text"

function keyFile() {
  return join(app.getPath("userData"), "vault-key.json")
}

/** The stored key, or nothing when the file is absent or cannot be opened. */
function readKey(): string | undefined {
  if (!existsSync(keyFile())) return undefined
  const envelope = JSON.parse(readFileSync(keyFile(), "utf8")) as Envelope
  if (!envelope.encrypted) return Buffer.from(envelope.data, "base64").toString("utf8")
  return safeStorage.decryptString(Buffer.from(envelope.data, "base64"))
}

function writeKey(key: string) {
  const encrypted = usesKeychain()
  const envelope: Envelope = {
    v: 1,
    encrypted,
    data: encrypted ? safeStorage.encryptString(key).toString("base64") : Buffer.from(key).toString("base64"),
  }
  writeFileSync(keyFile(), JSON.stringify(envelope), { mode: 0o600 })
}

/**
 * The hex key both processes open the vault with, or nothing when the keychain cannot hold one.
 *
 * A new key is created on first use; later launches decrypt the same one. Nothing here throws: a
 * machine where `safeStorage` fails gets `undefined` and the harness falls back to its own file.
 */
export function vaultKeyForHarness(): string | undefined {
  if (!usesKeychain()) return undefined
  try {
    const existing = readKey()
    if (existing) return existing
    const key = randomBytes(32).toString("hex")
    writeKey(key)
    return key
  } catch {
    return undefined
  }
}
