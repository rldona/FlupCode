import { rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { detectEngine } from "@flupcode/remote/engine-kind"
import { engineAuthorization } from "../engine"
import { DEFAULT_RUNTIME_PROBE_CONFIG } from "./runtime-config"
import type { RuntimeProbeConfig } from "./runtime-config"

/**
 * Whether the adaptive plugins' hooks fire. `legacy` is the proof that they do: 1.x's legacy runner,
 * or an OpenCode 2 engine running FlupCode's 2.x plugins (their `context` hook writes the same canary,
 * V2-30). `v2` is 1.x's embedded V2 runner, where those hooks never fire; it is not OpenCode 2.
 */
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

/**
 * A change in what the engine offers the adaptive plugins (AH-D05). `runtime-changed` and
 * `engine-version-changed` compare against the last definitive observation; `v2-turns-observed` is
 * one engine process serving turns on both runners, where the legacy hook proof hides the V2 ones.
 */
export type RuntimeAlertKind = "runtime-changed" | "engine-version-changed" | "v2-turns-observed"

export type RuntimeAlert = { kind: RuntimeAlertKind; from?: string; to: string; at: number }

/** The baseline the alerts compare against, and the alerts themselves, as the harness persists them. */
export type RuntimeWatch = {
  runtime?: Exclude<RuntimeKind, "unknown">
  version?: string
  /** The engine boot (`loadedAt`) a `v2-turns-observed` alert was raised for: one alert per process. */
  mixedSince?: number
  alerts: RuntimeAlert[]
  acknowledgedAt: number
}

export type RuntimeProbeDeps = {
  engineURL: string
  config?: Partial<RuntimeProbeConfig>
  now?: () => number
  readFile?: (path: string) => Promise<string | undefined>
  engineHealth?: (url: string) => Promise<EngineHealth>
  filePath?: string
  env?: NodeJS.ProcessEnv
  /** Where the runtime watch persists; without one it lives in memory for the process only. */
  watchFile?: string
}

export type RuntimeProbe = {
  state(): RuntimeState
  refresh(force?: boolean): Promise<RuntimeState>
  capabilities(): RuntimeCapabilities
  /** The runtime changes raised since the last acknowledgement, oldest first. */
  alerts(): RuntimeAlert[]
  acknowledge(): Promise<void>
}

/** A bounded history: the UI shows the recent changes, not every flap of a long-lived harness. */
const MAX_ALERTS = 20

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

/**
 * The watch after one classification (AH-D05).
 *
 * Only definitive evidence moves the baseline: an `unknown` (engine down, no turn yet) says nothing
 * about a change, and a config override is the reader's own statement rather than the engine's. The
 * first definitive observation only sets the baseline, since there is nothing to compare it with.
 */
export function watchRuntime(watch: RuntimeWatch, state: RuntimeState): RuntimeWatch {
  const observed =
    state.runtime !== "unknown" && state.evidence.reason !== "config-override" ? state.runtime : undefined
  const version = state.evidence.engine.reachable ? state.evidence.engine.version : undefined
  // Mixed turns only matter when the legacy hook is the proof; a disabled probe stays silent.
  const mixed = state.evidence.reason === "legacy-hook-fired" ? mixedBoot(state.evidence.canary) : undefined
  const raised: RuntimeAlert[] = [
    ...(observed && watch.runtime && observed !== watch.runtime
      ? [{ kind: "runtime-changed" as const, from: watch.runtime, to: observed, at: state.checkedAt }]
      : []),
    ...(version && watch.version && version !== watch.version
      ? [{ kind: "engine-version-changed" as const, from: watch.version, to: version, at: state.checkedAt }]
      : []),
    ...(mixed && mixed.loadedAt !== watch.mixedSince
      ? [{ kind: "v2-turns-observed" as const, to: mixed.event, at: state.checkedAt }]
      : []),
  ]
  const runtime = observed ?? watch.runtime
  const baseline = version ?? watch.version
  const mixedSince = mixed?.loadedAt ?? watch.mixedSince
  return {
    ...(runtime ? { runtime } : {}),
    ...(baseline ? { version: baseline } : {}),
    ...(mixedSince !== undefined ? { mixedSince } : {}),
    alerts: [...watch.alerts, ...raised].slice(-MAX_ALERTS),
    acknowledgedAt: watch.acknowledgedAt,
  }
}

/**
 * Both proofs inside one engine process. The engine mounts the legacy and the V2 routes side by side,
 * so a client driving V2 gets turns the adaptive hooks never see, while the classification still
 * reads the legacy hook and answers `legacy`.
 */
function mixedBoot(canary: RuntimeCanary | undefined) {
  if (!canary || typeof canary.loadedAt !== "number") return undefined
  if (typeof canary.hookAt !== "number" || canary.hookAt <= 0 || canary.hookAt < canary.loadedAt) return undefined
  if (typeof canary.v2At !== "number" || canary.v2At <= 0 || canary.v2At < canary.loadedAt) return undefined
  return { loadedAt: canary.loadedAt, event: canary.event ?? "session.next" }
}

/** Default path of the persisted watch, beside the harness database it belongs with. */
export function runtimeWatchFilePath(databaseDirectory: string): string {
  return join(databaseDirectory, "runtime-watch.json")
}

const initialUnknown = (url: string): RuntimeState => ({
  runtime: "unknown",
  degraded: true,
  evidence: { reason: "no-evidence", engine: { url, reachable: false }, checkedAt: 0 },
  checkedAt: 0,
})

// Through the shared detection rather than `/global/health` alone: OpenCode 2 has no such route and
// answers it with its web UI, so a 2.x engine would read as unreachable instead of by its version.
const defaultEngineHealth = async (url: string): Promise<EngineHealth> => {
  const authorization = engineAuthorization()
  const detected = await detectEngine(url, fetch, {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    ...(authorization ? { headers: { authorization } } : {}),
  })
  if (detected.kind === "none") return { reachable: false }
  return { reachable: true, ...(detected.version ? { version: detected.version } : {}) }
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

const RUNTIME_KINDS = ["legacy", "v2"] as const

const ALERT_KINDS: readonly RuntimeAlertKind[] = ["runtime-changed", "engine-version-changed", "v2-turns-observed"]

const asAlert = (value: unknown): RuntimeAlert[] => {
  if (!isPlainObject(value)) return []
  const kind = ALERT_KINDS.find((known) => known === value.kind)
  if (!kind || typeof value.to !== "string" || typeof value.at !== "number") return []
  return [{ kind, ...(typeof value.from === "string" ? { from: value.from } : {}), to: value.to, at: value.at }]
}

/** Only fields of the shape the probe writes survive; anything else starts a fresh watch. */
const asWatch = (value: unknown): RuntimeWatch => {
  if (!isPlainObject(value)) return { alerts: [], acknowledgedAt: 0 }
  const runtime = RUNTIME_KINDS.find((kind) => kind === value.runtime)
  return {
    ...(runtime ? { runtime } : {}),
    ...(typeof value.version === "string" ? { version: value.version } : {}),
    ...(typeof value.mixedSince === "number" ? { mixedSince: value.mixedSince } : {}),
    alerts: Array.isArray(value.alerts) ? value.alerts.flatMap(asAlert).slice(-MAX_ALERTS) : [],
    acknowledgedAt: typeof value.acknowledgedAt === "number" ? value.acknowledgedAt : 0,
  }
}

const readWatch = async (path: string | undefined): Promise<RuntimeWatch> => {
  if (!path) return { alerts: [], acknowledgedAt: 0 }
  const value: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined)
  return asWatch(value)
}

// Atomic like the canary: a harness killed mid-write must not leave a watch it cannot read back.
const writeWatch = async (path: string | undefined, watch: RuntimeWatch) => {
  if (!path) return
  const temp = `${path}.tmp-${process.pid}`
  await Bun.write(temp, JSON.stringify(watch))
  await rename(temp, path)
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
  // Loaded once, on first use; every later change is written back so a restart keeps the baseline.
  let watch: RuntimeWatch | undefined
  const loadWatch = async () => {
    watch = watch ?? (await readWatch(deps.watchFile))
    return watch
  }

  // A watch that cannot be written still holds in memory; the probe never fails over it.
  const observe = async (state: RuntimeState) => {
    const previous = await loadWatch()
    const next = watchRuntime(previous, state)
    watch = next
    if (JSON.stringify(next) !== JSON.stringify(previous)) await writeWatch(deps.watchFile, next).catch(() => {})
  }

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
        .then(async (state) => {
          cached = state
          await observe(state).catch(() => {})
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
    alerts: () => (watch ? watch.alerts.filter((alert) => alert.at > (watch?.acknowledgedAt ?? 0)) : []),
    acknowledge: async () => {
      const current = await loadWatch()
      watch = { ...current, acknowledgedAt: now() }
      await writeWatch(deps.watchFile, watch).catch(() => {})
    },
  }
}
