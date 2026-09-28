import { homedir } from "node:os"
import { join } from "node:path"
import { engineAuthorization } from "../engine"
import { DEFAULT_RUNTIME_PROBE_CONFIG } from "./runtime-config"
import type { RuntimeProbeConfig } from "./runtime-config"

export type RuntimeKind = "legacy" | "v2" | "unknown"

export type RuntimeProbeEvidenceReason =
  | "legacy-hook-fired"
  | "v2-turn-observed"
  | "config-override"
  | "version-map"
  | "no-evidence"
  | "engine-unreachable"
  | "probe-disabled"
  | "canary-unreadable"

export type RuntimeCanary = {
  pid?: number
  loadedAt?: number
  token?: string
  hookAt?: number
  hook?: string
  v2At?: number
  event?: string
}

export type EngineHealth = { reachable: boolean; version?: string }

export type RuntimeProbeEvidence = {
  reason: RuntimeProbeEvidenceReason
  detail?: string
  engine: { url: string; reachable: boolean; version?: string }
  canary?: RuntimeCanary
  checkedAt: number
}

export type RuntimeState = {
  runtime: RuntimeKind
  degraded: boolean
  evidence: RuntimeProbeEvidence
  checkedAt: number
}

export type RuntimeCapabilities = {
  runtime: RuntimeKind
  degraded: boolean
  canUseLegacyHooks: boolean
  canInjectSystemPrompt: boolean
  canObserveToolCalls: boolean
  canObserveCompaction: boolean
  canTransformMessages: boolean
  canUseSdkPath: true
  checkedAt: number
}

export type RuntimeProbeDeps = {
  engineURL: string
  config?: Partial<RuntimeProbeConfig>
  now?: () => number
  readFile?: (path: string) => Promise<string | undefined>
  engineHealth?: (url: string) => Promise<EngineHealth>
  filePath?: string
  env?: NodeJS.ProcessEnv
}

export type RuntimeProbe = {
  state(): RuntimeState
  refresh(force?: boolean): Promise<RuntimeState>
  capabilities(): RuntimeCapabilities
}

const HEALTH_TIMEOUT_MS = 1500

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Where the canary plugin writes, kept in step with `RUNTIME_PROBE_PLUGIN` in `packages/remote`. */
export function runtimeProbeFilePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FLUPCODE_RUNTIME_PROBE_FILE) return env.FLUPCODE_RUNTIME_PROBE_FILE
  const base = env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "flupcode", "runtime-probe.json")
}

const runtimeForVersion = (
  version: string | undefined,
  versionMap: RuntimeProbeConfig["versionMap"],
): RuntimeKind | undefined => {
  if (!version) return undefined
  const mapped = versionMap[version]
  return mapped === "legacy" || mapped === "v2" ? mapped : undefined
}

/**
 * Which runtime the engine is running, from positive evidence only.
 *
 * A canary hook or a V2 turn event counts only inside the process that wrote it: `loadedAt` is reset
 * when the process's boot token changes, so a stale heartbeat from before a migration can never read
 * as `legacy`. The options are tried in order and anything short of proof degrades to `unknown`.
 */
export function classifyRuntime(input: {
  config: RuntimeProbeConfig
  engine: EngineHealth & { url?: string }
  canary?: RuntimeCanary
  now: number
}): RuntimeState {
  const decision = (): { runtime: RuntimeKind; reason: RuntimeProbeEvidenceReason; detail?: string } => {
    if (!input.config.enabled || input.config.override === "off") return { runtime: "unknown", reason: "probe-disabled" }
    if (input.config.override === "legacy") return { runtime: "legacy", reason: "config-override" }
    if (input.config.override === "v2") return { runtime: "v2", reason: "config-override" }
    if (!input.engine.reachable) return { runtime: "unknown", reason: "engine-unreachable" }
    const canary = input.canary
    // The token is the process's boot identity: a pid alone is reused by the OS, so evidence keyed
    // only by pid cannot be attributed to the current process. Missing any of the three degrades to
    // unknown, never legacy.
    if (canary && (canary.pid === undefined || canary.loadedAt === undefined || !canary.token))
      return { runtime: "unknown", reason: "canary-unreadable" }
    const loadedAt = canary?.loadedAt
    const hookAt = canary?.hookAt
    const v2At = canary?.v2At
    if (typeof loadedAt === "number") {
      if (typeof hookAt === "number" && hookAt > 0 && hookAt >= loadedAt)
        return { runtime: "legacy", reason: "legacy-hook-fired", detail: canary?.hook }
      if (typeof v2At === "number" && v2At > 0 && v2At >= loadedAt)
        return { runtime: "v2", reason: "v2-turn-observed", detail: canary?.event }
    }
    const mapped = runtimeForVersion(input.engine.version, input.config.versionMap)
    if (mapped) return { runtime: mapped, reason: "version-map", detail: input.engine.version }
    return { runtime: "unknown", reason: "no-evidence" }
  }

  const chosen = decision()
  return {
    runtime: chosen.runtime,
    degraded: chosen.runtime !== "legacy",
    evidence: {
      reason: chosen.reason,
      ...(chosen.detail ? { detail: chosen.detail } : {}),
      engine: {
        url: input.engine.url ?? "",
        reachable: input.engine.reachable,
        ...(input.engine.version ? { version: input.engine.version } : {}),
      },
      ...(input.canary !== undefined ? { canary: input.canary } : {}),
      checkedAt: input.now,
    },
    checkedAt: input.now,
  }
}

