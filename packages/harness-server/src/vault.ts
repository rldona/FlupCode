/**
 * Where a web action's credential is kept, encrypted at rest (WA-5).
 *
 * A credential is bound to the origin whose recipe uses it: the association is part of what is
 * encrypted, so a row moved to another origin no longer decrypts. The key lives in the user's config
 * directory next to the browser token, and the server only ever writes `0600` bytes.
 *
 * Reading never throws: a missing, foreign or tampered credential resolves to `undefined`, which is
 * how the runner fails closed instead of typing an empty field into somebody's sign-in form.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { flupcodeConfigDir } from "./browser-token"
import type { SqliteRoutineRepository } from "./repository"

/** The shape a credential name has to have, so it can be named in a profile and a URL path. */
export const CREDENTIAL_NAME = /^[A-Za-z0-9_-]{1,64}$/

const KEY_BYTES = 32
const IV_BYTES = 12
const HEX_KEY = /^[0-9a-f]{64}$/i

export type CredentialMetadata = { name: string; origin: string; updatedAt: number }

export type CredentialVault = {
  list(): CredentialMetadata[]
  /** Writes or replaces a credential. The secret is returned nowhere: the metadata is all a caller keeps. */
  set(input: { name: string; origin: string; secret: string }): CredentialMetadata
  remove(name: string): boolean
  /** The secret for this name and origin, or nothing when it is absent, foreign or unreadable. */
  resolve(input: { name: string; origin: string }): Promise<string | undefined>
}

export type CredentialStore = Pick<
  SqliteRoutineRepository,
  "upsertActionCredential" | "listActionCredentials" | "getActionCredential" | "removeActionCredential"
>

/** The vault key file, beside the browser token in the config directory. */
export function vaultKeyFile(dir: string = flupcodeConfigDir()): string {
  return join(dir, "vault-key")
}

/** Reads the key if it is already there, and never creates anything: only the entrypoint writes. */
export function readVaultKeyFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined
  try {
    const key = readFileSync(file, "utf8").trim()
    return key === "" ? undefined : key
  } catch {
    return undefined
  }
}

export function readOrCreateVaultKeyFile(file: string): string {
  const existing = readVaultKeyFile(file)
  // A file that is there but does not parse is not a key: handing it back would only fail later.
  if (existing !== undefined && parseVaultKey(existing) !== undefined) {
    chmodSync(file, 0o600)
    return existing
  }
  // Regenerating would make every credential stored under the old key undecryptable, so the bytes
  // that were there are kept beside the new file and the loss is said out loud.
  if (existing !== undefined) {
    const backup = `${file}.bak`
    renameSync(file, backup)
    console.warn(
      `The vault key file was not readable; it was moved to ${backup} and a new key was generated; existing credentials will not decrypt.`,
    )
  }
  const key = randomBytes(KEY_BYTES).toString("hex")
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, key, { mode: 0o600 })
  chmodSync(file, 0o600)
  return key
}

/**
 * A 32-byte key, from a 64-character hex string or from base64 that decodes to exactly 32 bytes.
 *
 * Base64 is re-encoded and compared so a string that merely happens to decode to 32 bytes — with
 * stray characters node would silently skip — is refused rather than used as a weak key.
 */
export function parseVaultKey(value: string | undefined): Buffer | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === "") return undefined
  if (HEX_KEY.test(trimmed)) return Buffer.from(trimmed, "hex")
  const decoded = Buffer.from(trimmed, "base64")
  if (decoded.byteLength !== KEY_BYTES) return undefined
  if (decoded.toString("base64").replace(/=+$/, "") !== trimmed.replace(/=+$/, "")) return undefined
  return decoded
}

export function createVault(options: { store: CredentialStore; key: Buffer }): CredentialVault {
  const { store, key } = options

  const list = (): CredentialMetadata[] =>
    store.listActionCredentials().map((row) => ({ name: row.name, origin: row.origin, updatedAt: row.updatedAt }))

  const set = (input: { name: string; origin: string; secret: string }): CredentialMetadata => {
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(aad(input.name, input.origin))
    const ciphertext = Buffer.concat([cipher.update(input.secret, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    const now = Date.now()
    store.upsertActionCredential(
      {
        name: input.name,
        origin: input.origin,
        iv: iv.toString("base64"),
        tag: tag.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
      now,
    )
    return { name: input.name, origin: input.origin, updatedAt: now }
  }

  // `resolve` promises to never throw, so a store that fails is a miss like any other, not a
  // rejection the runner would have to catch.
  const readRecord = (name: string) => {
    try {
      return store.getActionCredential(name)
    } catch {
      return undefined
    }
  }

  const resolve = async (input: { name: string; origin: string }): Promise<string | undefined> => {
    const record = readRecord(input.name)
    if (record === undefined) return undefined
    // The origin is checked before decrypting: a credential named for another site is not this one's,
    // and trying the ciphertext there would only invite a confusing failure.
    if (record.origin !== input.origin) return undefined
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"))
      decipher.setAAD(aad(record.name, input.origin))
      decipher.setAuthTag(Buffer.from(record.tag, "base64"))
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(record.ciphertext, "base64")),
        decipher.final(),
      ])
      return plaintext.toString("utf8")
    } catch {
      // A wrong key or an edited row is a miss, not an error the caller has to handle.
      return undefined
    }
  }

  return { list, set, remove: (name) => store.removeActionCredential(name), resolve }
}

/** What authentication covers: the name and the origin together, so neither can be swapped alone. */
const aad = (name: string, origin: string): Buffer => Buffer.from(`${name}\n${origin}`)