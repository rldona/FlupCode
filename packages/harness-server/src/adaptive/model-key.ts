/**
 * The predictive models' API keys (ADR-0017, amended 2026-09-30; per provider since PI-01).
 *
 * A provider that needs a key names its slot: the key reference (`providers.<id>.keyRef`, or the
 * provider's own default) and its live endpoint. The key comes from `FLUPCODE_<REF>` first (the
 * reference in upper case, `-` as `_`), then from the variable the reference used to be read from
 * (`legacy.ts`), and otherwise from the encrypted credential vault, where the settings panel saves it
 * under the reference, bound to the endpoint's origin. It is never part of the config block. Every
 * source is read on each call, so a key saved or removed a moment ago is the one the next request
 * carries, with no restart. The secret never leaves this module except through `resolve()`.
 */

import type { CredentialVault } from "../vault"
import { legacyKeyEnv } from "./legacy"

/** Where one provider's key lives: its reference and the endpoint a stored key is bound to. */
export type KeySlot = { ref: string; endpoint: string }

export type ModelKeySource = "env" | "stored" | "none"

/**
 * What the panel may know: where the key comes from, whether one can be saved here, and the variable
 * that sets it from the environment. Never the key.
 */
export type ModelKeyStatus = { source: ModelKeySource; storable: boolean; env: string }

export class ModelKeyError extends Error {
  constructor(
    message: string,
    readonly code: "vault-unavailable" | "invalid-endpoint",
    readonly status: number,
  ) {
    super(message)
    this.name = "ModelKeyError"
  }
}

export type ModelKeys = {
  status(slot: KeySlot): ModelKeyStatus
  /** The key for the next request: the environment's, else the stored one for the slot's endpoint. */
  resolve(slot: KeySlot): Promise<string | undefined>
  set(slot: KeySlot, secret: string): ModelKeyStatus
  remove(slot: KeySlot): ModelKeyStatus
  /** The environment's key for a slot, for the redaction secrets. */
  fromEnv(slot: KeySlot): string | undefined
}

/** The environment variable a key reference is read from: `FLUPCODE_` and the reference in upper snake case. */
export const keyEnvName = (ref: string): string => `FLUPCODE_${ref.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

export function createModelKeys(input: { env: NodeJS.ProcessEnv; vault?: CredentialVault }): ModelKeys {
  const fromEnv = (slot: KeySlot) => {
    const legacy = legacyKeyEnv(slot.ref)
    const value = input.env[keyEnvName(slot.ref)]?.trim() || (legacy ? input.env[legacy]?.trim() : undefined)
    return value ? value : undefined
  }
  const origin = (slot: KeySlot) => (URL.canParse(slot.endpoint) ? new URL(slot.endpoint).origin : undefined)
  // The listing carries names and origins only, so the status never decrypts the secret.
  const stored = (slot: KeySlot) => {
    const bound = origin(slot)
    return (
      bound !== undefined &&
      (input.vault?.list().some((entry) => entry.name === slot.ref && entry.origin === bound) ?? false)
    )
  }
  const status = (slot: KeySlot): ModelKeyStatus => ({
    source: fromEnv(slot) ? "env" : stored(slot) ? "stored" : "none",
    storable: input.vault !== undefined,
    env: keyEnvName(slot.ref),
  })

  return {
    status,
    fromEnv,
    resolve: async (slot) => {
      const env = fromEnv(slot)
      if (env) return env
      const bound = origin(slot)
      if (!input.vault || bound === undefined) return undefined
      return input.vault.resolve({ name: slot.ref, origin: bound })
    },
    set: (slot, secret) => {
      if (!input.vault)
        throw new ModelKeyError("There is no vault key, so a model key cannot be stored", "vault-unavailable", 409)
      const bound = origin(slot)
      if (bound === undefined)
        throw new ModelKeyError("The predictive model endpoint is not a valid URL", "invalid-endpoint", 409)
      input.vault.set({ name: slot.ref, origin: bound, secret })
      return status(slot)
    },
    remove: (slot) => {
      input.vault?.remove(slot.ref)
      return status(slot)
    },
  }
}
