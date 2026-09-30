/**
 * The predictive model's API key (ADR-0017, amended 2026-09-30).
 *
 * The key comes from `TYPESAFE_API_KEY` first and otherwise from the encrypted credential vault,
 * where the settings panel saves it bound to the Jev endpoint's origin. It is never part of the
 * config block. Both sources are read on each call, so a key saved or removed a moment ago is the
 * one the next request carries, with no restart. The secret never leaves this module except as the
 * `authorization` header the Jev client builds from `resolve()`.
 */

import type { CredentialVault } from "../vault"

/** The vault name the key is stored under; the origin binding is the Jev endpoint's. */
export const MODEL_KEY_NAME = "typesafe-api-key"

export type ModelKeySource = "env" | "stored" | "none"

/** What the panel may know: where the key comes from and whether one can be saved here. Never the key. */
export type ModelKeyStatus = { source: ModelKeySource; storable: boolean }

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

export type ModelKey = {
  status(): ModelKeyStatus
  /** The key for the next request: the environment's, else the stored one for the current endpoint. */
  resolve(): Promise<string | undefined>
  set(secret: string): ModelKeyStatus
  remove(): ModelKeyStatus
}

export function createModelKey(input: {
  env: NodeJS.ProcessEnv
  vault?: CredentialVault
  /** The live Jev endpoint, so a key stays bound to the host it was saved for. */
  endpoint: () => string
}): ModelKey {
  const fromEnv = () => {
    const value = input.env.TYPESAFE_API_KEY?.trim()
    return value ? value : undefined
  }
  const origin = () => {
    const endpoint = input.endpoint()
    return URL.canParse(endpoint) ? new URL(endpoint).origin : undefined
  }
  // The listing carries names and origins only, so the status never decrypts the secret.
  const stored = () => {
    const bound = origin()
    return (
      bound !== undefined &&
      (input.vault?.list().some((entry) => entry.name === MODEL_KEY_NAME && entry.origin === bound) ?? false)
    )
  }
  const status = (): ModelKeyStatus => ({
    source: fromEnv() ? "env" : stored() ? "stored" : "none",
    storable: input.vault !== undefined,
  })

  return {
    status,
    resolve: async () => {
      const env = fromEnv()
      if (env) return env
      const bound = origin()
      if (!input.vault || bound === undefined) return undefined
      return input.vault.resolve({ name: MODEL_KEY_NAME, origin: bound })
    },
    set: (secret) => {
      if (!input.vault)
        throw new ModelKeyError("There is no vault key, so a model key cannot be stored", "vault-unavailable", 409)
      const bound = origin()
      if (bound === undefined)
        throw new ModelKeyError("The predictive model endpoint is not a valid URL", "invalid-endpoint", 409)
      input.vault.set({ name: MODEL_KEY_NAME, origin: bound, secret })
      return status()
    },
    remove: () => {
      input.vault?.remove(MODEL_KEY_NAME)
      return status()
    },
  }
}
