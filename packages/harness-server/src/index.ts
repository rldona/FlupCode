import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHarnessHandler } from "./api"
import { dropAll } from "./checkpoint"
import { runEngineDataCommand } from "./engine-data-command"
import { EVENTS_KEPT, SqliteRoutineRepository, defaultDatabasePath } from "./repository"
import { RoutineScheduler } from "./scheduler"
import { seedTemplates } from "./workflow"
import { createRecipeDriver, resolveBrowserExecutable } from "./browser"
import type { RecipeDriver } from "./browser"
import {
  adaptiveTokenFile,
  pluginTokenFile,
  readOrCreatePluginToken,
  readOrCreateRemoteToken,
  readPluginToken,
  readRemoteToken,
  remoteTokenFile,
  browserTokenFile,
  isLoopbackHostname,
  readAdaptiveToken,
  readBrowserToken,
  readOrCreateAdaptiveToken,
  readOrCreateBrowserToken,
} from "./browser-token"
import { createEgressGuard } from "./browser-egress"
import { createActionRunner } from "./action-runner"
import type { ActionRunner } from "./action-runner"
import { unavailableActionCredentialResolver } from "./action-credentials"
import type { ActionCredentialResolver } from "./action-credentials"
import { createVault, parseVaultKey, readOrCreateVaultKeyFile, readVaultKeyFile, vaultKeyFile } from "./vault"
import type { CredentialVault } from "./vault"
import { globalAdaptiveBlock, globalSmallModel, loadActionProfiles } from "./config-files"
import { createAdaptiveConfig } from "./adaptive/config"
import { retentionCutoffs } from "./adaptive/retention"
import { createAdaptiveEgressGuard } from "./adaptive/egress"
import { resolveInstallationKey } from "./adaptive/installation-key"
import { createRuntimeProbe, runtimeWatchFilePath } from "./adaptive/runtime"
import type { RuntimeProbe } from "./adaptive/runtime"
import { createRelevanceService } from "./adaptive/relevance"
import { createGuardrailService } from "./adaptive/guardrails"
import { createSessionOverrides } from "./adaptive/session-override"
import { createAdaptiveConfigSurface } from "./adaptive/config-surface"
import { createEpisodeCoordinator } from "./adaptive/coordinator"
import { createGovernor } from "./adaptive/providers/governor"
import { createModelKeys } from "./adaptive/model-key"
import type { KeySlot } from "./adaptive/model-key"
import { createPredictiveProviders } from "./adaptive/predictive/registry"
import { createActionApprover } from "./action-approval"
import { createBrowserPolicy } from "./browser-policy"
import { createBrowserMcpGate } from "./browser-mcp"
import { createBrowserAttach } from "./browser-attach"
import { createBrowserBridge } from "./browser-bridge"
import { SOCKET_PATH } from "@flupcode/bridge-extension/protocol"
import { Engine } from "./engine"
import { planExit } from "./plan-exit"
import { parseModelKey } from "./policy"
import { createDecisionService } from "./adaptive/decision-service"
import { createValueGate } from "./adaptive/value-gate"
import { createContextManager } from "./adaptive/context-manager"
import { createShadowRunner } from "./adaptive/shadow"
import { createOutcomeLabeler } from "./adaptive/labeler"
import { createLearnedStore } from "./adaptive/skills/learned-store"
import { createSkillCurator } from "./adaptive/skills/curator"
import { sessionSkills } from "./adaptive/skills/usage"
import { createLearningDrafter } from "./adaptive/learning/draft"
import { createLearningManager } from "./adaptive/learning/manager"
import { episodeTrace } from "./adaptive/learning/heuristics"
import type { LearningRunner } from "./adaptive/learning/manager"
import { learningLimitStatus } from "./adaptive/learning/limits"
import { createProposalReview } from "./adaptive/learning/review"
import { createQuotaPoller } from "./quota/poller"
import { createUsagePricing } from "./usage-pricing"
import { createUsageReconciler } from "./usage-reconciler"
import { createAuditor } from "./verdict"
import { createPairing, type Pairing } from "./pairing"

