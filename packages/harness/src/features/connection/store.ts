import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { RemoteHostState } from "@flupcode/remote"
import { detectEngine, openCodeV2Locked } from "@flupcode/remote/engine-kind"
import { createResource } from "../../resource"
import {
  createClient,
  createHarnessClient,
  engineTargetVersion,
  type HistoryImportStatus,
  probeServer,
  resolveHarnessServerUrl,
  resolveServerUrl,
} from "../../client"
import { STORAGE_KEYS, readStorage, writeStorage } from "../../storage"
import { t } from "../../i18n"
import { toast } from "../../toast"
import { restorePairing } from "../../pairing"
import { desktopRemote, remote, remoteBaseUrl } from "../../remote"
import { publishSessionEvent } from "../../session-events"
import { reachabilityUrl } from "../../engine/v2"
import { annotateLocalNetwork, askLocalNetwork, engineFetch } from "../../transport"
import {
  addressSpaceOf,
  localNetworkGated,
  localNetworkPermissions,
  queryLocalNetworkPermission,
  type LocalNetworkState,
} from "../../local-network"
import type { AppStores } from "../../app-context"

export function createConnection(app: AppStores) {
  const [localServerUrl, setLocalServerUrl] = createSignal(readStorage(STORAGE_KEYS.serverUrl, resolveServerUrl()))
  const [serverInput, setServerInput] = createSignal(localServerUrl())
  const [localHarnessServerUrl] = createSignal(readStorage(STORAGE_KEYS.harnessServerUrl, resolveHarnessServerUrl()))
  const serverUrl = () => {
    const host = remote.activeHost()
    return host ? remoteBaseUrl(host.hostId) : localServerUrl()
  }
  const harnessServerUrl = () => localHarnessServerUrl()
  // A tab paired earlier trades its refresh cookie for a token before the first harness read (HE-01).
  // Not over remote control: the computer's host calls the harness for the phone (HE-02).
  if (!remote.activeHost()) void restorePairing(harnessServerUrl())
  // The desktop app hosts remote control; tracking its bridge keeps the top bar honest about the
  // relay connection instead of showing the local engine's "Connected".
  const [hostRemote, setHostRemote] = createSignal<RemoteHostState>()
  createEffect(() => {
    const bridge = desktopRemote()
    if (!bridge) return
    void bridge.state().then(setHostRemote)
    onCleanup(bridge.onChange(setHostRemote))
  })
  const hostRemotePill = () => {
    const state = hostRemote()
    if (!desktopRemote() || !state) return undefined
    return {
      name: state.hostName,
      connected: state.enabled && state.connection === "online",
      onOpen: () => app.router.setRemoteOpen(true),
    }
  }

  const client = () => createClient(serverUrl())
  // Chrome's Local Network Access (H-45). A web page reaching an engine on the machine is gated
  // behind a permission the user grants once per site, and the wrong handling of it once took the
  // hosted app off its engine (#91, reverted in #92). Here it is asked for on purpose: the health
  // check waits for the answer, and calls are only annotated once the permission exists.
  const localNetworkEngine = createMemo(() => {
    const engine = addressSpaceOf(serverUrl())
    const page = typeof window === "undefined" ? undefined : addressSpaceOf(window.location.origin)
    return localNetworkGated(page, engine) ? engine : undefined
  })
  const [localNetwork, setLocalNetwork] = createSignal<LocalNetworkState>("unsupported")
  const [localNetworkReady, setLocalNetworkReady] = createSignal(false)
  createEffect(() => {
    const engine = localNetworkEngine()
    annotateLocalNetwork(undefined)
    if (!engine) {
      setLocalNetwork("unsupported")
      setLocalNetworkReady(true)
      return
    }
    setLocalNetworkReady(false)
    void queryLocalNetworkPermission(localNetworkPermissions(engine)).then((state) => {
      setLocalNetwork(state)
      if (state === "granted") annotateLocalNetwork(engine)
      setLocalNetworkReady(true)
    })
  })
  const [allowingLocalNetwork, setAllowingLocalNetwork] = createSignal(false)
  /**
   * Ask for the permission from the click that started this.
   *
   * The prompt only appears while a connection to a local destination is being made, and only if it
   * succeeds, so the question is a request to the engine itself. A granted answer lets that very
   * request through, which is why its response is worth treating as the permission.
   */
  const allowLocalNetwork = async () => {
    const engine = localNetworkEngine()
    if (!engine) return
    setAllowingLocalNetwork(true)
    try {
      const asked = await askLocalNetwork(reachabilityUrl(serverUrl()), engine)
      if (asked) annotateLocalNetwork(engine)
      setLocalNetwork(await queryLocalNetworkPermission(localNetworkPermissions(engine)))
    } finally {
      setAllowingLocalNetwork(false)
      void refetchHealth()
    }
  }
  // Never reject: an errored resource throws on every read and freezes the effects that depend on it.
  // When the health call fails, a `no-cors` probe tells a stopped engine apart from one the browser
  // blocked (CORS, mixed content, Local Network Access), so the onboarding can explain the right fix.
  // It waits for the local network answer (H-45) so a granted browser is not probed unannotated.
  const [health, { refetch: refetchHealth }] = createResource(
    () => (localNetworkReady() ? serverUrl() : undefined),
    async (url) => {
      const result = await createClient(url)
        .health.get()
        .catch(() => ({ healthy: false, version: undefined as string | undefined }))
      if (result.healthy) return { ...result, legacy: false, blocked: false, authRequired: false }
      // An OpenCode 1.x engine answers, which FlupCode no longer drives: said apart from a stopped one
      // so the banner can tell the reader to start OpenCode 2 instead (ADR-0027).
      const detected = await detectEngine(url, engineFetch)
      if (detected.kind === "v1")
        return { healthy: false, version: detected.version, legacy: true, blocked: false, authRequired: false }
      // 2.x always runs behind a password and a browser page has no way to send one: only the desktop
      // app or `flupcode serve`, which sign in for the page, can drive it.
      if (await openCodeV2Locked(url, engineFetch))
        return { ...result, legacy: false, blocked: false, authRequired: true }
      const status = await probeServer(url)
      return {
        ...result,
        legacy: false,
        blocked: status === "blocked",
        authRequired: status === "unauthorized",
      }
    },
  )
  // The engine answers but refuses the call: it was started with `OPENCODE_SERVER_PASSWORD`, and a
  // browser page has no credentials to send (only the desktop app injects any). Named apart from a
  // stopped engine so the banner can point at the fix instead of "start it".
  // An engine or harness server the desktop app is restarting, or gave up on (HE-03): its own banner
  // says so, in place of the "start it" one, which is meant for a browser tab.
  const [childTrouble, setChildTrouble] = createSignal(false)
  const serverAuthRequired = () => health()?.authRequired === true
  // A memo, not a plain accessor: the health poll writes a fresh resource value every 10s, and a
  // plain accessor would pass that on to every effect and resource source reading it — dropping and
  // reopening the event streams, and refetching sessions, messages and both blocked registries, on
  // a clock, forever. Only a change of the answer is worth waking anything for.
  const ready = createMemo(() => health()?.healthy === true)
  /**
   * Whether the local network permission can still be what is holding this page back.
   *
   * A blocked call is not proof that the permission is missing: an engine that does not allow this
   * origin fails the same way, and so does mixed content. Asking again for one the browser already
   * granted — or one it does not gate at all — answers nothing, so the banner would keep offering a
   * button that cannot work while never naming the `--cors` the engine actually needs. Declared
   * after `health`: a memo reads its sources as soon as it is created.
   */
  const localNetworkAsking = createMemo(
    () =>
      Boolean(localNetworkEngine() && health()?.blocked) &&
      (localNetwork() === "prompt" || localNetwork() === "denied"),
  )
  // OpenCode 2 importing the 1.x history it was given (V2-61): it runs once, when the engine starts,
  // and until it finishes those sessions are missing from the list. Asked while it runs, then no more.
  const [historyImport, setHistoryImport] = createSignal<HistoryImportStatus>()
  createEffect(() => {
    const url = serverUrl()
    if (!ready()) return setHistoryImport(undefined)
    let stopped = false
    onCleanup(() => {
      stopped = true
    })
    const ask = async () => {
      const status = await createClient(url)
        .migration.status()
        .catch(() => undefined)
      if (stopped) return
      const wasRunning = historyImport()?.status === "running"
      setHistoryImport(status?.status === "running" || status?.status === "error" ? status : undefined)
      if (status?.status === "running") return void setTimeout(ask, 1500)
      if (wasRunning) publishSessionEvent({ kind: "changed" })
    }
    void ask()
  })
  // The engine's own version against the pin this build was made for (ADR-0027): an OpenCode 2 started
  // some other way may be another release.
  const engineVersionMismatch = () => {
    const reported = health()?.version
    return !!reported && !!engineTargetVersion && reported !== engineTargetVersion
  }

  createEffect(() => {
    const timer = setInterval(() => {
      void refetchHealth()
      if (ready() && (app.catalog.models()?.data?.length ?? 0) === 0) void app.catalog.refetchModels()
    }, 10000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (remote.status() === "connected") void refetchHealth()
  })

  createEffect(() => {
    if (!ready()) return
    void app.sessions.refetchSessions()
    void app.catalog.refetchModels()
    void app.catalog.refetchModelDirectory()
    void app.catalog.refetchProviderDirectory()
  })
  const serverStatus = () =>
    health.loading ? t("Connecting") : health()?.healthy === true ? t("Connected") : t("Offline")
  const [enginePaths] = createResource(
    () => (ready() ? serverUrl() : undefined),
    (url) =>
      createClient(url)
        .paths()
        .catch(() => undefined),
  )
  const chatsDirectory = () => enginePaths()?.state
  // What the server says it can answer (H-18). The client can be newer than the server it talks to
  // — a dev frontend against a packaged sidecar — and asking for a route it does not have is a 404
  // in every browser console. `/harness/health` lists them; an older server lists none.
  const [harnessCapabilities, setHarnessCapabilities] = createSignal<string[]>([])
  createEffect(() => {
    const url = harnessServerUrl()
    if (!url) return
    void createHarnessClient(url)
      .health()
      .then((health) => setHarnessCapabilities(health.capabilities ?? []))
      .catch(() => setHarnessCapabilities([]))
  })
  const supports = (capability: string) => harnessCapabilities().includes(capability)
  /** The config-files listing is the harness server's own, and only a recent one advertises it. */
  const configFilesAvailable = () => !!harnessServerUrl() && supports("config-files")
  // Bumped when the reader asks the engine to reload. The engine re-reads its configuration then, so
  // the resources that carry it — the agent, skill and command lists (the catalog store) — must be
  // asked again.
  const [serverReload, setServerReload] = createSignal(0)
  const [serverReloading, setServerReloading] = createSignal(false)
  // A new engine process rereads its configuration, and the agent, command and skill lists are cached
  // under the server URL, so they must be asked again when it comes back. `ready` moving to true is
  // that signal: it only changes when the health poll's answer does.
  let wasReady = false
  createEffect(() => {
    const now = ready()
    if (now && !wasReady) setServerReload((count) => count + 1)
    wasReady = now
  })

  const commitServer = () => {
    const next = serverInput().trim()
    if (!next) return
    if (remote.activeHost()) remote.disconnect()
    setLocalServerUrl(next)
    writeStorage(STORAGE_KEYS.serverUrl, next)
  }

  /**
   * Ask the engine to drop its cached instances, so agents and skills written since it started
   * take effect. It disposes every instance, so turns in flight are dropped: the button asks for a
   * second click first, and the whole fleet of lists is reread once it is done.
   */
  const reloadEngine = async () => {
    if (serverReloading()) return
    setServerReloading(true)
    // The engine disposes the very instance that serves this session, so its reply cannot arrive
    // while the app is attached: the request stays open and the promise never settles. The dispose
    // itself is uninterruptible and does run, so ask, do not wait for the answer, and reread the
    // lists once the engine has had a moment to drop the old instances.
    void createClient(serverUrl())
      .reload()
      .catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 2500))
    setServerReload((count) => count + 1)
    app.catalog.setAgentsRefresh((count) => count + 1)
    await Promise.allSettled([
      refetchHealth(),
      app.sessions.refetchSessions(),
      app.catalog.refetchModels(),
      app.catalog.refetchModelDirectory(),
      app.catalog.refetchProviderDirectory(),
    ])
    setServerReloading(false)
    toast(t("Engine reloaded"), "success")
  }
  return {
    allowLocalNetwork,
    allowingLocalNetwork,
    chatsDirectory,
    childTrouble,
    client,
    commitServer,
    configFilesAvailable,
    enginePaths,
    engineVersionMismatch,
    harnessCapabilities,
    harnessServerUrl,
    health,
    historyImport,
    hostRemotePill,
    localNetwork,
    localNetworkAsking,
    localNetworkReady,
    ready,
    refetchHealth,
    reloadEngine,
    serverAuthRequired,
    serverInput,
    serverReload,
    serverReloading,
    serverStatus,
    serverUrl,
    setChildTrouble,
    setServerInput,
    setServerReload,
    supports,
  }
}

export type ConnectionStore = ReturnType<typeof createConnection>