/** The capabilities a runtime grants, derived from the same classification the evidence reports. */
function capabilitiesOf(state: RuntimeState): RuntimeCapabilities {
  const legacy = state.runtime === "legacy"
  return {
    runtime: state.runtime,
    degraded: state.degraded,
    canUseLegacyHooks: legacy,
    canInjectSystemPrompt: legacy,
    canObserveToolCalls: legacy,
    canObserveCompaction: legacy,
    canTransformMessages: legacy,
    canUseSdkPath: true,
    checkedAt: state.checkedAt,
  }
}

const initialUnknown = (url: string): RuntimeState => ({
  runtime: "unknown",
  degraded: true,
  evidence: { reason: "no-evidence", engine: { url, reachable: false }, checkedAt: 0 },
  checkedAt: 0,
})

const defaultEngineHealth = async (url: string): Promise<EngineHealth> => {
  try {
    const authorization = engineAuthorization()
    const response = await fetch(`${url.replace(/\/+$/, "")}/global/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      ...(authorization ? { headers: { authorization } } : {}),
    })
    if (!response.ok) return { reachable: false }
    const body: unknown = await response.json()
    return {
      reachable: true,
      ...(isPlainObject(body) && typeof body.version === "string" ? { version: body.version } : {}),
    }
  } catch {
    return { reachable: false }
  }
}

const defaultReadFile = async (path: string): Promise<string | undefined> => {
  try {
    return await Bun.file(path).text()
  } catch {
    return undefined
  }
}

/** Only fields of the shape the canary writes survive; a malformed file reads as unreadable. */
const asCanary = (value: unknown): RuntimeCanary => {
  if (!isPlainObject(value)) return {}
  return {
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.loadedAt === "number" ? { loadedAt: value.loadedAt } : {}),
    ...(typeof value.token === "string" ? { token: value.token } : {}),
    ...(typeof value.hookAt === "number" ? { hookAt: value.hookAt } : {}),
    ...(typeof value.hook === "string" ? { hook: value.hook } : {}),
    ...(typeof value.v2At === "number" ? { v2At: value.v2At } : {}),
    ...(typeof value.event === "string" ? { event: value.event } : {}),
  }
}

const readCanary = async (
  readFile: (path: string) => Promise<string | undefined>,
  path: string,
): Promise<RuntimeCanary | undefined> => {
  try {
    const text = await readFile(path)
    if (text === undefined) return undefined
    return asCanary(JSON.parse(text))
  } catch {
    return {}
  }
}

/**
 * A probe over the engine's lifecycle.
 *
 * `state()` and `capabilities()` read the last classification and never await; `refresh()` re-reads
 * the engine and the canary, cached for `ttlMs` and coalesced so concurrent callers share one pass.
 * It never throws: a probe that cannot reach anything classifies as `unknown` rather than stopping
 * the caller.
 */
export function createRuntimeProbe(deps: RuntimeProbeDeps): RuntimeProbe {
  const config: RuntimeProbeConfig = { ...DEFAULT_RUNTIME_PROBE_CONFIG, ...deps.config }
  const now = deps.now ?? Date.now
  const health = deps.engineHealth ?? defaultEngineHealth
  const readFile = deps.readFile ?? defaultReadFile
  const path = deps.filePath ?? runtimeProbeFilePath(deps.env)

  let cached = initialUnknown(deps.engineURL)
  let inflight: Promise<RuntimeState> | undefined

  const investigate = async (): Promise<RuntimeState> => {
    const engine = await health(deps.engineURL).catch(() => ({ reachable: false }))
    const canary = await readCanary(readFile, path)
    return classifyRuntime({
      config,
      engine: { ...engine, url: deps.engineURL },
      ...(canary !== undefined ? { canary } : {}),
      now: now(),
    })
  }

  const refresh = async (force = false): Promise<RuntimeState> => {
    try {
      if (!force && cached.checkedAt > 0 && now() - cached.checkedAt < config.ttlMs) return cached
      if (inflight) return await inflight
      inflight = investigate()
        .then((state) => {
          cached = state
          return state
        })
        .catch(() => cached)
        .finally(() => {
          inflight = undefined
        })
      return await inflight
    } catch {
      return cached
    }
  }

  return {
    state: () => cached,
    refresh,
    capabilities: () => capabilitiesOf(cached),
  }
}
