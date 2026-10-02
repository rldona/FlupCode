import type { AdaptiveConfigView, AdaptiveModel, AdaptiveModelKeyStatus } from "./types"

/**
 * The adaptive settings view of a harness server older than PI-01, read in the provider-neutral shape.
 *
 * Such a server named its one keyed provider in the view — `env.typesafeKeyPresent`,
 * `env.typesafeKeySource`, `modelKeyStorable` and `effective.jev.enabled` — served its registry as
 * `models`, and offered the old single switch as the writable leaf `jev.enabled`. This module is the
 * only place the app reads those names: the panel sees `providers`, a key per provider and
 * `legacySwitch` from either server.
 */

/** The provider the old single switch speaks for, and whose consent it needs. */
export const LEGACY_PROVIDER = "jev"

/** The old single switch's leaf, which only a server older than PI-01 lists as writable. */
export const LEGACY_SWITCH = "jev.enabled"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The registered providers, or undefined from a server too old to serve its registry. */
export function viewProviders(view: AdaptiveConfigView): AdaptiveModel[] | undefined {
  if (view.providers) return view.providers
  const raw: Record<string, unknown> = { ...view }
  if (!Array.isArray(raw.models)) return undefined
  const key = legacyKey(view)
  return raw.models
    .filter(isRecord)
    .map((model) => ({ ...(model as AdaptiveModel), ...(model.needsKey === true ? { key } : {}) }))
}

/**
 * The one key an older server knew about, for the provider that needs it. An older server that does
 * not say the source is read from the presence flag alone.
 */
export function legacyKey(view: AdaptiveConfigView): AdaptiveModelKeyStatus {
  const raw: Record<string, unknown> = { ...view }
  const env = isRecord(raw.env) ? raw.env : {}
  const source =
    env.typesafeKeySource === "env" || env.typesafeKeySource === "stored" || env.typesafeKeySource === "none"
      ? env.typesafeKeySource
      : env.typesafeKeyPresent === true
        ? "env"
        : "none"
  return { source, storable: raw.modelKeyStorable === true, env: "TYPESAFE_API_KEY" }
}

/** Whether the old single switch still assigns every decision the config does not name. */
export function legacySwitchOn(view: AdaptiveConfigView): boolean {
  if (view.legacySwitch !== undefined) return view.legacySwitch
  const effective: Record<string, unknown> = { ...view.effective }
  return isRecord(effective.jev) && effective.jev.enabled === true
}