export type HarnessServerOptions = {
  port?: number
  hostname?: string
  databasePath?: string
  engineURL?: string
  intervalMs?: number
  browserToken?: string
  browserTokenFile?: string
  browserDataDir?: string
  browserExecutablePath?: string
  browserIdleTimeoutMs?: number
  actionCredentials?: ActionCredentialResolver
  vaultKey?: string
  vaultKeyFile?: string
  runtimeProbe?: RuntimeProbe
  /** The acting line's dedicated bearer (FH-04, ADR-0022); resolved from the file when omitted. */
  adaptiveToken?: string
  adaptiveTokenFile?: string
  /** The engine plugins' bearer (TI-10); resolved from the file when omitted. */
  pluginToken?: string
  pluginTokenFile?: string
  /** The remote host's bearer (HE-02); read from `remoteTokenFile` when absent. */
  remoteToken?: string
  remoteTokenFile?: string
  /** Browser tabs paired with a one-time code (HE-01); only on a loopback host with a UI token. */
  pairing?: Pairing
  /** Where the browsers paired through FlupCode Bridge are kept (BU-04); beside the tokens when absent. */
  browserBridgeFile?: string
}

export function createHarnessServer(options: HarnessServerOptions = {}) {
  const databasePath = options.databasePath ?? process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath()
  const repository = new SqliteRoutineRepository(databasePath)
  // Forget what was told to expire (H-14). At startup, so a server that was away for a while acts
  // on it, and hourly after that. Pinned ones are never touched, and nothing expires by default.
  repository.removeExpiredArtifacts()
  // The event log is bounded (RP-02); at startup, so one that grew while it was away is cut back.
  repository.pruneEvents(EVENTS_KEPT)
  // Evidence beyond the total is evicted as it is written; a restart closes the gap a store carried
  // over from a build that did not (FH-006).
  const evicted = repository.evictEvidence()
  if (evicted > 0) console.warn(`[flupcode] evicted ${evicted} evidence slice(s) past the total limit`)
  const browser = browserFrom(options, repository)
  // Read apart from the runtime: the same bearer guards the artifact routes (WA-9), and it is worth
  // passing even when there is no browser to guard, so the token is not lost with the runtime.
  const browserToken = options.browserToken ?? readBrowserToken(options.browserTokenFile ?? browserTokenFile())
  const pluginToken = options.pluginToken ?? readPluginToken(options.pluginTokenFile ?? pluginTokenFile())
  const remoteToken = options.remoteToken ?? readRemoteToken(options.remoteTokenFile ?? remoteTokenFile())
  // A vault exists only when there is a key to open it: without one, a profile that names a
  // credential fails closed rather than running with an empty field, and `/harness/credentials/*`
  // is an ordinary 404 (WA-5).
  const key = parseVaultKey(options.vaultKey) ?? (() => {
    const raw = readVaultKeyFile(options.vaultKeyFile ?? vaultKeyFile())
    return parseVaultKey(raw)
  })()
  const vault: CredentialVault | undefined = key ? createVault({ store: repository, key }) : undefined
  const credentials = vault ?? options.actionCredentials ?? unavailableActionCredentialResolver
  // The runner needs a browser to drive, so it exists only when the runtime does. Without it
  // `/harness/actions/*` is an ordinary 404, and credentials fail closed (WA-2).
  // One decision point for every browser action, whichever driver acts (BU-01).
  const browserPolicy = createBrowserPolicy(repository)
  const actions: ActionRunner | undefined = browser
    ? createActionRunner({
        browser,
        policy: browserPolicy,
        repository,
        credentials,
        loadProfiles: loadActionProfiles,
      })
    : undefined
  // Built after the actions so a scheduled action is driven in process by the same runner the
  // interactive path uses (WA-7), never by a second copy that would drift.
  const engineURL = options.engineURL ?? process.env.FLUPCODE_ENGINE_URL ?? "http://127.0.0.1:4096"
  // The adaptive layer's settings (FH-016), read through a TTL getter so the kill switch takes
  // effect without a restart. Every model is off by default: without an explicit opt-in, the deterministic
  // provider answers and nothing leaves the process.
  const adaptive = createAdaptiveConfig({ read: globalAdaptiveBlock, env: process.env })
  // Retention (FH-082, ADR-0022 §2): off by default, so with the switch off no query runs at all.
  // Fail-safe: a purge that throws is logged and never takes the server down, and the same hourly
  // boundary that forgets expired artifacts runs it. With retention on it only ever removes rows
  // outside their window and unreferenced by a survivor; episodes, evidence and the filesystem are
  // never touched.
  const purge = () => {
    const retention = adaptive.current().retention
    if (!retention.enabled) return
    try {
      repository.purgeAdaptive(retentionCutoffs(retention, Date.now()))
    } catch (cause) {
      console.warn(`[flupcode] adaptive retention failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  const startup = adaptive.current()
  const hostname = options.hostname ?? process.env.FLUPCODE_HARNESS_HOST ?? "127.0.0.1"
  // The acting line's own secret (FH-04, ADR-0022). It is only resolved on a loopback host: off the
  // loopback no token, no route and no capability are built, so the feature is inert rather than
  // exposed. Without a token the route is an ordinary 404, never an open loopback.
  const adaptiveToken = isLoopbackHostname(hostname)
    ? options.adaptiveToken ?? readAdaptiveToken(options.adaptiveTokenFile ?? adaptiveTokenFile())
    : undefined
  // The predictive models' keys (ADR-0017, amended; per provider since PI-01): the environment first,
  // then the vault, where the panel saves each under its provider's key reference, bound to that
  // provider's endpoint origin. Read on every request, so saving needs no restart.
  const keys = createModelKeys({ env: process.env, vault })
  // Every registered provider that needs a key, by id, with its slot read from the live settings. Only
  // called after the registry below is built.
  const keySlots = (): Record<string, KeySlot> =>
    Object.fromEntries(models.flatMap((model) => (model.keySlot ? [[model.id, model.keySlot()] as const] : [])))
  // Every secret this process holds is deleted by value from whatever leaves or is persisted: the
  // harness's own bearers, each model key from the environment and the vault's credentials (the stored
  // model keys among them), the latter decrypted on each call so a credential saved after startup is
  // covered too.
  const egress = createAdaptiveEgressGuard({
    config: () => adaptive.current(),
    secrets: () =>
      [
        browserToken,
        pluginToken,
        remoteToken,
        adaptiveToken,
        ...Object.values(keySlots()).map((slot) => keys.fromEnv(slot)),
        ...(vault?.secrets() ?? []),
      ].filter((secret) => secret !== undefined),
  })
  const governor = createGovernor({ config: () => adaptive.current().governor, store: repository })
  // AH-C05: the value-of-information gate and answer cache, read from the decision audit's labels.
  const valueGate = createValueGate({ repository, config: () => adaptive.current() })
  // AH-C01, PI-02: the predictive providers this install can ask, each built with its own
  // `adaptive.providers.<id>` settings; `adaptive.models.<kind>` picks one of these ids per kind, and
  // without a `models` block the old single switch still assigns every kind (`legacy.ts`). AH-C03:
  // each remote model is asked only under its own `egress.providers.<id>` consent. `small-llm` gets its
  // own engine client, since the scheduler's is built after the decision service needs the registry.
  const models = createPredictiveProviders({
    egress,
    providers: () => adaptive.current().providers,
    keys,
    smallModel: () => parseModelKey(globalSmallModel()),
    engine: () => new Engine(engineURL),
  })
  // The per-session override (AH-E02): in memory, read by every capability on its next step.
  const overrides = createSessionOverrides()
  const decisions = createDecisionService({
    repository,
    config: () => adaptive.current(),
    egress,
    models,
    governor,
    valueGate,
    paused: overrides.paused,
  })
  // Context selection (FH-022/023 and the FH-024 seam): the manager owns `contextItem` — the scorer
  // baseline, the model's refinement of ambiguous items only, and the plan audit. The scheduler hands it
  // to every runner, where it plans each run prompt (best-effort) and filters it only when
  // `context.apply` is on (off by default); the shadow still plans closed episodes. Reuse the vault
  // key the server already holds; without one, resolve (and, on first use, create) a restricted
  // per-installation key.
  const context = createContextManager({
    repository,
    service: decisions,
    config: () => adaptive.current(),
    egress,
    opaqueKey: () => key ?? resolveInstallationKey(),
    paused: overrides.paused,
  })
  // The learned-skill store and its curator (FH-040/FH-041): the curator is the only writer of a
  // learned skill and the roster the shadow evaluates relevance against. The store is built before
  // the shadow because the shadow reads that roster.
  const learnedStore = createLearnedStore({
    env: process.env,
    snapshotKeep: startup.learning.snapshotKeep,
    // The kill switch as a rule in the writer too: with learning off the store refuses on its own.
    enabled: () => adaptive.current().learning.enabled,
    // The same per-installation key as the context ids: a learned skill's provenance is an HMAC
    // under it, so a repository cannot commit a skill the store would treat as its own.
    key: () => key ?? resolveInstallationKey(),
  })
  const curator = createSkillCurator({
    store: learnedStore,
    // The kill switch reaches the writer: with learning off, a closed session records no usage, so a
    // close cannot move the sidecar or the ledger even though the shadow still reads the roster.
    enabled: () => adaptive.current().learning.enabled,
    config: () => ({ archiveAfter: adaptive.current().learning.archiveAfter }),
    // The same body cap the manager bounds to, so a configured value cannot be accepted by one and
    // refused by the other.
    limits: () => ({ maxBodyChars: adaptive.current().learning.maxBodyChars }),
  })
  // The shadow (FH-017) records decisions on episode close and acts on nothing; it is the only
  // writer to `adaptive_decision` and, through the manager, `adaptive_plan`. The roster is
  // human + learned. Its `skillRelevance` selection is a guess, so it is not usage (AH-F02).
  const shadow = createShadowRunner({
    service: decisions,
    repository,
    config: () => adaptive.current(),
    context,
    readSkills: (episode) => curator.roster(episode.projectID),
    onError: (cause) =>
      console.error(`Could not record an adaptive decision: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  // The outcome labeler (AH-C06) joins each decision with what happened after it and writes its
  // label once the outcome is knowable. It is a writer, so it obeys the kill switch, read live.
  const labeler = createOutcomeLabeler({
    repository,
    enabled: () => adaptive.current().enabled,
    key: () => key ?? resolveInstallationKey(),
    onError: (cause) =>
      console.error(`Could not label adaptive decisions: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  // The learning manager is built after the scheduler (it drafts through the engine), so the close
  // callback reaches it through this holder; the callback is only ever invoked once serving starts.
  let learning: LearningRunner | undefined
  // Episodes (FH-002): the scheduler hands it to every runner, and it sweeps for terminal runs a
  // restart or a lost hook left behind. The close composes the shadow and the learning manager; both
  // are async and inert to failure.
  const episodes = createEpisodeCoordinator({
    repository,
    config: startup.episode,
    // Interactive sessions (AH-B03) are a new writer, so unlike run episodes they obey the kill
    // switch, read live like every other adaptive writer.
    interactive: () => {
      const current = adaptive.current()
      return current.enabled && current.episode.interactive
    },
    // The scheduler is built just below; a sweep only runs once `episodes.start()` is called after it.
    describeSession: (sessionID) => scheduler.engine.describeSession(sessionID),
    onEpisodeClosed: (episode) => {
      shadow.onEpisodeClosed(episode)
      learning?.onEpisodeClosed(episode)
      // Real use (AH-F02): the skills the session ran through the engine's `skill` tool, as the
      // session-metrics plugin recorded them, are the lifecycle's only usage signal. Reading the
      // roster is filesystem I/O, so it is queued off the close path like the shadow and reflection.
      void Promise.resolve()
        .then(() =>
          curator.recordSession({
            projectID: episode.projectID,
            sessionID: episode.sessionID,
            skills: sessionSkills(repository.listSessionMetrics(episode.sessionID)),
          }),
        )
        .catch((cause) =>
          console.error(`Could not record learned-skill use: ${cause instanceof Error ? cause.message : String(cause)}`),
        )
    },
    onError: (cause) =>
      console.error(`Could not record a session episode: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  const scheduler = new RoutineScheduler({
    repository,
    engineURL,
    intervalMs: options.intervalMs,
    ...(actions ? { actions } : {}),
    episodes,
    context,
    // Every agent task is judged (RP-06); the `completion` decision asks a model only where one is
    // assigned and consented to, and otherwise the deterministic rule's verdict stands.
    auditor: createAuditor(decisions, () => adaptive.current()),
  })
  // The learning manager (FH-034): it reflects on closed episodes and sweeps for terminal ones with
  // no job. The draft is the only model call, through a throwaway engine session, and only when a
  // model is resolved and the project opted in; with learning off it never fires.
  const drafter = createLearningDrafter({
    engine: scheduler.engine,
    config: () => adaptive.current(),
    smallModel: globalSmallModel,
    redact: egress.redact,
  })
  learning = createLearningManager({
    repository,
    service: decisions,
    config: () => adaptive.current(),
    egress,
    models,
    curator,
    drafter,
    smallModel: globalSmallModel,
    // The heuristic fallback (AH-F01) reads the plugin's signal files for an episode's ordered trace.
    trace: (episode) => episodeTrace(episode),
    onError: (cause) =>
      console.error(`Could not reflect on a session episode: ${cause instanceof Error ? cause.message : String(cause)}`),
  })
  // The runtime probe (FH-000): which runtime the engine is on, so a gate never assumes the legacy
  // hooks. It refreshes off the critical path once serving starts and on its own interval; a caller
  // asking for the route refreshes within the same TTL.
  const runtimeConfig = startup.runtime
  // Its watch (AH-D05) persists beside the database, so a harness restarted with a V2 engine still
  // compares against what it saw before; an in-memory database keeps the watch in memory too.
  const runtimeProbe =
    options.runtimeProbe ??
    createRuntimeProbe({
      engineURL,
      config: runtimeConfig,
      ...(databasePath === ":memory:" ? {} : { watchFile: runtimeWatchFilePath(dirname(databasePath)) }),
    })
  // The acting relevance line (FH-04): the one policy point a live turn reaches. It reuses the same
  // decision service, roster and runtime probe; with the feature off it returns a null line and the
  // turn is byte-identical. The probe is built just above because the service reads its capabilities.
  const relevance = createRelevanceService({
    service: decisions,
    curator,
    runtimeProbe,
    config: () => adaptive.current(),
    overrides,
  })
  // The failure/loop guardrails (FH-060–063, ADR-0023): an advisory loopback service fed by opaque
  // digests from the installed plugin. It reuses the same decision service and runtime probe; with
  // the feature off it touches no ring and writes nothing. The route is built below with the same
  // dedicated bearer as the relevance line.
  const guardrails = createGuardrailService({
    service: decisions,
    runtimeProbe,
    config: () => adaptive.current(),
    paused: overrides.paused,
  })
  // The settings surface (FH-070): reads the composed config and writes the switches back into the
  // global file. It reuses the config reader (raw + current + invalidate), the runtime probe and the
  // usage ledger; `canWrite` is the artifacts bearer, and enabling relevance also needs the acting
  // line's own token, so both are reported here.
  const adaptiveConfig = createAdaptiveConfigSurface({
    config: adaptive,
    runtime: () => runtimeProbe.state(),
    alerts: () => runtimeProbe.alerts(),
    capabilities: () => runtimeProbe.capabilities(),
    repository,
    canWrite: Boolean(browserToken),
    adaptiveTokenPresent: Boolean(adaptiveToken),
    env: process.env,
    keys: () =>
      Object.fromEntries(Object.entries(keySlots()).map(([id, slot]) => [id, keys.status(slot)] as const)),
    smallModel: globalSmallModel,
    models,
    // The caps each project has reached (AH-F03), counted live on every read of the view.
    learningLimits: () =>
      learningLimitStatus({
        repository,
        installedSkills: (projectID) => curator.roster(projectID).filter((entry) => entry.learned).length,
        config: adaptive.current().learning,
        now: Date.now(),
      }),
  })
  // The agent's own browser (BU-05): the client of the engine's attach protocol, on the recipe
  // runner's browser and under the same policy, for the sessions a person hands a browser to.
  const browserAttach = browser
    ? createBrowserAttach({
        engine: new Engine(engineURL),
        driver: browser,
        policy: browserPolicy,
        ask: (request) => new Engine(engineURL).askChoice(request),
      })
    : undefined
  // The person's own browser through FlupCode Bridge (BU-04): the same attach client and policy, on a
  // driver that reaches the browser's FlupCode tab group. Only on the loopback, where the UI token is.
  const bridge =
    browser && isLoopbackHostname(hostname)
      ? createBrowserBridge({
          repository,
          egress: createEgressGuard(),
          hostname,
          ...(options.browserDataDir ? { dataDir: options.browserDataDir } : {}),
          ...(options.browserBridgeFile ? { file: options.browserBridgeFile } : {}),
        })
      : undefined
  const bridgeAttach = bridge
    ? createBrowserAttach({
        engine: new Engine(engineURL),
        driver: bridge.driver,
        policy: browserPolicy,
        place: "your browser, in its FlupCode tab group",
        ask: (request) => new Engine(engineURL).askChoice(request),
      })
    : undefined
  // What the server can tell of a ledger row's money (UL-05), shared by the ingest and the reconciler.
  const usagePricing = createUsagePricing({ engine: scheduler.engine, repository })
  // The connected providers' quotas (UL-07), read on the server and kept as samples.
  const quotas = createQuotaPoller({ engine: scheduler.engine, repository })
  const handler = createHarnessHandler(repository, scheduler, {
    hostname,
    usagePricing,
    quotas,
    ...(browser ? { browser } : {}),
    ...(browserAttach ? { browserAttach } : {}),
    ...(bridge && bridgeAttach ? { bridge, bridgeAttach } : {}),
    ...(browserToken ? { token: browserToken } : {}),
    ...(pluginToken ? { pluginToken } : {}),
    ...(remoteToken ? { remoteToken } : {}),
    // A paired tab is a UI caller, so pairing exists only where the UI's token does, on the loopback.
    ...(options.pairing && browserToken && isLoopbackHostname(hostname) ? { pairing: options.pairing } : {}),
    ...(actions ? { actions } : {}),
    ...(actions
      ? {
          actionApprover: createActionApprover({
            actions,
            policy: browserPolicy,
            ask: (request) => new Engine(engineURL).askChoice(request),
          }),
          browserPolicy,
        }
      : {}),
    ...(vault ? { credentials: vault } : {}),
    // The user's browser through an MCP preset (BU-02): asked by the plugins, under the same policy.
    browserMcp: createBrowserMcpGate({
      policy: browserPolicy,
      ask: (request) => new Engine(engineURL).askChoice(request),
    }),
    planExit: (sessionID) => planExit(new Engine(engineURL), sessionID),
    runtimeProbe,
    decisions,
    valueGate,
    context,
    proposals: repository,
    learnedSkills: curator,
    proposalReview: createProposalReview({ repository, curator }),
    learnedSkillActions: curator,
    adaptiveConfig,
    modelKeys: { keys, slots: keySlots },
    overrides,
    ...(adaptiveToken
      ? {
          adaptiveToken,
          relevance,
          guardrails,
          toolTrimConfig: () => adaptive.current(),
          // Selection acts only through the legacy `messages.transform` hook, so the probe gates it
          // like relevance (docs/V2-HOOKS.md).
          selectionPolicy: () => {
            const config = adaptive.current()
            return {
              ...config.selection,
              enabled:
                config.enabled && config.selection.enabled && runtimeProbe.capabilities().canTransformMessages,
            }
          },
        }
      : {}),
    holdoutFraction: () => adaptive.current().holdout.fraction,
    compactionAnchors: () => {
      const config = adaptive.current()
      return config.enabled && config.compaction.anchors
    },
  })
  const server = Bun.serve({
    port: options.port ?? Number(process.env.FLUPCODE_HARNESS_PORT ?? 4097),
    hostname,
    // The extension's WebSocket is the one request answered before the `/harness/*` routes.
    fetch: (request, bunServer) =>
      bridge && new URL(request.url).pathname === SOCKET_PATH ? bridge.socket(request, bunServer) : handler(request),
    // Nothing is upgraded without the bridge, so its absence never meets a socket.
    websocket: bridge?.websocket ?? { message: (socket) => socket.close() },
  })
  // Background work starts only once the port is bound: a harness that fails to bind throws above
  // with no scheduler, sweep, learning pass or timer left running behind it. The handler cannot see
  // a request before these synchronous starts finish.
  purge()
  const sweep = setInterval(() => {
    repository.removeExpiredArtifacts()
    repository.pruneEvents(EVENTS_KEPT)
    // Checkpoints past their run's newest few, or of a run that is gone (TI-15), and the refs that kept
    // their commits. A folder that cannot be reached leaves its refs for git, never the server down.
    void dropAll(repository.removeStaleCheckpoints())
    purge()
    // The metrics dedupe ledger only has to outlive a redelivery (AH-B01).
    repository.pruneSessionMetricSeen(Date.now() - 2 * 24 * 60 * 60 * 1000)
    // A forecast reads a week of quota samples; a month is kept.
    repository.pruneQuotaSamples(Date.now() - 30 * 24 * 60 * 60 * 1000)
  }, 60 * 60 * 1000)
  scheduler.start()
  // After the scheduler started, so a run it recovered as failed is swept and backfilled.
  episodes.start()
  // The shadow's backstop: a restart cannot see the close callbacks it missed, so terminal episodes
  // without a decision are swept on the same boundary cadence as the episodes themselves.
  shadow.start()
  labeler.start()
  learning.start()
  // The usage ledger converges on what the engine kept (UL-03): every session at the first pass, which
  // is also the one-time backfill, then each session that went idle since.
  const usage = createUsageReconciler({
    repository,
    engine: scheduler.engine,
    classify: usagePricing.classify,
    onStored: (sessionID) => scheduler.checkBudgets([sessionID]),
  })
  usage.start()
  quotas.start()
  void runtimeProbe.refresh()
  const probeInterval = setInterval(() => void runtimeProbe.refresh(), runtimeConfig.ttlMs)
  return {
    server,
    repository,
    scheduler,
    ...(browser ? { browser } : {}),
    ...(actions ? { actions } : {}),
    ...(vault ? { vault } : {}),
    runtimeProbe,
    decisions,
    egress,
    modelKeys: { keys, slots: keySlots },
    stop: async () => {
      clearInterval(sweep)
      clearInterval(probeInterval)
      usage.stop()
      quotas.stop()
      learning?.stop()
      shadow.stop()
      labeler.stop()
      episodes.stop()
      scheduler.stop()
      await browserAttach?.stop().catch(() => undefined)
      await bridgeAttach?.stop().catch(() => undefined)
      bridge?.stop()
      await browser?.stop().catch(() => undefined)
      repository.close()
      server.stop()
    },
  }
}

/**
 * The browser runtime, or none.
 *
 * `FLUPCODE_BROWSER_DISABLED=1` is the kill switch WA-3 relies on: with it, no runtime is built and
 * `/harness/browser/*` falls through to the ordinary 404. Without a token the same is true: the
 * surface is only open when there is a secret to guard it (WA-1). The token itself is read apart, so
 * it still guards the artifact routes even when there is no runtime to guard (WA-9).
 */
const browserFrom = (
  options: HarnessServerOptions,
  repository: SqliteRoutineRepository,
): RecipeDriver | undefined => {
  if (process.env.FLUPCODE_BROWSER_DISABLED === "1") return undefined
  const token = options.browserToken ?? readBrowserToken(options.browserTokenFile ?? browserTokenFile())
  if (!token) return undefined
  // Which browser to drive (WA-9): an explicit path, then the environment, then the Chromium that
  // ships with the app, and finally the system's Chrome.
  const executablePath = resolveBrowserExecutable({
    option: options.browserExecutablePath,
    env: process.env.FLUPCODE_BROWSER_EXECUTABLE_PATH,
  })
  return createRecipeDriver({
    repository,
    ...(options.browserDataDir ? { dataDir: options.browserDataDir } : {}),
    ...(executablePath ? { executablePath } : {}),
    ...(options.browserIdleTimeoutMs ? { idleTimeoutMs: options.browserIdleTimeoutMs } : {}),
    egress: createEgressGuard(),
  })
}

const createBrowserToken = (): string | undefined => {
  // The desktop that also shows the live view generates the token and sends it, so both sides
  // compare the same secret; on its own the harness creates one as before (WA-6).
  const fromEnv = process.env.FLUPCODE_BROWSER_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    return readOrCreateBrowserToken(browserTokenFile())
  } catch (cause) {
    console.warn(`Could not write the browser token: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

// The engine plugins' bearer (TI-10). The desktop does not pass it to the engine: the plugins read
// this file, so a variable in the engine's environment does not hand an agent's shell a key.
const createPluginToken = (): string | undefined => {
  const fromEnv = process.env.FLUPCODE_PLUGIN_TOKEN?.trim()
  if (fromEnv) return fromEnv
  try {
    return readOrCreatePluginToken(pluginTokenFile())
  } catch (cause) {
    console.warn(`Could not write the plugin token: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

// The remote host's bearer (HE-02). Only in its file, never in an environment: the hosts read it there.
const createRemoteToken = (): string | undefined => {
  try {
    return readOrCreateRemoteToken(remoteTokenFile())
  } catch (cause) {
    console.warn(`Could not write the remote token: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

/**
 * The acting line's dedicated secret (FH-04, ADR-0022).
 *
 * The harness owns it: the desktop never generates or propagates it, and there is **no** environment
 * override — the ADR fixes the token to the file alone, so the shared file keeps it out of the
 * children's env. A read-only config directory leaves the line inert rather than stopping the server.
 */
const createAdaptiveToken = (): string | undefined => {
  try {
    return readOrCreateAdaptiveToken(adaptiveTokenFile())
  } catch (cause) {
    console.warn(`Could not write the adaptive token: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

/**
 * The key the desktop injected, when it is one, and otherwise the file this process owns.
 *
 * The desktop sends `FLUPCODE_VAULT_KEY` on the platforms where `safeStorage` holds it, so the
 * harness opens the same vault. macOS (and any machine without a usable keychain) sends nothing,
 * and the entrypoint creates its own file. A read-only config directory starts without a vault.
 */
const createVaultKey = (): string | undefined => {
  const fromEnv = process.env.FLUPCODE_VAULT_KEY
  if (parseVaultKey(fromEnv)) return fromEnv
  try {
    return readOrCreateVaultKeyFile(vaultKeyFile())
  } catch (cause) {
    console.warn(`Could not write the vault key: ${cause instanceof Error ? cause.message : String(cause)}`)
    return undefined
  }
}

// The desktop's explicit 1.x import runs through this binary and exits; it never starts the server.
if (import.meta.main && process.argv[2] === "engine-data") process.exit(runEngineDataCommand(process.argv.slice(3)))

if (import.meta.main) {
  // Only here, and not in `createHarnessServer`: a test that builds a server would otherwise write
  // template files into whatever home directory it is running in. That is how fixtures ended up in
  // somebody's real routines once already.
  const seeded = seedTemplates()
  if (seeded.length > 0) console.log(`Wrote workflow templates: ${seeded.join(", ")}`)
  // The entrypoint is the one place that writes the secret; a read-only config dir must not stop
  // the harness from serving everything else, so it starts without a browser instead.
  const token = createBrowserToken()
  const pluginToken = createPluginToken()
  const remoteToken = createRemoteToken()
  const vaultKey = createVaultKey()
  // The acting line's secret is only ever created on a loopback host (ADR-0022 §1): off the loopback
  // the feature is inert, so the entrypoint must not leave the dedicated token on disk either. The
  // resolved host matches the one `createHarnessServer` uses (no explicit hostname is passed here).
  const hostname = process.env.FLUPCODE_HARNESS_HOST ?? "127.0.0.1"
  const adaptiveToken = isLoopbackHostname(hostname) ? createAdaptiveToken() : undefined
  const app = createHarnessServer({
    ...(token ? { browserToken: token } : {}),
    ...(pluginToken ? { pluginToken } : {}),
    ...(remoteToken ? { remoteToken } : {}),
    ...(vaultKey ? { vaultKey } : {}),
    ...(adaptiveToken ? { adaptiveToken } : {}),
    pairing: createPairing(),
  })
  console.log(`FlupCode harness server listening on ${app.server.url}`)
  // Playwright swallows SIGTERM, so without this the browser outlives the server that owns it.
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    void app.stop().then(() => process.exit(0))
  }
  process.on("SIGTERM", shutdown)
  process.on("SIGINT", shutdown)
}
