/**
 * The adaptive names written before the layer stopped naming a provider (PI-01).
 *
 * Until then the one remote model, Jev, had its own config block (`jev.enabled`, `jev.endpoint`,
 * `jev.model`, `jev.timeoutMs`, `jev.maxInputTokens`), its own policy switch (`allowJev`, in the
 * `decisions.<kind>` block and in every audit row's `policy_json`), its key in `TYPESAFE_API_KEY`,
 * and the audit vocabulary `source = 'jev'`. This module is the only place those names are read:
 * each is read, never written, as what it means in the provider-neutral shape, so an old file, an old
 * environment and an old row behave as they did. Nothing here is written back.
 *
 * The config keys and the environment variable are aliases for one release; the audit vocabulary
 * stays, since old rows keep it.
 */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** The provider every legacy name speaks for: the only remote model before the registry existed. */
export const LEGACY_PROVIDER = "jev"

/** The audit's v1 `source` for an answer the legacy provider gave (AH-C02). */
export const LEGACY_SOURCE = "jev"

/**
 * The old single switch, `jev.enabled`. It assigned the legacy provider to every decision the
 * `models` block does not name and, without `egress.providers.<id>`, was also its consent switch.
 */
export const LEGACY_SWITCH = ["jev", "enabled"] as const

const legacyBlock = (block: Record<string, unknown>): Record<string, unknown> =>
  isPlainObject(block.jev) ? block.jev : {}

/** Whether the old single switch is on in a raw `flupcode.adaptive` block. */
export const legacySwitchOn = (block: Record<string, unknown>): boolean => legacyBlock(block).enabled === true

/**
 * The legacy provider's settings as `providers.<id>` names them. `maxInputTokens` always counted
 * characters of the serialized input, so it is `maxInputChars` under its true name.
 */
export function legacyProviderBlock(block: Record<string, unknown>): Record<string, unknown> {
  const legacy = legacyBlock(block)
  return Object.fromEntries(
    (
      [
        ["endpoint", legacy.endpoint],
        ["model", legacy.model],
        ["timeoutMs", legacy.timeoutMs],
        ["maxInputChars", legacy.maxInputTokens],
      ] as const
    ).filter((entry) => entry[1] !== undefined),
  )
}

/**
 * The legacy provider's consent as `egress.providers.<id>` names it: the switch was `jev.enabled` and
 * the scope the top-level `egress.projects` and `egress.kinds`.
 */
export function legacyConsentBlock(block: Record<string, unknown>): Record<string, unknown> {
  const egress = isPlainObject(block.egress) ? block.egress : {}
  return { enabled: legacyBlock(block).enabled, projects: egress.projects, kinds: egress.kinds }
}

/** A policy's switch for asking a model: `allowModel`, else the old `allowJev`. */
export const policyAllowsModel = (policy: Record<string, unknown>): unknown => policy.allowModel ?? policy.allowJev

/**
 * The environment variable a key reference used to be read from. Only the legacy provider's key had
 * one; every key is now read from `FLUPCODE_<REF>` first (see `model-key.ts`).
 */
export const legacyKeyEnv = (ref: string): string | undefined =>
  ref === "typesafe-api-key" ? "TYPESAFE_API_KEY" : undefined
