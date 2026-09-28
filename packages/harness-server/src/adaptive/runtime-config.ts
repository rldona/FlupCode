import type { RuntimeKind } from "./runtime"

export type RuntimeOverride = "auto" | "legacy" | "v2" | "off"

export type RuntimeProbeConfig = {
  enabled: boolean
  ttlMs: number
  override: RuntimeOverride
  versionMap: Record<string, Exclude<RuntimeKind, "unknown">>
}

export const DEFAULT_RUNTIME_PROBE_CONFIG: RuntimeProbeConfig = {
  enabled: true,
  ttlMs: 60_000,
  override: "auto",
  versionMap: {},
}

const OVERRIDES: readonly RuntimeOverride[] = ["auto", "legacy", "v2", "off"]

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isOverride = (value: string): value is RuntimeOverride => OVERRIDES.some((override) => override === value)

const overrideFrom = (value: unknown): RuntimeOverride | undefined =>
  typeof value === "string" && isOverride(value) ? value : undefined

const ttlFrom = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined

const versionMapFrom = (value: unknown): Record<string, "legacy" | "v2"> => {
  if (!isPlainObject(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([version, kind]) =>
      kind === "legacy" || kind === "v2" ? [[version, kind] as const] : [],
    ),
  )
}

/**
 * The probe's settings, from the environment first, then the `flupcode.adaptive` block, then defaults.
 *
 * The block is what the global config carries, so a machine can pin a runtime without an env var; the
 * env wins because it is the one a launcher can set per process.
 */
export function resolveRuntimeConfig(input: { block?: unknown; env?: NodeJS.ProcessEnv } = {}): RuntimeProbeConfig {
  const env = input.env ?? process.env
  const block = isPlainObject(input.block) ? input.block : {}
  const probe = isPlainObject(block.probe) ? block.probe : {}

  const enabled =
    env.FLUPCODE_ADAPTIVE_PROBE_DISABLED === "1"
      ? false
      : typeof probe.enabled === "boolean"
        ? probe.enabled
        : DEFAULT_RUNTIME_PROBE_CONFIG.enabled

  const ttlMs =
    ttlFrom(Number(env.FLUPCODE_ADAPTIVE_PROBE_TTL_MS)) ?? ttlFrom(probe.ttlMs) ?? DEFAULT_RUNTIME_PROBE_CONFIG.ttlMs

  const override =
    overrideFrom(env.FLUPCODE_ADAPTIVE_RUNTIME) ??
    overrideFrom(block.runtime) ??
    DEFAULT_RUNTIME_PROBE_CONFIG.override

  const mapped = versionMapFrom(block.runtimeMap)
  const versionMap = Object.keys(mapped).length > 0 ? mapped : DEFAULT_RUNTIME_PROBE_CONFIG.versionMap

  return { enabled, ttlMs, override, versionMap }
}
