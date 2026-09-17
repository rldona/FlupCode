import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { RemoteHostState } from "@flupcode/remote"
import { createResource } from "./resource"
import { createReconciledList } from "./reconciled"
import { screenFromPath, urlForScreen, type Screen } from "./screen"
import { ChangesPanel, type DiffMode } from "./components/ChangesPanel"
import { UsagePanel } from "./components/UsagePanel"
import { AgentsPanel } from "./components/AgentsPanel"
import { SkillCatalogue } from "./components/SkillCatalogue"
import { ContextPanel, type ContextTokens } from "./components/ContextPanel"
import type { TaskActivity, TouchedFiles } from "./types"
import type {
  PermissionV2Request,
  QuestionV2Request,
  SessionMessageAssistant,
  SessionMessageInfo,
} from "./engine-types"
import {
  createClient,
  createHarnessClient,
  engineTargetVersion,
  invalidateLegacyHistory,
  probeEngineProfile,
  probeServer,
  resolveHarnessServerUrl,
  resolveServerUrl,
} from "./client"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"
import { activityByDay, comparison, computeMetrics, contextFigures, filterByRange, type UsageRange } from "./metrics"
import { usageResetAt } from "./usage-reset"
import {
  SUGGESTION_SESSION_TTL,
  SUGGESTION_SYSTEM,
  buildSuggestionPrompt,
  cleanSuggestion,
  isSuggestionSession,
  pickSuggestionModel,
} from "./reply-suggestion"
import { promptHistory, recordPrompt } from "./prompt-history"
import { modelSwitchWarningOn, needsModelSwitchWarning, rememberModelSwitch } from "./model-switch"
import { hasModel, replacementModel } from "./model-catalog"
import { CHAT_PERMISSION, CHAT_SYSTEM, isChatSession, type AppView } from "./chat"
import { messageID } from "./ids"
import { sessionTitle } from "./session-title"
import {
  applyDelta,
  applyMessage,
  applyTranscriptChange,
  applyPart,
  removeMessage,
  removePart,
  type LegacyInfo,
  type LegacyPart,
} from "./transcript"
import { pendingPrompts, type Delivery } from "./pending-prompts"
import { browser, isLocalPreview } from "./browser"
import type { ModelInfo } from "./engine-types"
import type {
  Artifact,
  Attachment,
  CommandOption,
  McpConfig,
  ProjectItem,
  Routine,
  RoutineInput,
  RoutineRun,
  Run,
  Task,
  Workflow,
  StashedPrompt,
} from "./types"
import { UNAVAILABLE_FEATURES } from "./features"
import { getLocale, setLocale, t, type Locale } from "./i18n"
import { ImagePreview } from "./image-preview"
import { Toaster, clearToast, toast } from "./toast"
import { SIDEBAR_WIDTH_DEFAULT, Sidebar } from "./components/Sidebar"
import { About } from "./components/About"
import { Topbar } from "./components/Topbar"
import { HomeCanvas } from "./components/HomeCanvas"
import { Composer } from "./components/Composer"
import { PermissionDock, type PermissionReply } from "./components/PermissionDock"
import { QuestionDock } from "./components/QuestionDock"
import { CommandPalette } from "./components/CommandPalette"
import { SessionView } from "./components/SessionView"
import { SessionActions, SessionTitle } from "./components/SessionToolbar"
import { SubagentList } from "./components/SubagentList"
import { CONTEXT_PANEL_WIDTH, RightAside } from "./components/RightAside"
import { WORKSPACE_WIDTH_DEFAULT, WorkspacePanels } from "./components/WorkspacePanels"
import { McpManager } from "./components/McpManager"
import { ModelPicker } from "./components/ModelPicker"
import { ModelSwitchDialog } from "./components/ModelSwitchDialog"
import { ModelUnavailableDock } from "./components/ModelUnavailableDock"
import { FolderDialog } from "./components/FolderDialog"
import { RenameDialog } from "./components/RenameDialog"
import { permissionMode } from "./permission-modes"
import { ProvidersPanel } from "./components/ProvidersPanel"
import { StashDialog } from "./components/StashDialog"
import { SettingsPanel } from "./components/SettingsPanel"
import { RoutinesPanel } from "./components/RoutinesPanel"
import { RunsPanel } from "./components/RunsPanel"
import { Onboarding } from "./components/Onboarding"
import { RemotePanel } from "./components/RemotePanel"
import { ArtifactsPanel } from "./components/ArtifactsPanel"
import { SkillsPanel } from "./components/SkillsPanel"
import { MemoryPanel } from "./components/MemoryPanel"
import { ConfigPanel } from "./components/ConfigPanel"
import { desktopRemote, remote, remoteBaseUrl, touchDevice } from "./remote"
import { RemoteHome, type RemoteSessionItem } from "./components/RemoteHome"
import { MobileComposer } from "./components/MobileComposer"
import { ChatHero, ChatStarters } from "./components/ChatHome"
import { SessionPane } from "./components/SessionPane"
import { PanelBoundary } from "./components/PanelBoundary"
import { closePane, keepExisting, openInSplit, showInFocusedPane } from "./split"
import { publishSessionEvent } from "./session-events"
import { engineFetch } from "./transport"
import { normalizeRoutineSchedule } from "./routine-schedule"

type Client = ReturnType<typeof createClient>

// The FlupCode palette is the default, so anything unknown falls back to it. "default" was the
// neutral palette's id before it was renamed to "classic".
function readColorTheme() {
  const saved = readStorage<string>(STORAGE_KEYS.colorTheme, "flupcode")
  if (saved === "classic" || saved === "default") return "classic"
  if (saved === "sublime") return "sublime"
  if (saved === "sublime-dark") return "sublime-dark"
  return "flupcode"
}

const BUILTIN_COMMANDS: Array<{ name: string; descriptionKey: string }> = [
  { name: "new", descriptionKey: "New session…" },
  { name: "compact", descriptionKey: "Compact the current session" },
  { name: "steps", descriptionKey: "Show or hide tool steps" },
  { name: "mcp", descriptionKey: "MCP servers…" },
  { name: "stash", descriptionKey: "Save the current prompt" },
  { name: "stashes", descriptionKey: "View saved prompts" },
  { name: "skills", descriptionKey: "Skills" },
  { name: "memory", descriptionKey: "Memory" },
  { name: "config", descriptionKey: "Config (advanced)" },
  { name: "settings", descriptionKey: "Customize FlupCode" },
  { name: "routines", descriptionKey: "Scheduled tasks" },
  { name: "remote", descriptionKey: "Remote control / mobile" },
  { name: "artifacts", descriptionKey: "Artifacts" },
  { name: "about", descriptionKey: "About FlupCode" },
]

const normalizeRoutine = (value: unknown): Routine | undefined => {
  if (!value || typeof value !== "object") return undefined
  const item = value as Record<string, unknown>
  if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.prompt !== "string") return undefined
  const legacyInterval =
    typeof item.intervalMinutes === "number" && Number.isFinite(item.intervalMinutes) && item.intervalMinutes > 0
      ? Math.max(1, Math.round(item.intervalMinutes))
      : 60
  const schedule = normalizeRoutineSchedule(item.schedule, legacyInterval)
  const rawModel = item.model
  const model =
    rawModel && typeof rawModel === "object" && "providerID" in rawModel && "id" in rawModel &&
    typeof rawModel.providerID === "string" && typeof rawModel.id === "string"
      ? {
          providerID: rawModel.providerID,
          id: rawModel.id,
          variant: "variant" in rawModel && typeof rawModel.variant === "string" ? rawModel.variant : undefined,
        }
      : undefined
  const runs = Array.isArray(item.runs)
    ? item.runs.flatMap((run) => {
        if (!run || typeof run !== "object") return []
        const entry = run as Record<string, unknown>
        if (typeof entry.id !== "string" || typeof entry.startedAt !== "number") return []
        const status =
          entry.status === "success" || entry.status === "failed" || entry.status === "stopped"
            ? entry.status
            : "failed"
        return [
          {
            id: entry.id,
            sessionID: typeof entry.sessionID === "string" ? entry.sessionID : undefined,
            status,
            startedAt: entry.startedAt,
            finishedAt: typeof entry.finishedAt === "number" ? entry.finishedAt : undefined,
            error:
              typeof entry.error === "string"
                ? entry.error
                : status === "failed"
                  ? t("Run interrupted")
                  : undefined,
          } satisfies RoutineRun,
        ]
      })
    : []
  return {
    id: item.id,
    name: item.name,
    description: typeof item.description === "string" ? item.description : "",
    prompt: item.prompt,
    schedule,
    projectDirectory: typeof item.projectDirectory === "string" ? item.projectDirectory : undefined,
    agent: typeof item.agent === "string" ? item.agent : undefined,
    model,
    enabled: item.enabled !== false,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
    lastRunAt: typeof item.lastRunAt === "number" ? item.lastRunAt : undefined,
    runs,
  }
}

const normalizeRoutines = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        const routine = normalizeRoutine(item)
        return routine ? [routine] : []
      })
    : []

export const App: Component = () => {
  const [localServerUrl, setLocalServerUrl] = createSignal(readStorage(STORAGE_KEYS.serverUrl, resolveServerUrl()))
  const [serverInput, setServerInput] = createSignal(localServerUrl())
  const [localHarnessServerUrl] = createSignal(
    readStorage(STORAGE_KEYS.harnessServerUrl, resolveHarnessServerUrl()),
  )
  const serverUrl = () => {
    const host = remote.activeHost()
    return host ? remoteBaseUrl(host.hostId) : localServerUrl()
  }
  const harnessServerUrl = () => localHarnessServerUrl()
  const [selected, setSelected] = createSignal<string | undefined>(
    // Phones controlling a computer always start on the sessions home, not the last open session.
    touchDevice && !desktopRemote() && remote.activeHost()
      ? undefined
      : readStorage<string>(STORAGE_KEYS.selectedSession, "") || undefined,
  )
  const [prompt, setPrompt] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [routineBusy, setRoutineBusy] = createSignal(false)
  const [routineBusyID, setRoutineBusyID] = createSignal<string>()
  const [routineRunID, setRoutineRunID] = createSignal<string>()
  const [streamedChars, setStreamedChars] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal(readStorage(STORAGE_KEYS.sidebarCollapsed, false))
  const [contextHidden, setContextHidden] = createSignal(readStorage(STORAGE_KEYS.contextPanelHidden, false))
  const [contextWidth, setContextWidth] = createSignal(
    readStorage(STORAGE_KEYS.contextPanelWidth, CONTEXT_PANEL_WIDTH.default),
  )
  const [narrow, setNarrow] = createSignal(typeof window !== "undefined" && window.innerWidth < 768)
  // Phones controlling a computer get their own layout: a sessions home and a focused session screen.
  const mobileRemote = () => touchDevice && !desktopRemote() && !!remote.activeHost()
  const [mobileComposing, setMobileComposing] = createSignal(false)
  // Run state from the event stream; it takes precedence over the last activity snapshot.
  const [runState, setRunState] = createSignal<Record<string, boolean>>({})
  const [activityTick, setActivityTick] = createSignal(0)
  // Whether the engine's event streams are carrying this session's run right now. The health check
  // is a separate question: it can answer while a stream is a dead socket nobody noticed. There is
  // one state per stream — the global one and one per folder being followed — because a folder
  // stream that died takes the transcript with it while the global one goes on looking healthy.
  type StreamState = "connecting" | "live" | "reconnecting"
  const [streamStates, setStreamStates] = createSignal<Record<string, StreamState>>({})
  const setStreamState = (source: string, state: StreamState) =>
    setStreamStates((current) => (current[source] === state ? current : { ...current, [source]: state }))
  const forgetStreamState = (source: string) => setStreamStates(({ [source]: _dropped, ...rest }) => rest)
  /** The worst state of them all: the reader is told the app is behind if any stream is. */
  const streamState = (): StreamState => {
    const states = Object.values(streamStates())
    if (states.includes("reconnecting")) return "reconnecting"
    if (states.length === 0 || states.includes("connecting")) return "connecting"
    return "live"
  }
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // Assigned further down, where the refetches live. A turn ending is the moment the transcript is
  // worth reconciling against the engine, and the only one.
  let turnEnded: (sessionID: string) => void = () => undefined
  const setRunning = (sessionID: string, running: boolean) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.delete(sessionID)
    const wasRunning = runState()[sessionID] === true
    setRunState((state) => (state[sessionID] === running ? state : { ...state, [sessionID]: running }))
    // The moment a session stops working is the only safe one to hand it a prompt that was waiting:
    // anything sent earlier is swallowed by the turn still running. See pending-prompts.ts.
    if (wasRunning && !running) {
      pendingPrompts.release(sessionID, expandPastes, serverUrl())
      turnEnded(sessionID)
    }
  }
  // A new message starts a new run: until its first event arrives, the transcript decides.
  const forgetRun = (sessionID: string) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.delete(sessionID)
    setRunState(({ [sessionID]: _, ...rest }) => rest)
  }
  // A v2 run is many steps, and the next one only starts once the model streams again, so a step's end
  // says nothing about the run; nor does anything arrive when a run is stopped between steps. While a
  // run goes on, ask the engine whether it still lists the session as active.
  const watchRun = (sessionID: string, delay: number) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.set(
      sessionID,
      setTimeout(async () => {
        const active = await createClient(serverUrl())
          .session.active()
          .catch(() => undefined)
        if (!idleTimers.has(sessionID)) return
        if (!active?.has(sessionID)) return setRunning(sessionID, false)
        setRunState((state) => (state[sessionID] ? state : { ...state, [sessionID]: true }))
        watchRun(sessionID, 2000)
      }, delay),
    )
  }
  const trackActivity = (type: string, data: { sessionID?: string; status?: { type?: string } } | undefined) => {
    const sessionID = data?.sessionID
    if (!sessionID) return
    if (type === "session.next.prompted" || type === "session.next.step.started") {
      setRunState((state) => (state[sessionID] ? state : { ...state, [sessionID]: true }))
      return watchRun(sessionID, 2000)
    }
    if (type === "session.next.step.ended" || type === "session.next.step.failed") return watchRun(sessionID, 700)
    // Legacy runs (chats) report their own status, which already spans every step.
    const status = data?.status?.type
    if (status === "busy" || status === "retry") setRunning(sessionID, true)
    if (type === "session.idle" || status === "idle") setRunning(sessionID, false)
  }
  const [pinned, setPinned] = createSignal(readStorage<string[]>(STORAGE_KEYS.pinnedSessions, []))
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>(
    readStorage<Record<string, boolean>>(STORAGE_KEYS.expandedProjects, {}),
  )
  const [sidebarWidth, setSidebarWidth] = createSignal(readStorage(STORAGE_KEYS.sidebarWidth, SIDEBAR_WIDTH_DEFAULT))
  const [agent, setAgent] = createSignal(readStorage(STORAGE_KEYS.agent, "plan"))
  const [permissionModeId, setPermissionModeId] = createSignal(readStorage(STORAGE_KEYS.permissionMode, "auto"))
  // Steering is the engine's own default, so a prompt sent mid-turn redirects the work in flight
  // unless the reader says to wait; see DeliveryMenu.
  const [delivery, setDelivery] = createSignal<Delivery>(readStorage<Delivery>(STORAGE_KEYS.delivery, "steer"))
  const changeDelivery = (value: Delivery) => {
    setDelivery(value)
    writeStorage(STORAGE_KEYS.delivery, value)
  }
  const [panels, setPanels] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.workspacePanels, []))
  const [workspaceWidth, setWorkspaceWidth] = createSignal(
    readStorage(STORAGE_KEYS.workspaceWidth, WORKSPACE_WIDTH_DEFAULT),
  )
  const [displayName, setDisplayName] = createSignal(readStorage(STORAGE_KEYS.displayName, ""))
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [modelRef, setModelRef] = createSignal<{ providerID: string; id: string; variant?: string } | undefined>(
    readStorage<{ providerID: string; id: string; variant?: string } | undefined>(
      STORAGE_KEYS.selectedModel,
      undefined,
    ),
  )
  const [noFolderSessions, setNoFolderSessions] = createSignal<string[]>(
    readStorage<string[]>(STORAGE_KEYS.noFolderSessions, []),
  )
  const [modelPickerOpen, setModelPickerOpen] = createSignal(false)
  const [pendingModelSwitch, setPendingModelSwitch] = createSignal<{
    from: string
    to: string
    next: { providerID: string; id: string }
  }>()
  const [favorites, setFavorites] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.favoriteModels, []))
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [aboutOpen, setAboutOpen] = createSignal(false)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  /** A routine the sidebar asked the screen to open on, cleared once it has. */
  const [routineFocus, setRoutineFocus] = createSignal<string>()
  const [showTools, setShowTools] = createSignal(true)
  // The model's thinking stays out of the conversation unless it is asked for, as in Claude Code.
  const [showReasoning, setShowReasoning] = createSignal(readStorage(STORAGE_KEYS.showReasoning, false))
  const toggleReasoning = () => {
    const next = !showReasoning()
    setShowReasoning(next)
    writeStorage(STORAGE_KEYS.showReasoning, next)
  }
  const [mcpOpen, setMcpOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  // Which full screen is open, and where in the URL it lives, so a reload comes back to it and the
  // browser's Back leaves it. One signal rather than a flag per screen: only one can be open, and
  // two flags could disagree.
  const [screen, setScreen] = createSignal<Screen | undefined>(screenFromPath(window.location.pathname))
  const showScreen = (next: Screen | undefined) => {
    if (screen() === next) return
    setScreen(next)
    window.history.pushState(null, "", urlForScreen(next, window.location))
  }
  const routinesOpen = () => screen() === "routines"
  const runsOpen = () => screen() === "runs"
  const artifactsOpen = () => screen() === "artifacts"
  const changesOpen = () => screen() === "changes"
  const usageOpen = () => screen() === "usage"
  const contextOpen = () => screen() === "context"
  const agentsOpen = () => screen() === "agents"
  const skillsScreenOpen = () => screen() === "skills"
  /** Leave whatever screen is open. Doing anything with a session means leaving it. */
  const leaveScreen = () => showScreen(undefined)
  createEffect(() => {
    const follow = () => setScreen(screenFromPath(window.location.pathname))
    window.addEventListener("popstate", follow)
    onCleanup(() => window.removeEventListener("popstate", follow))
  })
  const [remoteOpen, setRemoteOpen] = createSignal(false)
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
      onOpen: () => setRemoteOpen(true),
    }
  }
  const [providersOpen, setProvidersOpen] = createSignal(false)
  const [folderOpen, setFolderOpen] = createSignal(false)

  const [skillsOpen, setSkillsOpen] = createSignal(false)
  const [memoryOpen, setMemoryOpen] = createSignal(false)
  const [configOpen, setConfigOpen] = createSignal(false)
  const [notifications, setNotifications] = createSignal(readStorage(STORAGE_KEYS.notifications, false))
  const [paletteKey, setPaletteKey] = createSignal(readStorage(STORAGE_KEYS.paletteKey, "mod+k"))
  const [targetDirectory, setTargetDirectory] = createSignal<string>()
  const [routines, setRoutines] = createSignal<Routine[]>(normalizeRoutines(readStorage<unknown>(STORAGE_KEYS.routines, [])))
  /** How many runs the supervisor shows. Enough to see what is happening, not a history. */
  const RUNS_SHOWN = 20
  const [runs, setRuns] = createSignal<Run[]>([])
  const [routinesServerAvailable, setRoutinesServerAvailable] = createSignal(false)
  const [routinesServerLoading, setRoutinesServerLoading] = createSignal(false)
  createEffect(() => writeStorage(STORAGE_KEYS.routines, routines()))
  const [onboarded, setOnboarded] = createSignal(readStorage(STORAGE_KEYS.onboarded, false))
  const [theme, setTheme] = createSignal(readStorage(STORAGE_KEYS.theme, "system"))
  const [colorTheme, setColorTheme] = createSignal(readColorTheme())
  /** The desktop window whose title bar this page replaces. Not Linux, which keeps its own frame. */
  const desktopWindow = () => typeof window !== "undefined" && window.flupcode?.ownsTitleBar === true
  // Windows paints its own window buttons over the strip, and cannot read the page's palette. It is
  // told, whenever the palette or the light/dark choice changes, in the colours actually computed.
  createEffect(() => {
    theme()
    colorTheme()
    const set = window.flupcode?.setTitleBar
    if (!set || window.flupcode?.platform !== "win32") return
    const styles = getComputedStyle(document.documentElement)
    const color = styles.getPropertyValue("--fc-sidebar").trim()
    const symbolColor = styles.getPropertyValue("--fc-text").trim()
    if (color && symbolColor) void set({ color, symbolColor }).catch(() => undefined)
  })
  const [stashOpen, setStashOpen] = createSignal(false)
  const [renameTarget, setRenameTarget] = createSignal<{ id: string; title: string }>()
  const [stashes, setStashes] = createSignal<StashedPrompt[]>(
    readStorage<StashedPrompt[]>(STORAGE_KEYS.stashedPrompts, []),
  )

  const client = () => createClient(serverUrl())
  // Never reject: an errored resource throws on every read and freezes the effects that depend on it.
  // When the health call fails, a `no-cors` probe tells a stopped engine apart from one the browser
  // blocked (CORS, mixed content), so the onboarding can explain the right fix.
  const [health, { refetch: refetchHealth }] = createResource(serverUrl, async (url) => {
    const result = await createClient(url)
      .health.get()
      .catch(() => ({ healthy: false, version: undefined as string | undefined }))
    if (result.healthy) return { ...result, blocked: false }
    return { ...result, blocked: (await probeServer(url)) === "blocked" }
  })
  // A memo, not a plain accessor: the health poll writes a fresh resource value every 10s, and a
  // plain accessor would pass that on to every effect and resource source reading it — dropping and
  // reopening the event streams, and refetching sessions, messages and both blocked registries, on
  // a clock, forever. Only a change of the answer is worth waking anything for.
  const ready = createMemo(() => health()?.healthy === true)
  // Only probed once the engine answers, so the onboarding can tell FlupCode's build from the
  // stock OpenCode CLI, whose extras (Copilot sign-in, permission modes, memory) are missing.
  const [engineProfile] = createResource(
    () => (ready() ? serverUrl() : undefined),
    (url) => probeEngineProfile(url),
  )
  // `/global/health` reports the engine's own version. "local" is a source build (FlupCode's own),
  // so only a released version is compared against the one this UI was generated from.
  const engineVersionMismatch = () => {
    const reported = health()?.version
    return !!reported && reported !== "local" && !!engineTargetVersion && reported !== engineTargetVersion
  }

  createEffect(() => {
    const timer = setInterval(() => {
      void refetchHealth()
      if (ready() && (models()?.data?.length ?? 0) === 0) void refetchModels()
    }, 10000)
    onCleanup(() => clearInterval(timer))
  })

  createEffect(() => {
    if (remote.status() === "connected") void refetchHealth()
  })

  createEffect(() => {
    if (!ready()) return
    void refetchSessions()
    void refetchModels()
    void refetchModelDirectory()
    void refetchProviderDirectory()
  })
  const serverStatus = () =>
    health.loading ? t("Connecting") : health()?.healthy === true ? t("Connected") : t("Offline")
  const [sessions, { refetch: refetchSessions }] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).session.list(),
  )
  // Reply suggestions run in throwaway child sessions that are never shown.
  const sessionList = () => sessions()?.data?.filter((session) => !isSuggestionSession(session))
  const selectedSession = () => sessionList()?.find((session) => session.id === selected())
  // Chat / Code tabs. Chats are sessions in the engine's state folder; see chat.ts.
  const [view, setView] = createSignal<AppView>(readStorage<AppView>(STORAGE_KEYS.view, "code"))
  const chatView = () => view() === "chat"
  // Each tab keeps its own open session, keyed by the session's kind, so leaving a tab and coming
  // back lands on the session that was active instead of that tab's home.
  const [openSessions, setOpenSessions] = createSignal<Partial<Record<AppView, string>>>({})
  const [enginePaths] = createResource(
    () => (ready() ? serverUrl() : undefined),
    (url) =>
      createClient(url)
        .paths()
        .catch(() => undefined),
  )
  const chatsDirectory = () => enginePaths()?.state
  const isChat = (session: { location?: { directory?: string } } | undefined) =>
    !!session && isChatSession(session, chatsDirectory())
  const viewSessions = () => sessionList()?.filter((session) => isChat(session) === chatView())
  const changeView = (next: AppView) => {
    leaveScreen()
    if (next === view()) return
    const leaving = selected()
    setView(next)
    writeStorage(STORAGE_KEYS.view, next)
    const candidate = openSessions()[next]
    const sessionsList = sessionList()
    // Before the list loads there is nothing to validate against, so trust the remembered session.
    if (candidate && (!sessionsList || sessionsList.some((session) => session.id === candidate))) {
      setSelected(candidate)
      setTargetDirectory(undefined)
      setMobileComposing(false)
      return
    }
    // No session to return to: this tab starts from its home.
    if (leaving) {
      setSelected(undefined)
      setTargetDirectory(undefined)
      setMobileComposing(false)
    }
  }
  // Remember the open session under its own kind, so a tab switch can restore it.
  createEffect(() => {
    if (!chatsDirectory()) return
    const session = selectedSession()
    if (session) {
      const kind: AppView = isChat(session) ? "chat" : "code"
      setOpenSessions((previous) => (previous[kind] === session.id ? previous : { ...previous, [kind]: session.id }))
      return
    }
    // A selected id that is not in the list yet (loading, stale) must not erase the memory.
    if (selected()) return
    const kind = untrack(view)
    setOpenSessions((previous) => (previous[kind] === undefined ? previous : { ...previous, [kind]: undefined }))
  })
  // Opening a session from anywhere (palette, history, a notification) shows its tab.
  createEffect(() => {
    const session = selectedSession()
    if (!session || !chatsDirectory()) return
    const kind: AppView = isChat(session) ? "chat" : "code"
    if (kind !== untrack(view)) {
      setView(kind)
      writeStorage(STORAGE_KEYS.view, kind)
    }
  })
  // The Build/Plan switch follows the open session's agent. `untrack` keeps the effect from
  // fighting the optimistic update when the reader picks an agent in the dock.
  createEffect(() => {
    const next = selectedSession()?.agent
    if (!next || next === untrack(agent)) return
    setAgent(next)
  })
  const modelLocation = () => targetDirectory() ?? selectedSession()?.location?.directory
  /**
   * The processes this project has written down (H-21).
   *
   * Keyed by the folder as well as the server: a repository's own workflows win over the shared
   * ones, so the list is different depending on where the session is working.
   */
  const [workflows] = createResource(
    () => `${harnessServerUrl()}\n${modelLocation() ?? ""}`,
    async (key) => {
      const [url = "", directory = ""] = key.split("\n")
      return createHarnessClient(url)
        .workflows.list(directory || undefined)
        .catch(() => [] as Workflow[])
    },
  )
  const workflowNamed = (name: string) => (workflows() ?? []).find((workflow) => workflow.name === name)

  /** What the runs left behind (H-14), for the project this session is working in. */
  const [artifactList, setArtifactList] = createSignal<Artifact[]>([])
  const refreshArtifacts = async () => {
    const directory = modelLocation()
    const list = await createHarnessClient(harnessServerUrl())
      .artifacts.list(directory ? { directory } : {})
      .catch(() => undefined)
    if (list) setArtifactList(list)
  }
  createEffect(() => {
    harnessServerUrl()
    modelLocation()
    void refreshArtifacts()
  })

  const removeArtifact = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .artifacts.remove(id)
      .then(() => setArtifactList(artifactList().filter((artifact) => artifact.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  const [models, { refetch: refetchModels }] = createResource(
    () => (ready() ? `${serverUrl()}::${modelLocation() ?? ""}` : undefined),
    (key) => {
      const separator = key.lastIndexOf("::")
      const url = key.slice(0, separator)
      const directory = key.slice(separator + 2)
      return createClient(url).model.list(directory ? { location: { directory } } : undefined)
    },
  )
  const [modelDirectory, { refetch: refetchModelDirectory }] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).model.directory(),
  )
  const [lastModels, setLastModels] = createSignal<ModelInfo[]>([])
  createEffect(() => {
    const data = models()?.data
    if (data && data.length > 0) setLastModels(data)
  })
  const modelList = createMemo(() => {
    const data = models()?.data
    return data && data.length > 0 ? data : lastModels()
  })
  const [agents] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).agent.list(),
  )
  const [skills] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).skill.list(),
  )
  const [mcp, { refetch: refetchMcp }] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).mcp.list(),
  )
  const [providerDirectory, { refetch: refetchProviderDirectory }] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).provider.directory(),
  )
  const [providerAuth] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).provider.auth(),
  )
  const [commands] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).command.list(),
  )
  const [integrations, { refetch: refetchIntegrations }] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).integration.list(),
  )
  createEffect(() => {
    if (!providersOpen()) return
    void refetchProviderDirectory()
    void refetchIntegrations()
  })
  // Providers whose key lives in the engine's configuration but is not a v2 credential yet. Copying
  // them used to happen on its own on every load, which sent every key through the page (and, while
  // remote-controlling, to the phone). Now the providers panel offers it and the reader asks for it.
  const [unlinkedProviders, { refetch: refetchUnlinkedProviders }] = createResource(
    () => (ready() && providersOpen() ? serverUrl() : undefined),
    async (url) => createClient(url).provider.unlinked(),
  )
  const linkConfiguredKeys = () =>
    void run(async (current) => {
      await current.provider.linkConfiguredKeys()
      void refetchUnlinkedProviders()
      void refetchProviderDirectory()
      void refetchIntegrations()
      void refetchModels()
      return undefined
    }, t("Keys from the engine's configuration are connected"))

  const vcsDirectory = () => targetDirectory() ?? selectedSession()?.location?.directory
  const vcsKey = () => {
    const directory = vcsDirectory()
    return ready() && directory ? `${serverUrl()}::${directory}` : undefined
  }
  const vcsTarget = (key: string) => {
    const separator = key.lastIndexOf("::")
    return { url: key.slice(0, separator), directory: key.slice(separator + 2) }
  }
  const [vcsInfo, { refetch: refetchVcsInfo }] = createResource(vcsKey, (key) => {
    const target = vcsTarget(key)
    return createClient(target.url).vcs.get(target.directory)
  })
  const [vcsStatus, { refetch: refetchVcsStatus }] = createResource(vcsKey, (key) => {
    const target = vcsTarget(key)
    return createClient(target.url).vcs.status(target.directory)
  })
  const vcsTotals = () => {
    const files = vcsStatus() ?? []
    return files.reduce(
      (sum, file) => ({ additions: sum.additions + file.additions, deletions: sum.deletions + file.deletions }),
      { additions: 0, deletions: 0 },
    )
  }
  // The diff viewer's own read (H-06). It is kept apart from the status above on purpose: the status
  // is two numbers in the composer and is refetched all through a turn, while a patch is only worth
  // asking for while somebody has the screen open — which is what the key checks first.
  //
  // A string key, for the reason written against `blockedSource`: an object source is a new object
  // on every reactive read, and this one would refetch a whole diff each time.
  const [diffMode, setDiffMode] = createSignal<DiffMode>("git")
  const changesKey = () => {
    const directory = vcsDirectory()
    if (!changesOpen() || !ready() || !directory) return undefined
    return `${serverUrl()}\n${directory}\n${diffMode()}`
  }
  const [changes, { refetch: refetchChanges }] = createResource(changesKey, (key) => {
    const [url = "", directory = "", mode = "git"] = key.split("\n")
    return createClient(url).vcs.diff(directory, { mode: mode as DiffMode })
  })
  const openChanges = () => {
    showScreen("changes")
    void refetchChanges()
  }
  // What the running tasks are doing, and what the finished ones changed (H-12).
  //
  // Two different clocks on purpose. Activity changes by the second and is polled while the screen
  // is open and something is running; the files a task touched are settled the moment it ends, so
  // they are read once per run and again when the run's shape changes.
  const [doingTick, setDoingTick] = createSignal(0)
  const goingRuns = () => runs().filter((run) => run.status === "running").map((run) => run.id)
  const activityKey = () => {
    if (!runsOpen() || !routinesServerAvailable() || goingRuns().length === 0) return undefined
    return `${harnessServerUrl()}\n${goingRuns().join(",")}\n${doingTick()}`
  }
  const [taskActivity] = createResource(activityKey, async (key) => {
    const [url = "", ids = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const lists = await Promise.all(ids.split(",").map((id) => client.runs.activity(id).catch(() => undefined)))
    const byTask: Record<string, TaskActivity> = {}
    for (const list of lists) for (const entry of list ?? []) byTask[entry.taskID] = entry
    return byTask
  })
  createEffect(() => {
    if (!activityKey()) return
    // Read once the request has landed, so the clock is between answers rather than on top of them.
    taskActivity()
    const timer = setTimeout(() => setDoingTick((tick) => tick + 1), 3000)
    onCleanup(() => clearTimeout(timer))
  })

  const touchedKey = () => {
    if (!runsOpen() || !routinesServerAvailable()) return undefined
    const shape = runs()
      .map((run) => `${run.id}:${run.tasks?.length ?? 0}:${run.status}`)
      .join("|")
    return shape ? `${harnessServerUrl()}\n${shape}` : undefined
  }
  const [touched] = createResource(touchedKey, async (key) => {
    const [url = "", shape = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const ids = shape.split("|").map((entry) => entry.split(":")[0]!)
    const lists = await Promise.all(ids.map((id) => client.runs.files(id).catch(() => undefined)))
    const byTask: Record<string, TouchedFiles> = {}
    for (const list of lists) for (const entry of list ?? []) if (entry.taskID) byTask[entry.taskID] = entry
    return byTask
  })

  // What the runs cost (H-16). Read only while the screen is open: it is an aggregation over every
  // task ever recorded, and nothing else on screen needs it.
  const [usageDays, setUsageDays] = createSignal<number | undefined>(30)
  const [usageOnlyProject, setUsageOnlyProject] = createSignal(false)
  const usageKey = () => {
    if (!usageOpen() || !routinesServerAvailable()) return undefined
    const directory = usageOnlyProject() ? (vcsDirectory() ?? "") : ""
    return `${harnessServerUrl()}\n${directory}\n${usageDays() ?? 0}`
  }
  const [usage] = createResource(usageKey, (key) => {
    const [url = "", directory = "", days = "0"] = key.split("\n")
    return createHarnessClient(url).usage({ directory: directory || undefined, days: Number(days) || undefined })
  })

  // What the model was given (H-17). The instruction files come from the harness server, which can
  // read the disk; the rest is the engine's own answer about this folder.
  const contextKey = () => {
    const directory = vcsDirectory()
    if (!contextOpen() || !directory || !routinesServerAvailable()) return undefined
    return `${harnessServerUrl()}\n${directory}`
  }
  const [contextReport] = createResource(contextKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).context.get({ directory })
  })
  const readInstruction = (path: string) =>
    createHarnessClient(harnessServerUrl())
      .context.file({ directory: vcsDirectory() ?? "", path })
      .then((answer) => {
        if (!answer) throw new Error(t("Could not read that file"))
        return answer.content
      })
  // Skills (H-27). The files come from the harness server, including the ones the engine did not
  // load — which the engine, by definition, cannot report.
  const [skillsRefresh, setSkillsRefresh] = createSignal(0)
  const skillFilesKey = () => {
    if (!skillsScreenOpen() || !routinesServerAvailable()) return undefined
    return `${harnessServerUrl()}\n${vcsDirectory() ?? ""}\n${skillsRefresh()}`
  }
  const [skillFiles] = createResource(skillFilesKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).skills.list(directory ? { directory } : {})
  })
  const readSkillFile = (path: string) =>
    createHarnessClient(harnessServerUrl())
      .skills.file({ path, ...(vcsDirectory() ? { directory: vcsDirectory()! } : {}) })
      .then((answer) => {
        if (!answer) throw new Error(t("Could not read that file"))
        return answer.content
      })
  const saveSkill = async (draft: { name: string; scope: "global" | "project"; description: string; body: string }) => {
    const directory = vcsDirectory()
    await createHarnessClient(harnessServerUrl()).skills.save({ ...draft, ...(directory ? { directory } : {}) })
    setSkillsRefresh((count) => count + 1)
  }
  const deleteSkillFile = async (path: string) => {
    const directory = vcsDirectory()
    await createHarnessClient(harnessServerUrl()).skills.remove({ path, ...(directory ? { directory } : {}) })
    setSkillsRefresh((count) => count + 1)
  }
  /**
   * The agents this folder has, for the screen that is about this folder's agent files.
   *
   * Not `agents()`: that one asks `/api/agent`, which answers for wherever the engine was opened
   * rather than for the folder it is given — measured against the local engine. The rest of the app
   * still uses it, and that is its own ticket.
   */
  const folderAgentsKey = () => (agentsOpen() && ready() ? `${serverUrl()}\n${vcsDirectory() ?? ""}` : undefined)
  const [folderAgents] = createResource(folderAgentsKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createClient(url).agent.listFor(directory || undefined)
  })
  /** `provider/model`, which is how an agent file names one. */
  const agentModels = createMemo(() => modelList().map((model) => `${model.providerID}/${model.id}`))
  // Agents you can edit (H-13). The files come from the harness server, which can read the disk;
  // what exists comes from the engine, which reports more than there are files.
  const agentFilesKey = () => {
    if (!agentsOpen() || !routinesServerAvailable()) return undefined
    return `${harnessServerUrl()}\n${vcsDirectory() ?? ""}\n${agentsRefresh()}`
  }
  const [agentsRefresh, setAgentsRefresh] = createSignal(0)
  const [agentFiles] = createResource(agentFilesKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).agents.list(directory ? { directory } : {})
  })
  const saveAgent = async (draft: {
    name: string
    scope: "global" | "project"
    fields: Record<string, unknown>
    prompt: string
  }) => {
    const directory = vcsDirectory()
    await createHarnessClient(harnessServerUrl()).agents.save({ ...draft, ...(directory ? { directory } : {}) })
    setAgentsRefresh((count) => count + 1)
  }
  const deleteAgent = async (path: string) => {
    const directory = vcsDirectory()
    await createHarnessClient(harnessServerUrl()).agents.remove({ path, ...(directory ? { directory } : {}) })
    setAgentsRefresh((count) => count + 1)
  }
  const toolsKey = () => ((contextOpen() || agentsOpen()) && ready() ? serverUrl() : undefined)
  const [engineTools] = createResource(toolsKey, (url) => createClient(url).tools())
  /**
   * What this session's window actually holds.
   *
   * The engine reports these five and no more, so five is what is shown. Inventing a
   * "system prompt" slice out of the difference would be a number nobody measured.
   */
  const contextTokens = (): ContextTokens | undefined => {
    const tokens = selectedSession()?.tokens
    if (!tokens) return undefined
    return {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
    }
  }
  /** How many times this session has been compacted, counted from its own transcript. */
  const compactions = () => {
    const held = messages()
    const list = Array.isArray(held) ? held : (held?.data ?? [])
    return list.filter((message) => {
      const entry = message as { summary?: boolean; info?: { summary?: boolean } }
      return entry.summary === true || entry.info?.summary === true
    }).length
  }

  // Findings (H-32). Read alongside the diff, since that is where they are shown.
  const [findingsTick, setFindingsTick] = createSignal(0)
  const findingsKey = () => {
    const directory = vcsDirectory()
    if (!changesOpen() || !directory || !routinesServerAvailable()) return undefined
    return `${harnessServerUrl()}\n${directory}\n${findingsTick()}`
  }
  const [findings] = createResource(findingsKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).findings.list({ directory })
  })
  const resolveFinding = (id: string, resolved: boolean) => {
    void createHarnessClient(harnessServerUrl())
      .findings.resolve(id, resolved)
      .then(() => setFindingsTick((tick) => tick + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // Checkpoints (H-15). Listed only while the screen is open, and re-read whenever one is taken or
  // a restore lands, because a restore records one of its own.
  const [checkpointTick, setCheckpointTick] = createSignal(0)
  const [checkpointBusy, setCheckpointBusy] = createSignal(false)
  const checkpointKey = () => {
    const directory = vcsDirectory()
    if (!changesOpen() || !directory || !routinesServerAvailable()) return undefined
    return `${harnessServerUrl()}\n${directory}\n${checkpointTick()}`
  }
  const [checkpoints] = createResource(checkpointKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).checkpoints.list(directory)
  })
  const checkpointPlan = (id: string) =>
    createHarnessClient(harnessServerUrl())
      .checkpoints.plan(id)
      .then((plan) => {
        if (!plan) throw new Error(t("Could not work out what would change"))
        return plan
      })
  const restoreCheckpoint = (id: string) => {
    setCheckpointBusy(true)
    void createHarnessClient(harnessServerUrl())
      .checkpoints.restore(id)
      .then((done) => {
        const plan = done?.plan
        toast(
          t("Restored: {written} rewritten, {removed} deleted", {
            written: plan?.write.length ?? 0,
            removed: plan?.remove.length ?? 0,
          }),
          "success",
        )
        setCheckpointTick((tick) => tick + 1)
        void refetchChanges()
        void refetchVcsStatus()
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setCheckpointBusy(false))
  }
  const takeCheckpoint = (title: string) => {
    const directory = vcsDirectory()
    if (!directory) return
    setCheckpointBusy(true)
    void createHarnessClient(harnessServerUrl())
      .checkpoints.take({ directory, title })
      .then(() => setCheckpointTick((tick) => tick + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setCheckpointBusy(false))
  }
  const removeCheckpoint = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .checkpoints.remove(id)
      .then(() => setCheckpointTick((tick) => tick + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const changesError = () => {
    const failure = changes.error as unknown
    if (!failure) return undefined
    return failure instanceof Error ? failure.message : String(failure)
  }
  // Blocked work is read from the runtime that raised it: every turn runs on the legacy runner, and
  // the v2 registries answer empty for it, which is what left an agent waiting on a question no dock
  // could show. Sessions that still hold a v2 request from before are merged in by id.
  //
  // A string, not an object. The session list is refetched all through a turn and hands back fresh
  // objects every time, so a source built out of `selectedSession()` changed identity on each one
  // and both registries, in both runtimes, were asked again. Measured against a running turn: 93
  // requests for permissions and questions in thirty seconds, for events nobody had raised.
  const blockedSource = () => {
    const sessionID = selected()
    if (!ready() || !sessionID) return undefined
    return `${serverUrl()}\n${sessionID}\n${selectedSession()?.location?.directory ?? ""}`
  }
  const blockedTarget = (key: string) => {
    const [url = "", sessionID = "", directory = ""] = key.split("\n")
    return { url, sessionID, directory: directory || undefined }
  }
  const [permissions, { refetch: refetchPermissions }] = createResource(blockedSource, async (key) => {
    const source = blockedTarget(key)
    const engine = createClient(source.url)
    const [legacy, v2] = await Promise.all([
      engine.blocked.permissions({ directory: source.directory, sessionID: source.sessionID }).catch(() => []),
      engine.session.permission.list({ sessionID: source.sessionID }).then(
        (result) => result.data ?? [],
        () => [],
      ),
    ])
    const seen = new Set(legacy.map((request) => request.id))
    return { data: [...legacy, ...v2.filter((request) => !seen.has(request.id))] }
  })
  const [questions, { refetch: refetchQuestions }] = createResource(blockedSource, async (key) => {
    const source = blockedTarget(key)
    const engine = createClient(source.url)
    const [legacy, v2] = await Promise.all([
      engine.blocked.questions({ directory: source.directory, sessionID: source.sessionID }).catch(() => []),
      engine.session.question.list({ sessionID: source.sessionID }).then(
        (result) => result.data ?? [],
        () => [],
      ),
    ])
    const seen = new Set(legacy.map((request) => request.id))
    return { data: [...legacy, ...v2.filter((request) => !seen.has(request.id))] }
  })
  // Every session's pending permissions, not just the open one's. An agent waiting on one is silent
  // and looks idle, so without this the reader has no way to know another session is stuck.
  const [blocked, { refetch: refetchBlocked }] = createResource(
    // A string again: `watchedDirectories()` builds a new array every time the session list moves.
    () => (ready() ? [serverUrl(), ...watchedDirectories()].join("\n") : undefined),
    async (key) => {
      const [url = "", ...folders] = key.split("\n")
      const source = { url, folders }
      const engine = createClient(source.url)
      // Both runtimes again, and the legacy registry is per folder: a question counts as blocked work
      // just as much as a permission does, and both were invisible from anywhere but their session.
      const perFolder = await Promise.all(
        source.folders.map((directory) =>
          Promise.all([
            engine.blocked.permissions({ directory }).catch(() => []),
            engine.blocked.questions({ directory }).catch(() => []),
          ]),
        ),
      )
      const v2 = await engine.permission.pending().then(
        (result) => result.data ?? [],
        () => [],
      )
      return { data: [...perFolder.flat(2), ...v2] }
    },
  )
  const blockedSessions = () => [...new Set((blocked()?.data ?? []).map((request) => request.sessionID))]
  const blockedElsewhere = () => blockedSessions().filter((id) => id !== selected())

  // What "Allow always" wrote. The engine applies these to every session in the project, so they
  // only become reviewable once something lists them.
  const [savedPermissions, { refetch: refetchSavedPermissions }] = createResource(
    () => (ready() && settingsOpen() ? serverUrl() : undefined),
    async (url) => createClient(url).permission.saved.list(),
  )
  const revokePermission = (id: string) =>
    void run(async (current) => {
      await current.permission.saved.remove({ id })
      void refetchSavedPermissions()
      return undefined
    }, t("Permission revoked"))

  const [messages, { refetch: refetchMessages }] = createResource(
    () => {
      const sessionID = selected()
      return ready() && sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    async (source) => {
      const result = await createClient(source.url).message.list({ sessionID: source.sessionID, order: "asc" })
      return { sessionID: source.sessionID, data: result.data, cursor: result.cursor }
    },
  )
  // A refetch that fails keeps the last value, so the view stays usable but stops being the truth.
  // Say so, with a way to try again, until one succeeds: before this, a transcript could sit there
  // for as long as the engine was away without ever admitting it had stopped following the run.
  const STALE_TOAST = "stale-transcript"
  createEffect(() => {
    const failure = messages.failure() ?? sessions.failure()
    if (!failure) return clearToast(STALE_TOAST)
    toast(t("FlupCode is not following the engine right now"), "error", {
      key: STALE_TOAST,
      action: {
        label: t("Try again"),
        run: () => {
          void refetchMessages()
          void refetchSessions()
        },
      },
    })
  })

  // Resources hand back fresh objects on every refetch while a run streams. These stores merge the
  // new payloads by id so the transcript, the tool groups and the question dock keep their mounted
  // state (an opened tool, a half-typed "Other" answer) instead of being rebuilt under the reader.
  const [messageData, setMessageData] = createStore<{ sessionID?: string; data: SessionMessageInfo[] }>({ data: [] })
  const permissionData = createReconciledList<PermissionV2Request>(() => permissions()?.data)
  const questionData = createReconciledList<QuestionV2Request>(() => questions()?.data)

  createEffect(() => {
    const value = messages()
    setMessageData(reconcile({ sessionID: value?.sessionID, data: value?.data ?? [] }, { key: "id" }))
  })

  const activeMessages = () => {
    if (messageData.sessionID !== selected()) return undefined
    return messageData.data
  }
  const messagesLoading = () => messages.loading || (selected() !== undefined && messages()?.sessionID !== selected())
  const generating = () => {
    if (busy()) return true
    // The run state spans every step of a turn; the transcript alone looks finished between steps.
    const running = runState()[selected() ?? ""]
    if (running !== undefined) return running
    const list = activeMessages() ?? []
    const last = list[list.length - 1]
    if (!last) return false
    if (last.type === "user") return true
    if (last.type !== "assistant") return false
    const time = (last as { time?: { completed?: number } }).time
    return time !== undefined && time.completed === undefined
  }
  /**
   * The model the selected session is cached for: what the engine reuses on the next turn. It is
   * stored on the session when this app switches it, and older sessions only say it on their answers.
   */
  const sessionModel = (): { providerID: string; id: string } | undefined => {
    const stored = selectedSession()?.model
    if (stored) return stored
    const list = activeMessages() ?? []
    for (let index = list.length - 1; index >= 0; index--) {
      const message = list[index]
      if (message?.type === "assistant") return (message as SessionMessageAssistant).model
    }
    return undefined
  }
  // Suggested next message (greyed in the input, Tab accepts), generated by a small model after
  // each finished turn. See reply-suggestion.ts and client.suggest.
  const [suggestionsOn, setSuggestionsOn] = createSignal(readStorage(STORAGE_KEYS.replySuggestions, true))
  const [suggestion, setSuggestion] = createSignal<{ sessionID: string; text: string }>()
  const [suggestionModel, setSuggestionModel] = createSignal(readStorage(STORAGE_KEYS.suggestionModel, ""))
  let suggestedFor: string | undefined
  let suggestionRun = 0
  createEffect(() => {
    const sessionID = selected()
    // Only prompts and answers matter; model switches and other markers are skipped.
    const list = (activeMessages() ?? []).filter((message) => message.type === "user" || message.type === "assistant")
    const last = list[list.length - 1]
    if (!sessionID || generating() || !suggestionsOn() || mobileRemote() || prompt()) {
      if (generating() || !sessionID) setSuggestion(undefined)
      return
    }
    if (!last || last.type !== "assistant" || last.id === suggestedFor) return
    if (permissionData.length > 0 || questionData.length > 0) return
    let userIndex = list.length - 1
    while (userIndex >= 0 && list[userIndex]?.type !== "user") userIndex--
    const userText = ((list[userIndex] as { text?: string } | undefined)?.text ?? "").trim()
    const assistantText = list
      .slice(userIndex + 1)
      .flatMap((message) => (message.type === "assistant" ? (message as SessionMessageAssistant).content : []))
      .flatMap((part) => (part.type === "text" ? [(part as { text?: string }).text ?? ""] : []))
      .join("\n")
      .trim()
    if (!userText || !assistantText) return
    const lastID = last.id
    const directory = selectedSession()?.location?.directory
    const timer = setTimeout(() => {
      suggestedFor = lastID
      const run = ++suggestionRun
      void (async () => {
          const client = createClient(serverUrl())
          // A model picked in Settings wins; otherwise the configured or a cheap small model.
          const chosen = suggestionModel()
          const slash = chosen.indexOf("/")
          const model =
            slash > 0
              ? { providerID: chosen.slice(0, slash), id: chosen.slice(slash + 1) }
              : pickSuggestionModel(await client.suggest.smallModel().catch(() => undefined), modelRef(), modelList())
          if (!model) return
          const raw = await client.suggest
            .reply({
              parentID: sessionID,
              directory,
              model,
              system: SUGGESTION_SYSTEM,
              prompt: buildSuggestionPrompt(userText, assistantText),
            })
            .catch(() => undefined)
          const text = cleanSuggestion(raw)
          if (!text || run !== suggestionRun || selected() !== sessionID || prompt() || generating()) return
          setSuggestion({ sessionID, text })
        })()
      }, 800)
      onCleanup(() => clearTimeout(timer))
    })
    const currentSuggestion = () => {
      const value = suggestion()
      return value && value.sessionID === selected() && !prompt() ? value.text : undefined
    }
    const toggleSuggestions = () => {
      const next = !suggestionsOn()
      setSuggestionsOn(next)
      writeStorage(STORAGE_KEYS.replySuggestions, next)
      if (!next) setSuggestion(undefined)
    }

    const liveUsage = () => {
      const list = activeMessages() ?? []
      const last = list[list.length - 1]
      if (last?.type === "assistant") {
        const assistant = last as SessionMessageAssistant
        if (assistant.tokens) return { tokens: assistant.tokens, cost: assistant.cost }
      }
      const chars = streamedChars()
      if (chars <= 0) return undefined
      return { tokens: { input: 0, output: Math.ceil(chars / 4), reasoning: 0 }, cost: undefined }
    }
    const contextUsage = () =>
      contextFigures(selectedSession(), activeMessages() ?? [], modelList(), currentModel()?.limit?.context ?? 0)

    const generationStartedAt = () => {
      const list = activeMessages() ?? []
      const last = list[list.length - 1]
      if (last?.type === "user") return (last as { time?: { created?: number } }).time?.created
      if (last?.type === "assistant") return (last as SessionMessageAssistant).time?.created
      return undefined
    }
    const [children] = createResource(
      () => {
        const sessionID = selected()
        return ready() && sessionID ? { url: serverUrl(), sessionID } : undefined
      },
      async (source) => createClient(source.url).session.children({ sessionID: source.sessionID }),
    )
    const subagents = () => children()?.data?.filter((session) => !isSuggestionSession(session))

    // A tab closed while a suggestion ran leaves its session behind: delete those once they are stale.
    const removedSuggestions = new Set<string>()
    createEffect(() => {
      if (!ready()) return
      const stale = [...(sessions()?.data ?? []), ...(children()?.data ?? [])].filter(
        (session) =>
          isSuggestionSession(session) &&
          Date.now() - session.time.created > SUGGESTION_SESSION_TTL &&
          !removedSuggestions.has(session.id),
      )
      if (stale.length === 0) return
      const current = createClient(serverUrl())
      for (const session of stale) {
        removedSuggestions.add(session.id)
        void current.session.remove({ sessionID: session.id }).catch(() => undefined)
      }
    })

    const allTodos = () => {
      const data = activeMessages() ?? []
      const assistants = [...data].reverse().flatMap((message) => (message.type === "assistant" ? [message] : []))
      for (const message of assistants) {
        const parts = [...message.content]
          .reverse()
          .flatMap((part) => (part.type === "tool" && part.name === "todowrite" ? [part] : []))
        for (const part of parts) {
          const raw = (part.state.input as { todos?: unknown }).todos
          if (!Array.isArray(raw)) continue
          return raw.flatMap((item) => {
            if (!item || typeof item !== "object") return []
            const content = (item as { content?: unknown }).content
            const status = (item as { status?: unknown }).status
            if (typeof content !== "string") return []
            return [{ content, status: typeof status === "string" ? status : "pending" }]
          })
        }
      }
      return []
    }

    // Completed tasks the reader removed from the context panel, per session. The engine keeps the
    // model's todo list, so removal only hides them here.
    const [clearedTodos, setClearedTodos] = createSignal<Record<string, string[]>>(
      readStorage(STORAGE_KEYS.clearedTodos, {}),
    )
    const todos = () => {
      const cleared = clearedTodos()[selected() ?? ""] ?? []
      return allTodos().filter((todo) => !(todo.status === "completed" && cleared.includes(todo.content)))
    }
    const clearTodos = (contents: string[]) => {
      const sessionID = selected()
      if (!sessionID) return
      const next = { ...clearedTodos(), [sessionID]: [...new Set([...(clearedTodos()[sessionID] ?? []), ...contents])] }
      setClearedTodos(next)
      writeStorage(STORAGE_KEYS.clearedTodos, next)
    }

    const commandOptions = (): CommandOption[] => [
      ...BUILTIN_COMMANDS.map((command) => ({
        name: command.name,
        description: t(command.descriptionKey),
        disabled: UNAVAILABLE_FEATURES.has(command.name),
      })),
      ...(commands()?.data ?? []).map((command) => ({ name: command.name, description: command.description })),
      ...(skills()?.data ?? []).map((skill) => ({ name: skill.name, description: skill.description ?? "Skill" })),
      // A workflow is a command: that is the audit's "launcher unificado", and the reason it goes in
      // the same list rather than a menu of its own.
      ...(workflows() ?? []).map((workflow) => ({
        name: workflow.name,
        description: workflow.description || t("Workflow"),
      })),
    ]

    const pastes = new Map<string, string>()

    const collapsePaste = (raw: string) => {
      const lines = raw.split("\n").length
      const token = `[Pasted ~${lines} lines]`
      pastes.set(token, raw)
      return token
    }

    const expandPastes = (value: string) => {
      let result = value
      for (const [token, full] of pastes) result = result.split(token).join(full)
      return result
    }

    // Prompts shown before the engine projects their message, reconciled by id once it does. The ones
    // sent while a turn was already running offer "Send now".
    const pendingForSession = () =>
      pendingPrompts.forSession(selected(), activeMessages() ?? [], expandPastes, serverUrl())

    // Once a real message replaces its optimistic prompt, forget it so the list cannot grow.
    createEffect(() => pendingPrompts.reconcile(new Set((activeMessages() ?? []).map((message) => message.id))))

    const searchFiles = async (query: string) => {
      const response = await createClient(serverUrl()).file.find({ query, limit: 8 })
      return response.data
    }

    const runCommand = (name: string) => {
      if (UNAVAILABLE_FEATURES.has(name)) {
        toast(t("Coming soon"), "info")
        return
      }
      if (name === "new" || name === "clear") {
        newSession()
        return
      }
      if (name === "about") {
        setAboutOpen(true)
        return
      }
      if (name === "mcp") {
        setMcpOpen(true)
        return
      }
      if (name === "stash") {
        stashPrompt(prompt(), true)
        return
      }
      if (name === "stashes") {
        setStashOpen(true)
        return
      }
      if (name === "settings") {
        setSettingsOpen(true)
        return
      }
      if (name === "routines") {
        showScreen("routines")
        return
      }
      if (name === "remote") {
        setRemoteOpen(true)
        return
      }
      if (name === "artifacts") {
        showScreen("artifacts")
        return
      }
      if (name === "skills") {
        setSkillsOpen(true)
        return
      }
      if (name === "memory") {
        setMemoryOpen(true)
        return
      }
      if (name === "config") {
        setConfigOpen(true)
        return
      }
      setPrompt(`/${name} `)
    }

    createEffect(() => {
      const parts = paletteKey().split("+")
      const keyPart = (parts.at(-1) ?? "k").toLowerCase()
      const wantsMod = parts.includes("mod")
      const wantsShift = parts.includes("shift")
      const wantsAlt = parts.includes("alt")
      const handler = (event: KeyboardEvent) => {
        if (event.key.toLowerCase() !== keyPart) return
        if ((event.metaKey || event.ctrlKey) !== wantsMod) return
        if (event.shiftKey !== wantsShift) return
        if (event.altKey !== wantsAlt) return
        event.preventDefault()
        setPaletteOpen(true)
      }
      document.addEventListener("keydown", handler)
      onCleanup(() => document.removeEventListener("keydown", handler))
    })

    const notify = (title: string, body: string) => {
      if (!notifications()) return
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return
      if (!document.hidden) return
      new Notification(title, { body })
    }

    let refetchTimer: ReturnType<typeof setTimeout> | undefined
    let pendingMessages = false
    let pendingSessions = false
    const scheduleRefetch = (messages: boolean, sessions: boolean) => {
      pendingMessages = pendingMessages || messages
      pendingSessions = pendingSessions || sessions
      if (refetchTimer) return
      refetchTimer = setTimeout(() => {
        refetchTimer = undefined
        const wantMessages = pendingMessages
        const wantSessions = pendingSessions
        pendingMessages = false
        pendingSessions = false
        if (wantMessages) scheduleTranscriptReconcile()
        if (wantSessions) void refetchSessions()
      }, 300)
    }
    /**
     * Re-read the transcript and the working tree from the engine.
     *
     * Only worth doing when a turn ends. The transcript is built from the engine's own events, so
     * asking for it again mid-turn re-reads what the store already holds — the whole history, which
     * on a long session is megabytes and grows as the turn goes. Measured against a real one: 3.6MB,
     * seven times in thirty seconds, alongside `/vcs/status` at 400ms a call. That was most of the
     * traffic that pinned the window to the browser's six connections and stopped it answering.
     */
    const reconcileTranscript = () => {
      void refetchMessages()
      void refetchVcsInfo()
      void refetchVcsStatus()
    }
    let reconcileWhenIdle = false
    const scheduleTranscriptReconcile = () => {
      // Mid-turn the store is already following along; wait for the end rather than re-reading it all.
      if (runState()[selected() ?? ""] === true) {
        reconcileWhenIdle = true
        return
      }
      reconcileTranscript()
    }
    turnEnded = (sessionID) => {
      if (sessionID !== selected() || !reconcileWhenIdle) return
      reconcileWhenIdle = false
      reconcileTranscript()
    }
    onCleanup(() => {
      if (refetchTimer) clearTimeout(refetchTimer)
    })

    createEffect(() => {
      if (!ready()) return
      const url = serverUrl()
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      void (async () => {
        for (let attempt = 0; !controller.signal.aborted; attempt++) {
          setStreamState("global", attempt === 0 ? "connecting" : "reconnecting")
          try {
            // This stream carries no Last-Event-ID, so whatever happened while it was away is gone:
            // every reconnection resyncs the state the events would have carried. Missing the blocked
            // ones is the worst of it — an agent stuck on a permission with no dock to answer it.
            void (async () => {
              // Both runtimes have to be asked: `/api/session/active` only knows about v2 runs, and a
              // legacy turn — which is now every Code and Chat turn — shows up in its folder's status
              // map instead. A session in a folder nobody is watching has no source here, so it keeps
              // whatever it had rather than being called idle on no evidence.
              const engine = createClient(url)
              // Untracked: this effect owns the global stream, and re-running it on every change of
              // the open session would drop and reopen that stream for no reason.
              const folders = untrack(watchedDirectories)
              const sessions = untrack(sessionList)
              const [v2, legacy] = await Promise.all([
                engine.session.active().catch(() => new Set<string>()),
                Promise.all(
                  folders.map((directory) => engine.session.status({ directory }).catch(() => new Set<string>())),
                ),
              ])
              const running = new Set([...v2, ...legacy.flatMap((set) => [...set])])
              const known = new Set([
                ...v2,
                ...(sessions ?? [])
                  .filter((session) => folders.includes(session.location?.directory ?? ""))
                  .map((session) => session.id),
              ])
              Object.entries(runState())
                .filter(([id, isRunning]) => isRunning && known.has(id) && !running.has(id))
                .forEach(([id]) => setRunning(id, false))
              running.forEach((id) => {
                setRunning(id, true)
                if (v2.has(id)) watchRun(id, 2000)
              })
            })().catch(() => undefined)
            void refetchPermissions()
            void refetchQuestions()
            void refetchBlocked()
            for await (const event of createClient(url).event.subscribe({ signal: controller.signal })) {
              attempt = 0
              setStreamState("global", "live")
              const type = event.type ?? ""
              const payload = (event as { data?: { sessionID?: string; delta?: string } }).data
              trackActivity(type, payload as { sessionID?: string; status?: { type?: string } } | undefined)
              if (type === "session.next.step.started") {
                if (payload?.sessionID) publishSessionEvent({ kind: "turn", sessionID: payload.sessionID })
                if (payload?.sessionID === selected()) {
                  setStreamedChars(0)
                }
                scheduleRefetch(true, false)
              } else if (type.endsWith(".delta")) {
                // A v2 delta names no part, so there is nothing to apply it to; only a session started
                // on the v2 runner before this build still produces them, and its step events below
                // reload the transcript. All that is taken from here is the size of the turn so far.
                const delta = payload?.delta
                if (payload?.sessionID === selected() && typeof delta === "string") {
                  setStreamedChars((value) => value + delta.length)
                }
                continue
              }
              // The engine rebuilds its catalog from models.dev on its own schedule (and when an
              // integration connects). The list it serves moves with it, so the picker must not keep
              // offering the snapshot taken when the page loaded.
              if (type === "catalog.updated") {
                void refetchModels()
                continue
              }
              if (type.startsWith("permission.") || type.startsWith("question.")) {
                setActivityTick((value) => value + 1)
                publishSessionEvent({ kind: "requests" })
              }
              if (type.startsWith("permission.")) {
                if (type === "permission.v2.asked") notify(t("Permission needed"), "")
                void refetchPermissions()
                void refetchBlocked()
              } else if (type.startsWith("question.")) {
                if (type === "question.v2.asked") notify(t("Question asked"), "")
                void refetchQuestions()
              } else if (type.startsWith("message.") || type.startsWith("session.next.")) {
                if (type.startsWith("message.")) {
                  const legacy = event as {
                    data?: { sessionID?: string; info?: { sessionID?: string }; part?: { sessionID?: string } }
                  }
                  invalidateLegacyHistory(
                    legacy.data?.sessionID ?? legacy.data?.info?.sessionID ?? legacy.data?.part?.sessionID,
                  )
                }
                const changed = event as {
                  data?: {
                    sessionID?: string
                    agent?: string
                    info?: { sessionID?: string }
                    part?: { sessionID?: string }
                  }
                }
                // An agent switch from the engine (the Plan agent's plan_exit) moves the dock at once.
                const switchedAgent =
                  type.startsWith("session.next.agent.switched") && changed.data?.sessionID === selected()
                    ? changed.data?.agent
                    : undefined
                if (switchedAgent) setAgent(switchedAgent)
                publishSessionEvent({
                  kind: "changed",
                  sessionID: changed.data?.sessionID ?? changed.data?.info?.sessionID ?? changed.data?.part?.sessionID,
                })
                scheduleRefetch(true, type === "session.next.step.ended")
              } else if (type.startsWith("session.")) {
                scheduleRefetch(false, true)
              }
            }
          } catch {
            if (controller.signal.aborted) return
          }
          if (controller.signal.aborted) return
          setStreamState("global", "reconnecting")
          await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
          if (!controller.signal.aborted) {
            scheduleRefetch(true, true)
            publishSessionEvent({ kind: "changed" })
          }
        }
      })()
    })

    /**
     * Folders whose event stream this window follows. A legacy run — every chat, and every Code
     * session — streams its deltas and its status only on its own folder's stream, so a window that
     * wants them live has to hold one connection open per folder.
     *
     * How many it may hold is not a matter of taste. A browser allows six connections to one origin
     * over HTTP/1.1, and a stream holds one for as long as it lives. Measured against the engine on
     * 2026-09-16: with five streams open a request still answered in 8ms; with six, nothing answered
     * at all and the page never recovered — closing the tab was the only way out, which is exactly
     * what this looked like in use. Following four folders plus the global stream left a single
     * connection for every fetch the app makes, so one reconnection overlapping its own socket was
     * enough to deadlock the window.
     *
     * Two folders keeps the total at three and leaves half the budget free. A run in a folder nobody
     * is following is not lost: it still shows up in the periodic `session.active()` check and in the
     * refetch at the end of a turn — it just stops streaming live.
     */
    const WATCHED_DIRECTORIES = 2
    // A plain accessor, not a memo: a memo computes as soon as it is created, and the split panes it
    // reads are declared further down, which would run the whole component into the temporal dead zone.
    const watchedDirectories = () => {
      const list = sessionList()
      const directoryOf = (id: string | undefined) =>
        id ? list?.find((session) => session.id === id)?.location?.directory : undefined
      const open = [selected(), ...(splitActive() ? splitPanes() : [])].map(directoryOf)
      const directories = [chatsDirectory(), targetDirectory(), ...open].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
      return [...new Set(directories)].slice(0, WATCHED_DIRECTORIES)
    }

    /**
     * One legacy message event as a change to a transcript. The part types are remembered because a
     * delta only names its part, while `field` says "text" for reasoning too, so the part's own type
     * is the only way to tell them apart.
     */
    const partTypesByID = new Map<string, string>()
    const transcriptChange = (
      type: string,
      data:
        | {
            delta?: string
            partID?: string
            messageID?: string
            info?: { id?: string; role?: string }
            part?: { id?: string; type?: string; messageID?: string }
          }
        | undefined,
    ) => {
      if (type === "message.part.delta") {
        const delta = data?.delta
        if (typeof delta !== "string" || !data?.partID) return undefined
        const kind = partTypesByID.get(data.partID)
        if (kind !== "text" && kind !== "reasoning") return undefined
        const input = { messageID: data.messageID, partID: data.partID, delta }
        return {
          apply: (current: SessionMessageInfo[]) => applyDelta(current, input),
          chars: delta.length,
          ...(data.messageID ? { delta: { messageID: data.messageID, partID: data.partID, text: delta } } : {}),
        }
      }
      if (type === "message.part.updated" && data?.part?.id) {
        const part = data.part as LegacyPart
        if (part.type) partTypesByID.set(part.id, part.type)
        return { apply: (current: SessionMessageInfo[]) => applyPart(current, part), chars: 0 }
      }
      if (type === "message.part.removed" && data?.part?.id) {
        const input = { messageID: data.part.messageID ?? data.messageID, partID: data.part.id }
        return { apply: (current: SessionMessageInfo[]) => removePart(current, input), chars: 0 }
      }
      if (type === "message.updated" && data?.info?.id) {
        const info = data.info as LegacyInfo
        return { apply: (current: SessionMessageInfo[]) => applyMessage(current, info), chars: 0 }
      }
      if (type === "message.removed" && data?.messageID) {
        const messageID = data.messageID
        return { apply: (current: SessionMessageInfo[]) => removeMessage(current, messageID), chars: 0 }
      }
      return undefined
    }

    /** One folder's legacy event stream, reconnecting on its own backoff until the signal aborts. */
    const followDirectory = async (url: string, directory: string, signal: AbortSignal) => {
      // The engine updates a user message again mid-answer (its summary), so only a new one starts a turn.
      const lastUserMessage = new Map<string, string>()
      for (let attempt = 0; !signal.aborted; attempt++) {
        setStreamState(directory, attempt === 0 ? "connecting" : "reconnecting")
        try {
          const stream = createClient(url).event.subscribeDirectory(directory, { signal })
          for await (const event of stream) {
            attempt = 0
            setStreamState(directory, "live")
            const type = event.type ?? ""
            const data = (
              event as {
                data?: {
                  sessionID?: string
                  field?: string
                  delta?: string
                  status?: { type?: string }
                  partID?: string
                  info?: { id?: string; sessionID?: string; role?: string }
                  part?: { id?: string; sessionID?: string; type?: string }
                }
              }
            ).data
            trackActivity(type, data)
            const sessionID = data?.sessionID ?? data?.info?.sessionID ?? data?.part?.sessionID
            if (type.startsWith("message.")) {
              // Every message event is applied to the transcript instead of triggering a refetch of
              // the whole history. A refetch per event meant two full requests every 300ms for the
              // length of a turn, and a `<For>` rebuilt from new objects each time.
              const change = transcriptChange(type, data)
              if (sessionID && change) {
                publishSessionEvent({ kind: "message", sessionID, apply: change.apply, chars: change.chars })
                if (sessionID === selected()) {
                  setStreamedChars((value) => value + change.chars)
                  applyTranscriptChange(setMessageData, change)
                }
              }
              // A new user message starts a turn: what streamed before it is stale.
              const newTurn =
                type === "message.updated" &&
                data?.info?.role === "user" &&
                !!sessionID &&
                !!data.info.id &&
                lastUserMessage.get(sessionID) !== data.info.id
              if (newTurn && sessionID && data?.info?.id) {
                lastUserMessage.set(sessionID, data.info.id)
                publishSessionEvent({ kind: "turn", sessionID })
                if (sessionID === selected()) setStreamedChars(0)
              }
              // The cached legacy history is now behind the store, so the next refetch must rebuild it.
              invalidateLegacyHistory(sessionID)
            } else if (type === "session.idle") {
              // The end of a turn is where the applied events are reconciled against the engine's own
              // copy: one refetch per turn instead of one every 300ms.
              scheduleRefetch(true, true)
            } else if (type.startsWith("session.")) {
              scheduleRefetch(false, true)
            }
          }
        } catch {
          if (signal.aborted) break
        }
        if (signal.aborted) break
        // Not following this folder until the stream is back, and the pill says so.
        setStreamState(directory, "reconnecting")
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
      }
      forgetStreamState(directory)
    }

    // Streams are kept per folder across changes: switching session must not drop the chats stream,
    // which is what carries a chat answering in the background.
    const directoryStreams = new Map<string, AbortController>()
    onCleanup(() => {
      directoryStreams.forEach((controller) => controller.abort())
      directoryStreams.clear()
    })
    createEffect(() => {
      const url = ready() ? serverUrl() : undefined
      const wanted = url ? watchedDirectories() : []
      for (const [directory, controller] of directoryStreams) {
        if (wanted.includes(directory)) continue
        controller.abort()
        directoryStreams.delete(directory)
        forgetStreamState(directory)
      }
      if (!url) return
      for (const directory of wanted) {
        if (directoryStreams.has(directory)) continue
        const controller = new AbortController()
        directoryStreams.set(directory, controller)
        void followDirectory(url, directory, controller.signal)
      }
    })

    createEffect(() => {
      selected()
      setStreamedChars(0)
    })

    // A stored effort level the model does not offer here (another model's, or one this project's engine
    // lacks) is dropped: the engine rejects unknown levels, and the menu would show a level it cannot set.
    const selectedModel = () => {
      const ref = modelRef()
      if (!ref?.variant || variants().some((variant) => variant.id === ref.variant)) return ref
      return { providerID: ref.providerID, id: ref.id }
    }
    const modelKey = () => {
      const ref = selectedModel()
      return ref ? `${ref.providerID}/${ref.id}` : undefined
    }
    const currentModel = () => {
      const ref = modelRef()
      if (!ref) return
      return modelList().find((model) => model.providerID === ref.providerID && model.id === ref.id)
    }
    const variants = () => currentModel()?.variants ?? []
    const variantKey = () => selectedModel()?.variant

    /**
     * A session carries the model the engine reuses on its next turn. When the catalog drops it that
     * turn fails with "Model unavailable", so say which one is gone and offer the closest live model
     * of the same provider.
     */
    const missingModel = createMemo(() => {
      const ref = selectedSession()?.model
      if (!ref || modelList().length === 0 || hasModel(modelList(), ref)) return
      return ref
    })
    const missingModelReplacement = createMemo(() => {
      const ref = missingModel()
      return ref ? replacementModel(ref, modelList()) : undefined
    })

    // The dock and Customize name the model of the open session, which is the one the engine will
    // reuse: an older session, or one switched on another device, is not on the app's last pick.
    // Adopted once per open, so a switch already on its way to the engine is never undone.
    let syncedSession: string | undefined
    createEffect(() => {
      const session = selectedSession()
      if (!session) {
        syncedSession = undefined
        return
      }
      if (session.id === syncedSession) return
      syncedSession = session.id
      const stored = session.model
      if (!stored) return
      setModelRef({ providerID: stored.providerID, id: stored.id, variant: stored.variant })
    })

    createEffect(() => {
      if (modelRef()) return
      const preferred = Object.entries(modelDirectory()?.default ?? {}).find(([providerID, id]) =>
        modelList().some((model) => model.providerID === providerID && model.id === id),
      )
      const fallback = preferred ? { providerID: preferred[0], id: preferred[1] } : modelList()[0]
      if (!fallback) return
      setModelRef({ providerID: fallback.providerID, id: fallback.id })
    })

    createEffect(() => {
      writeStorage(STORAGE_KEYS.selectedSession, selected() ?? "")
    })

    createEffect(() => {
      const ref = modelRef()
      if (ref) writeStorage(STORAGE_KEYS.selectedModel, ref)
    })

    createEffect(() => {
      writeStorage(STORAGE_KEYS.noFolderSessions, noFolderSessions())
    })

    createEffect(() => {
      const query = window.matchMedia("(max-width: 768px)")
      const update = () => setNarrow(query.matches)
      update()
      query.addEventListener("change", update)
      onCleanup(() => query.removeEventListener("change", update))
    })

    // Narrow windows auto-collapse the sidebar; unlike the right panel (pure CSS, so it
    // reappears on its own), this writes a signal that would stick. Remember the wide preference
    // and put it back when the window grows again. Untracked: opening the drawer while narrow is
    // the reader's own doing and must not re-trigger the auto-collapse.
    let wideCollapsed: boolean | undefined
    createEffect(() => {
      if (narrow()) {
        if (wideCollapsed === undefined) wideCollapsed = untrack(collapsed)
        setCollapsed(true)
        return
      }
      if (wideCollapsed === undefined) return
      setCollapsed(wideCollapsed)
      writeStorage(STORAGE_KEYS.sidebarCollapsed, wideCollapsed)
      wideCollapsed = undefined
    })

    const modelLabel = () => {
      const model = currentModel()
      if (model) return model.name
      // A ref the catalog no longer serves has no name to show, and saying "Default model" would hide
      // which one is gone. Before the first list arrives, keep the generic label instead of an id.
      if (modelList().length === 0) return t("Default model")
      return modelRef()?.id ?? t("Default model")
    }
    const modelName = (ref: { providerID: string; id: string }) =>
      modelList().find((entry) => entry.providerID === ref.providerID && entry.id === ref.id)?.name ?? ref.id

    const toggleFavoriteModel = (key: string) => {
      setFavorites((current) => {
        const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
        writeStorage(STORAGE_KEYS.favoriteModels, next)
        return next
      })
    }

    /** Makes the picked model the app's, and the open session's when there is one. */
    const applyModel = (providerID: string, id: string) => {
      setModelRef({ providerID, id })
      const sessionID = selected()
      if (!sessionID) return
      void run(async (current) => {
        await current.session.switchModel({ sessionID, model: { id, providerID } })
        return undefined
      })
    }

    /**
     * A session that already holds context is cached for its model, so moving it to another one makes
     * the new model re-read the whole transcript: ask first, naming both. Nothing else needs asking.
     */
    const requestModel = (providerID: string, id: string) => {
      const current = sessionModel()
      if (
        current &&
        needsModelSwitchWarning({
          enabled: modelSwitchWarningOn(),
          history: (activeMessages() ?? []).length > 0,
          current,
          next: { providerID, id },
        })
      ) {
        setPendingModelSwitch({
          from: modelName(current),
          to: modelName({ providerID, id }),
          next: { providerID, id },
        })
        return
      }
      applyModel(providerID, id)
    }

    const pickModel = (providerID: string, id: string) => {
      setModelPickerOpen(false)
      requestModel(providerID, id)
    }

    const changeModel = (key: string) => {
      const [providerID, ...rest] = key.split("/")
      const id = rest.join("/")
      if (!providerID || !id) return
      requestModel(providerID, id)
    }

    const changeVariant = (value: string) => {
      const ref = modelRef()
      if (!ref) return
      const next = { providerID: ref.providerID, id: ref.id, variant: value || undefined }
      setModelRef(next)
      const sessionID = selected()
      if (!sessionID) return
      void run(async (current) => {
        await current.session.switchModel({
          sessionID,
          model: { id: next.id, providerID: next.providerID, ...(next.variant ? { variant: next.variant } : {}) },
        })
        return undefined
      })
    }

    const projects = createMemo(() => {
      const map = new Map<string, ProjectItem>()
      for (const session of sessionList() ?? []) {
        const directory = session.location?.directory
        if (!directory || isChat(session)) continue
        if (map.has(directory)) continue
        map.set(directory, {
          id: session.projectID || directory,
          directory,
          name: directory.split("/").filter(Boolean).at(-1) || directory,
        })
      }
      return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
    })
    const routineProjects = createMemo(() => {
      const directory = targetDirectory()
      if (!directory || projects().some((project) => project.directory === directory)) return projects()
      return [
        {
          id: directory,
          directory,
          name: directory.split("/").filter(Boolean).at(-1) || directory,
        },
        ...projects(),
      ]
    })

    const [remoteActivity] = createResource(
      () =>
        mobileRemote() && ready()
          ? JSON.stringify({
              url: serverUrl(),
              directories: projects().map((project) => project.directory),
              tick: activityTick(),
            })
          : undefined,
      async (key) => {
        const input = JSON.parse(key) as { url: string; directories: string[] }
        const base = input.url.replace(/\/$/, "")
        const lists = await Promise.all(
          input.directories.map(async (directory) => {
            const get = (path: string): Promise<unknown> =>
              engineFetch(`${base}${path}?directory=${encodeURIComponent(directory)}`)
                .then((response) => (response.ok ? response.json() : undefined))
                .catch(() => undefined)
            const [status, permissions, questions, vcs] = await Promise.all([
              get("/session/status"),
              get("/permission"),
              get("/question"),
              createClient(input.url)
                .vcs.get(directory)
                .catch(() => undefined),
            ])
            const requests = [permissions, questions].flatMap((list) =>
              Array.isArray(list) ? (list as Array<{ sessionID?: string }>) : [],
            )
            return {
              directory,
              busy: Object.entries((status ?? {}) as Record<string, { type?: string }>)
                .filter(([, value]) => value?.type && value.type !== "idle")
                .map(([id]) => id),
              waiting: requests.flatMap((request) => (request.sessionID ? [request.sessionID] : [])),
              branch: (vcs as { branch?: string } | undefined)?.branch,
            }
          }),
        )
        return {
          busy: new Set(lists.flatMap((list) => list.busy)),
          waiting: new Set(lists.flatMap((list) => list.waiting)),
          branches: Object.fromEntries(lists.map((list) => [list.directory, list.branch])),
        }
      },
    )

    const remoteSessions = createMemo((): RemoteSessionItem[] => {
      if (!mobileRemote()) return []
      const activity = remoteActivity.latest
      const runs = runState()
      return (sessionList() ?? [])
        .filter((session) => !session.parentID && !session.time.archived && isChat(session) === chatView())
        .sort((a, b) => b.time.updated - a.time.updated)
        .map((session) => {
          const directory = session.location?.directory
          const running = session.id in runs ? runs[session.id] : activity?.busy.has(session.id)
          return {
            id: session.id,
            title: sessionTitle(session),
            project: isChat(session) ? undefined : directory?.split("/").filter(Boolean).at(-1),
            branch: directory ? activity?.branches[directory] : undefined,
            updated: session.time.updated,
            state: activity?.waiting.has(session.id) ? "waiting" : running ? "busy" : "idle",
          }
        })
    })

    const mobileScreen = () => (selected() || mobileComposing() ? "session" : "home")
    const openMobileSession = (sessionID: string) => {
      selectSession(sessionID)
      window.history.pushState({ flupcode: "session" }, "")
    }
    const startMobileSession = (directory: string | undefined) => {
      newSession(directory)
      setMobileComposing(true)
      window.history.pushState({ flupcode: "session" }, "")
    }
    const leaveMobileSession = () => {
      setMobileComposing(false)
      setSelected(undefined)
      setTargetDirectory(undefined)
      setPrompt("")
    }
    const onPopState = () => {
      if (mobileRemote() && mobileScreen() === "session") leaveMobileSession()
    }
    window.addEventListener("popstate", onPopState)
    onCleanup(() => window.removeEventListener("popstate", onPopState))

    const [range, setRange] = createSignal<UsageRange>("all")
    // Sessions the dashboard counts: those created since the last reset from Settings.
    const countedSessions = createMemo(() =>
      (sessionList() ?? []).filter((session) => session.time.created >= usageResetAt()),
    )
    const filteredSessions = createMemo(() => filterByRange(countedSessions(), range()))
    const metrics = createMemo(() => computeMetrics(filteredSessions()))
    const activity = createMemo(() => activityByDay(countedSessions(), 365))
    const comparisonLine = createMemo(() => comparison(metrics().tokens))
    const [messageCount] = createResource(
      () => {
        if (selected()) return undefined
        const ids = filteredSessions()
          .slice(0, 30)
          .map((session) => session.id)
        return ids.length ? ids.join(",") : undefined
      },
      async (key) => {
        const client = createClient(serverUrl())
        const counts = await Promise.all(
          key.split(",").map(async (id) => {
            try {
              const response = await client.message.list({ sessionID: id })
              return response.data.length
            } catch {
              return 0
            }
          }),
        )
        return counts.reduce((sum, value) => sum + value, 0)
      },
    )

    const artifacts = () => {
      const files = new Set<string>()
      for (const message of activeMessages() ?? []) {
        if (message.type !== "assistant") continue
        for (const file of message.snapshot?.files ?? []) files.add(file)
        for (const part of message.content) {
          if (part.type !== "tool" || part.state.status === "pending") continue
          const input = part.state.input as { filePath?: unknown; path?: unknown }
          const path =
            typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : undefined
          if (path && (part.name === "write" || part.name === "edit" || part.name === "patch")) files.add(path)
        }
      }
      return [...files]
    }

    // Project-relative paths in the order the session touched them, most recent last. The files
    // changed panel uses it to expand the stack the agent edited last.
    const changedFiles = createMemo(() => {
      const directory = selectedSession()?.location?.directory
      const order: string[] = []
      const push = (file: string) => {
        const path = directory && file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : file
        const index = order.indexOf(path)
        if (index >= 0) order.splice(index, 1)
        order.push(path)
      }
      for (const message of activeMessages() ?? []) {
        if (message.type !== "assistant") continue
        for (const file of message.snapshot?.files ?? []) push(file)
        for (const part of message.content) {
          if (part.type !== "tool" || part.state.status === "pending") continue
          const input = part.state.input as { filePath?: unknown; path?: unknown }
          const path =
            typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : undefined
          if (path && (part.name === "write" || part.name === "edit" || part.name === "patch")) push(path)
        }
      }
      return order
    })

    const canGoBack = () => historyIndex() > 0
    const canGoForward = () => historyIndex() >= 0 && historyIndex() < history().length - 1

    const selectSession = (id: string) => {
      leaveScreen()
      if (narrow()) setCollapsed(true)
      setSelected(id)
      if (history()[historyIndex()] === id) return
      const next = history().slice(0, historyIndex() + 1)
      next.push(id)
      setHistory(next)
      setHistoryIndex(next.length - 1)
    }

    // Split view: sessions side by side. The focused pane is the selected session; see split.ts.
    const [splitPanes, setSplitPanes] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.splitPanes, []))
    const splitActive = () => splitPanes().length >= 2 && !mobileRemote() && !narrow()
    createEffect(() => writeStorage(STORAGE_KEYS.splitPanes, splitPanes()))
    let paneFocus = untrack(() => (splitPanes().includes(selected() ?? "") ? selected() : undefined))
    const openSplit = (id: string) => {
      const next = openInSplit({ panes: splitActive() ? splitPanes() : [], focus: selected() }, id)
      paneFocus = next.focus
      setSplitPanes(next.panes)
      if (next.focus) selectSession(next.focus)
    }
    const closeSplitPane = (id: string) => {
      const next = closePane({ panes: splitPanes(), focus: selected() }, id)
      paneFocus = next.focus
      setSplitPanes(next.panes)
      if (next.focus && next.focus !== selected()) selectSession(next.focus)
    }
    // Whatever opens a session while split (sidebar, palette, history) shows it in the focused pane;
    // leaving the session (New, the other tab) leaves split view.
    createEffect(() => {
      const id = selected()
      const panes = untrack(splitPanes)
      if (panes.length < 2) return
      if (!id) {
        setSplitPanes([])
        return
      }
      if (panes.includes(id)) {
        paneFocus = id
        return
      }
      const next = showInFocusedPane({ panes, focus: paneFocus }, id)
      paneFocus = next.focus
      setSplitPanes(next.panes)
    })
    createEffect(() => {
      const list = sessions()?.data
      const panes = splitPanes()
      if (!list || sessions.loading || panes.length === 0) return
      const next = keepExisting({ panes, focus: untrack(selected) }, (id) => list.some((session) => session.id === id))
      if (next.panes.length === panes.length) return
      paneFocus = next.focus
      setSplitPanes(next.panes)
      if (next.focus !== untrack(selected)) setSelected(next.focus)
    })
    const changeTargetDirectory = (directory: string | undefined) => {
      setTargetDirectory(directory)
      if (!directory) {
        setSelected(undefined)
        return
      }
      const sessions = (sessionList() ?? []).filter((session) => session.location?.directory === directory)
      const latest = [...sessions].sort((a, b) => b.time.updated - a.time.updated)[0]
      if (latest) {
        if (latest.id !== selected()) selectSession(latest.id)
        return
      }
      setSelected(undefined)
    }

    const goBack = () => {
      if (!canGoBack()) return
      const index = historyIndex() - 1
      setHistoryIndex(index)
      setSelected(history()[index])
    }

    const goForward = () => {
      if (!canGoForward()) return
      const index = historyIndex() + 1
      setHistoryIndex(index)
      setSelected(history()[index])
    }

    const togglePin = (id: string) => {
      const next = pinned().includes(id) ? pinned().filter((value) => value !== id) : [...pinned(), id]
      setPinned(next)
      writeStorage(STORAGE_KEYS.pinnedSessions, next)
    }

    const toggleProject = (id: string) => {
      const next = { ...expanded(), [id]: !(expanded()[id] ?? false) }
      setExpanded(next)
      writeStorage(STORAGE_KEYS.expandedProjects, next)
    }

    const toggleSidebar = () => {
      const next = !collapsed()
      setCollapsed(next)
      writeStorage(STORAGE_KEYS.sidebarCollapsed, next)
    }

    const toggleContextPanel = () => {
      const next = !contextHidden()
      setContextHidden(next)
      writeStorage(STORAGE_KEYS.contextPanelHidden, next)
    }
    const contextPanelShown = () => !!selectedSession() && !contextHidden()
    const updateContextWidth = (width: number) => {
      const next = Math.max(CONTEXT_PANEL_WIDTH.min, Math.min(CONTEXT_PANEL_WIDTH.max, Math.round(width)))
      setContextWidth(next)
      writeStorage(STORAGE_KEYS.contextPanelWidth, next)
    }

    const updateSidebarWidth = (width: number) => {
      const next = Math.max(200, Math.min(480, Math.round(width)))
      setSidebarWidth(next)
      writeStorage(STORAGE_KEYS.sidebarWidth, next)
    }

    const togglePanel = (kind: string) => {
      const next = panels().includes(kind) ? panels().filter((value) => value !== kind) : [...panels(), kind]
      setPanels(next)
      writeStorage(STORAGE_KEYS.workspacePanels, next)
    }

    const closePanel = (kind: string) => {
      const next = panels().filter((value) => value !== kind)
      setPanels(next)
      writeStorage(STORAGE_KEYS.workspacePanels, next)
    }

    // A local preview linked from the transcript opens the browser panel it navigates.
    createEffect(() => {
      if (!browser.request()) return
      const current = untrack(panels)
      if (current.includes("browser")) return
      const next = [...current, "browser"]
      setPanels(next)
      writeStorage(STORAGE_KEYS.workspacePanels, next)
    })

    // Local previews open in that panel instead of a new tab. Chats and phones keep the plain link,
    // where the panel is unavailable and a real tab is the only sensible target.
    createEffect(() => {
      const handler = (event: MouseEvent) => {
        if (event.defaultPrevented || event.button !== 0) return
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        if (chatView() || mobileRemote()) return
        const target = event.target
        if (!(target instanceof Element)) return
        const anchor = target.closest("a")
        if (!(anchor instanceof HTMLAnchorElement)) return
        const href = anchor.href
        if (!isLocalPreview(href)) return
        event.preventDefault()
        browser.open(href)
      }
      document.addEventListener("click", handler)
      onCleanup(() => document.removeEventListener("click", handler))
    })

    const updateWorkspaceWidth = (width: number) => {
      const next = Math.max(280, Math.min(900, Math.round(width)))
      setWorkspaceWidth(next)
      writeStorage(STORAGE_KEYS.workspaceWidth, next)
    }

    createEffect(() => {
      const handler = (event: KeyboardEvent) => {
        if ((event.metaKey || event.ctrlKey) && event.code === "KeyB") {
          event.preventDefault()
          // ⌘B toggles the left sidebar, ⌥⌘B the session's context panel.
          if (event.altKey) toggleContextPanel()
          else toggleSidebar()
        }
      }
      document.addEventListener("keydown", handler)
      onCleanup(() => document.removeEventListener("keydown", handler))
    })

    const updateDisplayName = (value: string) => {
      setDisplayName(value)
      writeStorage(STORAGE_KEYS.displayName, value)
    }

    const pairFromLink = () => {
      const pairing = remote.consumePairingLink()
      if (!pairing) return
      // The panel shows progress and, if pairing fails, why.
      setRemoteOpen(true)
      void pairing.then((paired) => {
        if (!paired) return
        setRemoteOpen(false)
        toast(t("Connected to {name}", { name: remote.activeHost()?.name ?? "" }), "success")
        setOnboarded(true)
        writeStorage(STORAGE_KEYS.onboarded, true)
      })
    }
    /** Opens the session a notification points at, switching computer when needed (ADR-0011). */
    const openFromNotification = (sessionID: string, hostId: string | undefined) => {
      if (hostId && hostId !== remote.activeHost()?.hostId && remote.hosts().some((host) => host.hostId === hostId))
        remote.connect(hostId)
      if (!mobileRemote()) return selectSession(sessionID)
      if (selected() !== sessionID) openMobileSession(sessionID)
    }
    const onServiceWorkerMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; sessionID?: unknown; host?: unknown } | undefined
      if (data?.type !== "flupcode:open-session" || typeof data.sessionID !== "string") return
      openFromNotification(data.sessionID, typeof data.host === "string" ? data.host : undefined)
    }

    remote.resume()
    pairFromLink()
    window.addEventListener("hashchange", pairFromLink)
    onCleanup(() => window.removeEventListener("hashchange", pairFromLink))
    const launch = new URLSearchParams(window.location.search)
    const launchSession = launch.get("session")
    if (launchSession) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.hash)
      openFromNotification(launchSession, launch.get("host") ?? undefined)
    }
    navigator.serviceWorker?.addEventListener("message", onServiceWorkerMessage)
    onCleanup(() => navigator.serviceWorker?.removeEventListener("message", onServiceWorkerMessage))

    const completeOnboarding = (name: string) => {
      if (name.trim()) updateDisplayName(name.trim())
      setOnboarded(true)
      writeStorage(STORAGE_KEYS.onboarded, true)
    }

    const updateTheme = (value: string) => {
      setTheme(value)
      writeStorage(STORAGE_KEYS.theme, value)
    }

    const updateColorTheme = (value: string) => {
      setColorTheme(value)
      writeStorage(STORAGE_KEYS.colorTheme, value)
    }

    createEffect(() => {
      const mode = theme()
      const palette = colorTheme()
      const media = window.matchMedia("(prefers-color-scheme: dark)")
      const apply = () => {
        const dark = mode === "dark" || (mode === "system" && media.matches)
        const root = document.documentElement
        root.classList.toggle("fc-dark", dark)
        // The palette rides alongside the mode class, so it also survives a System mode change.
        // The default palette needs no attribute: it is what `:root` already declares.
        if (palette === "flupcode") delete root.dataset.fcTheme
        else root.dataset.fcTheme = palette
        // The index.html bootstrap paints this before the stylesheet loads, which is the only moment
        // the inline value is needed: `html { background-color: var(--fc-bg) }` takes over from here.
        root.style.backgroundColor = ""
        // The browser and installed app paint their status bar with this colour.
        document
          .querySelector('meta[name="theme-color"]')
          ?.setAttribute("content", getComputedStyle(root).backgroundColor)
      }
      apply()
      media.addEventListener("change", apply)
      onCleanup(() => media.removeEventListener("change", apply))
    })

    const commitServer = () => {
      const next = serverInput().trim()
      if (!next) return
      if (remote.activeHost()) remote.disconnect()
      setLocalServerUrl(next)
      writeStorage(STORAGE_KEYS.serverUrl, next)
    }

    const refresh = () => {
      void refetchSessions()
    }

    const copyPath = (path: string) => {
      void navigator.clipboard?.writeText(path)
      toast(t("Path copied"), "success")
    }

    const toggleNotifications = () => {
      const next = !notifications()
      if (next && typeof Notification !== "undefined" && Notification.permission === "default") {
        void Notification.requestPermission()
      }
      setNotifications(next)
      writeStorage(STORAGE_KEYS.notifications, next)
    }

    const changePaletteKey = (value: string) => {
      setPaletteKey(value)
      writeStorage(STORAGE_KEYS.paletteKey, value)
    }

    const readAttachments = (files: File[]) =>
      Promise.all(
        files.map(
          (file) =>
            new Promise<Attachment>((resolve) => {
              const reader = new FileReader()
              reader.onload = () => resolve({ uri: String(reader.result), name: file.name })
              reader.onerror = () => resolve({ uri: "", name: file.name })
              reader.readAsDataURL(file)
            }),
        ),
      ).then((items) => items.filter((item) => item.uri))

    const addAttachments = (files: File[]) => {
      void Promise.all(
        files.map(
          (file) =>
            new Promise<Attachment>((resolve) => {
              const reader = new FileReader()
              reader.onload = () => resolve({ uri: String(reader.result), name: file.name })
              reader.onerror = () => resolve({ uri: "", name: file.name })
              reader.readAsDataURL(file)
            }),
        ),
      ).then((items) => setAttachments((list) => [...list, ...items.filter((item) => item.uri)]))
    }

    const removeAttachment = (uri: string) => {
      setAttachments((list) => list.filter((item) => item.uri !== uri))
    }

    const newId = () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`

    const persistStashes = (next: StashedPrompt[]) => {
      setStashes(next)
      writeStorage(STORAGE_KEYS.stashedPrompts, next)
    }

    const stashPrompt = (text: string, clear: boolean) => {
      const value = text.trim()
      if (!value) {
        toast(t("No prompt to save"), "info")
        return
      }
      persistStashes([{ id: newId(), text: value, createdAt: Date.now() }, ...stashes()])
      if (clear) setPrompt("")
      toast(t("Prompt saved"), "success")
    }

    const restoreStash = (id: string) => {
      const item = stashes().find((entry) => entry.id === id)
      if (!item) return
      setPrompt(item.text)
      persistStashes(stashes().filter((entry) => entry.id !== id))
      setStashOpen(false)
    }

    const removeStash = (id: string) => persistStashes(stashes().filter((entry) => entry.id !== id))

    const setRoutineState = (next: Routine[]) => {
      setRoutines(next)
      const active = next.flatMap((routine) => routine.runs.map((run) => ({ routine, run }))).find(({ run }) => run.status === "running")
      setRoutineBusy(!!active)
      setRoutineBusyID(active?.routine.id)
      setRoutineRunID(active?.run.id)
    }

    const refreshRoutines = async () => {
      if (routinesServerLoading()) return
      setRoutinesServerLoading(true)
      try {
        const current = createHarnessClient(harnessServerUrl())
        const remote = normalizeRoutines(await current.routines.list())
        const migrated = readStorage(STORAGE_KEYS.routinesMigration, false)
        if (!migrated && remote.length === 0 && routines().length > 0) {
          const created = await Promise.all(
            routines().map((routine) => current.routines.create(routine)),

          )
          writeStorage(STORAGE_KEYS.routinesMigration, true)
          setRoutineState(normalizeRoutines(created))
        } else {
          writeStorage(STORAGE_KEYS.routinesMigration, true)
          setRoutineState(remote)
        }
        setRoutinesServerAvailable(true)
      } catch {
        setRoutinesServerAvailable(false)
      } finally {
        setRoutinesServerLoading(false)
      }
    }

    /**
     * One change from the server, applied where it lands.
     *
     * A routine event carries the whole routine, and a run event the whole run, so none of this costs
     * a request: the list is read once when a connection opens, and after that the stream says what
     * moved. It replaces a five-second poll that asked for everything whether or not anything had
     * changed.
     */
    const applyHarnessEvent = (event: {
    type?: string
    routine?: unknown
    routineID?: unknown
    run?: unknown
    runID?: unknown
    task?: unknown
  }) => {
      if (event.type === "routine.changed") {
        const routine = normalizeRoutine(event.routine)
        if (!routine) return
        const current = routines()
        return setRoutineState(
          current.some((entry) => entry.id === routine.id)
            ? current.map((entry) => (entry.id === routine.id ? routine : entry))
            : [routine, ...current],
        )
      }
      if (event.type === "routine.removed" && typeof event.routineID === "string") {
        const removed = event.routineID
        return setRoutineState(routines().filter((entry) => entry.id !== removed))
      }
      if (event.type === "run.started" || event.type === "run.changed") {
      const run = event.run as Run | undefined
      if (run?.id) {
        const current = runs()
        setRuns(
          current.some((entry) => entry.id === run.id)
            ? // Keep the tasks already loaded: a run event carries the run, not its tasks.
              current.map((entry) => (entry.id === run.id ? { ...run, tasks: entry.tasks } : entry))
            : [run, ...current],
        )
      }
    }
    if (event.type === "run.removed" && typeof event.runID === "string") {
      const removed = event.runID
      setRuns(runs().filter((run) => run.id !== removed))
      return setRoutineState(
        routines().map((routine) => ({ ...routine, runs: routine.runs.filter((run) => run.id !== removed) })),
      )
    }
    if (event.type === "task.changed") {
      const task = event.task as Task | undefined
      if (!task?.id) return
      return setRuns(
        runs().map((run) => {
          if (run.id !== task.runID) return run
          const tasks = run.tasks ?? []
          return {
            ...run,
            tasks: tasks.some((entry) => entry.id === task.id)
              ? tasks.map((entry) => (entry.id === task.id ? task : entry))
              : [...tasks, task].sort((a, b) => a.position - b.position),
          }
        }),
      )
    }
    if (event.type !== "run.started" && event.type !== "run.changed") return
      const run = event.run as RoutineRun | undefined
      const routineID = run?.source?.type === "routine" ? run.source.routineID : undefined
      if (!run?.id || !routineID) return
      setRoutineState(
        routines().map((routine) => {
          if (routine.id !== routineID) return routine
          const known = routine.runs.some((entry) => entry.id === run.id)
          return {
            ...routine,
            runs: known ? routine.runs.map((entry) => (entry.id === run.id ? run : entry)) : [run, ...routine.runs],
          }
        }),
      )
    }

    /**
     * The runs the server knows about, with the tasks each is made of.
     *
     * Read once when a connection opens; after that the stream says what moved. Tasks are asked for
     * per run because the list leaves them out.
     */
    const refreshRuns = async () => {
      try {
        const current = createHarnessClient(harnessServerUrl())
        const list = (await current.runs.list()) ?? []
        const withTasks = await Promise.all(
          list
            .slice(0, RUNS_SHOWN)
            .map(async (run) => ({ ...run, tasks: await current.runs.tasks(run.id).catch(() => []) })),
        )
        setRuns(withTasks)
      } catch {
        // The connection that failed is about to be reported by the loop below.
      }
    }

    createEffect(() => {
      const url = harnessServerUrl()
      const controller = new AbortController()
      onCleanup(() => controller.abort())
      // Untracked: everything below reads and writes the routine state, and the first stretch of it
      // runs synchronously inside this effect. Tracked, the first refresh made the effect depend on
      // what it had just written, so every update tore the connection down and opened another —
      // measured at 17,000 connections in twenty seconds. Only the server's address belongs here.
      untrack(() => {
        void (async () => {
        for (let attempt = 0; !controller.signal.aborted; attempt++) {
          // Every connection starts by reading the list once. That is what makes the first paint and
          // every reconnection agree with the server, and it is the only request a quiet server gets.
          await refreshRoutines()
        await refreshRuns()
          try {
            for await (const event of createHarnessClient(url).events({ signal: controller.signal })) {
              attempt = 0
              applyHarnessEvent(event as Parameters<typeof applyHarnessEvent>[0])
            }
          } catch {
            if (controller.signal.aborted) return
          }
          if (controller.signal.aborted) return
          setRoutinesServerAvailable(false)
            await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
          }
      })()
    })
  })

  const addRoutine = (input: RoutineInput) => {
    void createHarnessClient(harnessServerUrl())
      .routines.create(input)
      .then((routine) => {
        setRoutineState([routine, ...routines()])
        toast(t("Routine created"), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const updateRoutine = (id: string, input: RoutineInput) => {
    void createHarnessClient(harnessServerUrl())
      .routines.update(id, input)
      .then((routine) => {
        setRoutineState(routines().map((entry) => (entry.id === id ? routine : entry)))
        toast(t("Routine saved"), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const toggleRoutine = (id: string) => {
    const routine = routines().find((entry) => entry.id === id)
    if (!routine) return
    void createHarnessClient(harnessServerUrl())
      .routines.setEnabled(id, !routine.enabled)
      .then((next) => setRoutineState(routines().map((entry) => (entry.id === id ? next : entry))))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const removeRoutine = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .routines.remove(id)
      .then(() => setRoutineState(routines().filter((entry) => entry.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const stopRun = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .runs.stop(id)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const removeRun = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .runs.remove(id)
      // The event says so too, but not to a reader whose stream is down: the list moves either way.
      .then(() => setRuns(runs().filter((run) => run.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // Where the branch stands on GitHub (H-20), for the chip above the composer.
  //
  // Polled rather than streamed, because GitHub is the one telling us and nobody here is listening
  // to it: every 20 seconds while checks are still running, every two minutes once they have
  // settled. `branchTick` is bumped by the timer and by anything that changes the branch, so a
  // commit or a new branch is reflected without waiting for the next poll.
  const [branchTick, setBranchTick] = createSignal(0)
  const branchKey = () => {
    const directory = vcsDirectory()
    if (!ready() || !directory || !routinesServerAvailable()) return undefined
    return `${harnessServerUrl()}\n${directory}\n${branchTick()}`
  }
  const [branchState] = createResource(branchKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).git.state(directory)
  })
  createEffect(() => {
    if (!branchKey()) return
    const running = (branchState()?.pullRequest?.checks.running ?? 0) > 0
    const timer = setTimeout(() => setBranchTick((tick) => tick + 1), running ? 20_000 : 120_000)
    onCleanup(() => clearTimeout(timer))
  })
  const [openingPullRequest, setOpeningPullRequest] = createSignal(false)
  const openPullRequest = (title: string) => {
    const directory = vcsDirectory()
    if (!directory) return
    setOpeningPullRequest(true)
    void createHarnessClient(harnessServerUrl())
      .git.openPullRequest({ directory, title })
      .then((made) => {
        toast(t("Opened #{number}", { number: made?.number ?? "" }), "success")
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setOpeningPullRequest(false))
  }

  // Git (H-20). Committing was a prompt: `"Commit the current changes with a clear message."` went
  // to the model, which then ran the commands itself. A whole turn, paid for in tokens, to run two
  // commands the server can run for nothing — and with no say in what went into the commit.
  const [committing, setCommitting] = createSignal(false)
  const commitPicked = (input: { message: string; paths: string[] }) => {
    const directory = vcsDirectory()
    if (!directory) return
    setCommitting(true)
    void createHarnessClient(harnessServerUrl())
      .git.commit({ directory, ...input })
      .then((made) => {
        toast(t("Committed {sha}", { sha: made?.sha ?? "" }), "success")
        void refetchChanges()
        void refetchVcsStatus()
        void refetchVcsInfo()
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setCommitting(false))
  }
  const startBranch = (name: string) => {
    const directory = vcsDirectory()
    if (!directory) return
    void createHarnessClient(harnessServerUrl())
      .git.branch({ directory, name })
      .then((made) => {
        toast(t('Now on "{branch}"', { branch: made?.branch ?? name }), "success")
        void refetchVcsInfo()
        void refetchChanges()
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const stopAllRuns = () => {
    void createHarnessClient(harnessServerUrl())
      .runs.stopAll()
      .then((result) => toast(t("{count} runs stopped", { count: result?.stopped ?? 0 }), "success"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Start a workflow from the composer.
   *
   * Everything typed after the name fills its first input, which is what `/feature add search`
   * means. A workflow that asks for more than one cannot be said on a single line, so it says so
   * rather than starting with the rest of them empty.
   */
  const startWorkflow = (workflow: Workflow, args: string) => {
    const [first, ...rest] = workflow.inputs
    if (rest.length > 0) {
      const inputs = workflow.inputs.join(", ")
      toast(t("{name} asks for {inputs}, which is more than one line can say", { name: workflow.name, inputs }), "error")
      return
    }
    if (first && !args.trim()) {
      toast(t("{name} needs {input}", { name: workflow.name, input: first }), "info")
      return
    }
    setPrompt("")
    void createHarnessClient(harnessServerUrl())
      .workflows.run(workflow.name, {
        ...(first ? { inputs: { [first]: args.trim() } } : {}),
        directory: modelLocation(),
      })
      // Straight to the supervisor: a run nobody can see is the thing this replaces.
      .then(() => showScreen("runs"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const approveRun = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .runs.approve(id)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const clearRuns = () => {
    void createHarnessClient(harnessServerUrl())
      .runs.clear()
      .then((result) => {
        setRuns(runs().filter((run) => run.status === "running"))
        toast(t("{count} runs deleted", { count: result?.removed ?? 0 }), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const runRoutine = (id: string) => {
    if (routineBusy()) return
    void createHarnessClient(harnessServerUrl())
      .routines.run(id)
      .then((run) => {
        setRoutineBusy(true)
        setRoutineBusyID(id)
        setRoutineRunID(run.id)
        void refreshRoutines()
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const stopRoutine = () => {
    const routineID = routineBusyID()
    const runID = routineRunID()
    if (!routineID || !runID) return
    void createHarnessClient(harnessServerUrl())
      .routines.stop(routineID, runID)
      .then(() => void refreshRoutines())
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const run = async (action: (current: Client) => Promise<string | undefined>, successMessage?: string) => {
    setBusy(true)
    setError(undefined)
    try {
      const id = await action(client())
      if (id) selectSession(id)
      void refetchSessions()
      if (successMessage) toast(successMessage, "success")
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      setError(message)
      toast(message, "error")
    } finally {
      setBusy(false)
    }
  }

  const newSession = (directory?: string) => {
    leaveScreen()
    const sessionID = selected()
    if (sessionID && !messagesLoading() && (activeMessages() ?? []).length === 0) {
      void createClient(serverUrl())
        .session.remove({ sessionID })
        .then(() => refetchSessions())
        .catch(() => undefined)
    }
    setTargetDirectory(directory)
    setSelected(undefined)
    setPrompt("")
    setAttachments([])
  }

  // An answer goes back to the runtime that asked. The legacy one owns every request a running turn
  // raises today, and only it can unblock that turn; v2 is tried after it for requests left from
  // before, so an old session is still answerable.
  const sessionDirectory = (sessionID: string) =>
    sessionList()?.find((session) => session.id === sessionID)?.location?.directory

  const replyPermission = (request: PermissionV2Request, reply: PermissionReply, message?: string) =>
    run(async (current) => {
      await current.blocked
        .answerPermission({
          requestID: request.id,
          directory: sessionDirectory(request.sessionID),
          reply,
          message,
        })
        .catch(() =>
          current.session.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply, message }),
        )
      void refetchPermissions()
      void refetchBlocked()
      return undefined
    })

  const replyQuestion = (request: QuestionV2Request, answers: string[][]) =>
    run(async (current) => {
      await current.blocked
        .answerQuestion({ requestID: request.id, directory: sessionDirectory(request.sessionID), answers })
        .catch(() => current.session.question.reply({ sessionID: request.sessionID, requestID: request.id, answers }))
      void refetchQuestions()
      return undefined
    })

  const rejectQuestion = (request: QuestionV2Request) =>
    run(async (current) => {
      await current.blocked
        .rejectQuestion({ requestID: request.id, directory: sessionDirectory(request.sessionID) })
        .catch(() => current.session.question.reject({ sessionID: request.sessionID, requestID: request.id }))
      void refetchQuestions()
      return undefined
    })

  const stopSession = () => {
    const sessionID = selected()
    if (!sessionID) return
    const chatsFolder = chatsDirectory()
    void run(async (current) => {
      if (chatsFolder && isChat(selectedSession())) await current.session.abort({ sessionID, directory: chatsFolder })
      else await current.session.interrupt({ sessionID })
      return undefined
    })
  }

  const forkSession = (messageID?: string) => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      const forked = await current.session.fork({ sessionID, messageID })
      return forked.id
    }, t("Session forked"))
  }

  const compactSession = () => {
    void run(async (current) => {
      const model = selectedModel()
      const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
      await current.session.compact({ sessionID })
      return sessionID
    }, t("Session compacted"))
  }

  const renameSession = (id?: string) => {
    const sessionID = id ?? selected()
    if (!sessionID) return
    const currentTitle = sessionTitle(sessionList()?.find((session) => session.id === sessionID))
    setRenameTarget({ id: sessionID, title: currentTitle })
  }

  const commitRename = (title: string) => {
    const target = renameTarget()
    if (!target) return
    setRenameTarget(undefined)
    void run(async (current) => {
      await current.session.rename({ sessionID: target.id, title })
      return undefined
    }, t("Session renamed"))
  }

  const deleteProject = (directory: string) => {
    const sessions = (sessionList() ?? []).filter((session) => (session.location?.directory ?? "") === directory)
    if (sessions.length === 0) return
    if (!window.confirm(t("Delete this project and its sessions?"))) return
    void (async () => {
      setBusy(true)
      try {
        const current = createClient(serverUrl())
        for (const session of sessions) await current.session.remove({ sessionID: session.id })
        if (sessions.some((session) => session.id === selected())) setSelected(undefined)
        toast(t("Project deleted"), "success")
        void refetchSessions()
      } catch (cause) {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
      } finally {
        setBusy(false)
      }
    })()
  }

  // The engine has served share links all along; the UI just never asked for one. It cannot say
  // whether a session is already shared — the v2 session record carries no share state — so both
  // actions are always offered rather than pretending to know.
  const shareSession = () => {
    const session = selectedSession()
    if (!session) return
    void run(async (current) => {
      const url = await current.session.share({ sessionID: session.id, directory: session.location?.directory })
      if (url) await navigator.clipboard?.writeText(url).catch(() => undefined)
      return undefined
    }, t("Share link copied"))
  }

  const unshareSession = () => {
    const session = selectedSession()
    if (!session) return
    void run(async (current) => {
      await current.session.unshare({ sessionID: session.id, directory: session.location?.directory })
      return undefined
    }, t("Sharing stopped"))
  }

  const moveSession = (directory: string) => {
    const sessionID = selected()
    if (!sessionID) return
    setNoFolderSessions((list) => list.filter((id) => id !== sessionID))
    void run(async (current) => {
      await current.session.move({ sessionID, directory })
      return undefined
    }, t("Session moved"))
  }

  const deleteSession = (id?: string) => {
    const sessionID = id ?? selected()
    if (!sessionID) return
    if (!window.confirm(t("Delete this session?"))) return
    void (async () => {
      setBusy(true)
      try {
        await createClient(serverUrl()).session.remove({ sessionID })
        if (selected() === sessionID) setSelected(undefined)
        toast(t("Session deleted"), "success")
        void refetchSessions()
      } catch (cause) {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
      } finally {
        setBusy(false)
      }
    })()
  }

  const changeAgent = (value: string) => {
    setAgent(value)
    writeStorage(STORAGE_KEYS.agent, value)
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.switchAgent({ sessionID, agent: value })
      return undefined
    })
  }

  const applyPermissionMode = async (sessionID: string, directory?: string) => {
    await client().session.setPermission({
      sessionID,
      permission: permissionMode(permissionModeId()).rules,
      directory,
    })
  }

  const changePermissionMode = (id: string) => {
    setPermissionModeId(id)
    writeStorage(STORAGE_KEYS.permissionMode, id)
    const sessionID = selected()
    if (!sessionID) return
    void applyPermissionMode(sessionID, selectedSession()?.location?.directory).catch((cause) =>
      toast(cause instanceof Error ? cause.message : String(cause), "error"),
    )
  }

  const addMcp = (server: string, config: McpConfig) =>
    run(async (current) => {
      await current.mcp.add({ server, config })
      void refetchMcp()
      return undefined
    }, t("MCP server added"))

  const removeMcp = (server: string) =>
    run(async (current) => {
      await current.mcp.remove({ server })
      void refetchMcp()
      return undefined
    }, t("MCP server removed"))

  const connectMcp = (server: string) =>
    run(async (current) => {
      await current.mcp.connect({ server })
      void refetchMcp()
      return undefined
    }, t("MCP server connected"))

  const disconnectMcp = (server: string) =>
    run(async (current) => {
      await current.mcp.disconnect({ server })
      void refetchMcp()
      return undefined
    }, t("MCP server disconnected"))

  const saveProvider = (providerID: string, key: string) =>
    run(async (current) => {
      await current.auth.set({ providerID, key })
      await current.integration.connectKey({ integrationID: providerID, key, label: providerID }).catch(() => undefined)
      void refetchProviderDirectory()
      void refetchModelDirectory()
      void refetchModels()
      void refetchIntegrations()
      return undefined
    }, t("Provider saved"))

  const removeProvider = (providerID: string) =>
    run(async (current) => {
      await current.auth.remove({ providerID })
      const integrations = await current.integration.list()
      const integration = integrations.data.find((item) => item.id === providerID)
      for (const connection of integration?.connections ?? []) {
        if (connection.type !== "credential") continue
        await current.integration.disconnect(connection.id)
      }
      void refetchProviderDirectory()
      void refetchModelDirectory()
      void refetchModels()
      void refetchIntegrations()
      return undefined
    }, t("Provider removed"))

  const startOAuth = (providerID: string, methodID?: string) =>
    client()
      .integration.oauth({ integrationID: providerID, methodID, label: providerID })
      .then((result) => result.data)

  const oAuthStatus = (attemptID: string) =>
    client()
      .integration.attempt.status(attemptID)
      .then((result) => result.data)

  const cancelOAuth = (attemptID: string) =>
    client()
      .integration.attempt.cancel(attemptID)
      .then(() => undefined)

  const finishOAuth = () => {
    const refresh = () => {
      void refetchProviderDirectory()
      void refetchModelDirectory()
      void refetchModels()
      void refetchIntegrations()
    }
    refresh()
    // The engine marks the attempt complete just before persisting the
    // credential, so refresh again once it has landed.
    setTimeout(refresh, 800)
  }

  const editMessage = (messageID: string, text: string) => {
    const sessionID = selected()
    if (!sessionID) return
    setPrompt(text)
    void run(async (current) => {
      await current.session.revert.stage({ sessionID, messageID, files: true })
      void refetchMessages()
      return undefined
    }, t("Message ready to edit"))
  }

  const undo = () => {
    const sessionID = selected()
    if (!sessionID) return
    const lastUser = [...(activeMessages() ?? [])].reverse().find((message) => message.type === "user")
    if (!lastUser) {
      toast(t("Nothing to undo"), "info")
      return
    }
    void run(async (current) => {
      await current.session.revert.stage({ sessionID, messageID: lastUser.id, files: true })
      void refetchMessages()
      return undefined
    }, t("Changes reverted"))
  }

  const redo = () => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.revert.clear({ sessionID })
      void refetchMessages()
      return undefined
    }, t("Changes restored"))
  }

  const commitRevert = () => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.revert.commit({ sessionID })
      void refetchMessages()
      return undefined
    }, t("Revert confirmed"))
  }

  const exportMarkdown = () => {
    const sessionID = selected()
    if (!sessionID) return
    const lines: string[] = [`# ${sessionTitle(selectedSession()) || sessionID}`, ""]
    for (const message of activeMessages() ?? []) {
      if (message.type === "user") {
        lines.push("## User", "", (message as { text?: string }).text ?? "", "")
        continue
      }
      if (message.type !== "assistant") continue
      for (const part of message.content) {
        if (part.type === "text") lines.push(part.text, "")
        else if (part.type === "reasoning")
          lines.push("<details><summary>Reasoning</summary>", "", part.text, "", "</details>", "")
        else if (part.type === "tool") lines.push(`> Tool: ${part.name}`, "")
      }
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = `${sessionID}.md`
    anchor.click()
    URL.revokeObjectURL(url)
    toast(t("Transcript exported"), "success")
  }

  // Chats have no commands or shell: everything typed is the message.
  const sendChat = (text: string, files: Attachment[], keepDraft = false) => {
    const directory = chatsDirectory()
    if (!directory) {
      setError(t("Chats are not available: the engine did not report its folders"))
      return
    }
    void run(async (current) => {
      const model = selectedModel()
      const existing = selected()
      const sessionID =
        existing ?? (await current.session.create({ ...(model ? { model } : {}), location: { directory } })).id
      if (!existing) {
        await current.session.setPermission({ sessionID, permission: CHAT_PERMISSION, directory })
      }
      forgetRun(sessionID)
      await current.session.send({
        sessionID,
        directory,
        text: expandPastes(text),
        system: CHAT_SYSTEM,
        files: files.map(({ uri, name }) => ({ uri, name })),
        ...(model ? { model } : {}),
      })
      setStreamedChars(0)
      if (!keepDraft) {
        setPrompt("")
        setAttachments([])
      }
      return sessionID
    }, t("Message sent"))
  }

  /** Sends a prompt to the selected session (or a new one); the composer is cleared unless the draft is kept. */
  const submitPrompt = (text: string, files: Attachment[], keepDraft = false) => {
    // Delivery only means something when a turn is already running; an idle session starts one.
    const mode = generating() ? delivery() : undefined
    const id = messageID()
    void run(async (current) => {
      const model = selectedModel()
      const location = targetDirectory()
      const existing = selected()
      const sessionID =
        existing ??
        (
          await current.session.create({
            agent: agent(),
            ...(model ? { model } : {}),
            ...(location ? { location: { directory: location } } : {}),
          })
        ).id
      // No rename here: the engine's title agent names a session on its first turn, but only while
      // the title is still the placeholder it was created with. Naming it from the prompt looked
      // tidy and permanently stopped the engine from ever naming anything. See session-title.ts.
      if (!existing && !location) {
        setNoFolderSessions((list) => (list.includes(sessionID) ? list : [...list, sessionID]))
      }
      await current.session.setPermission({
        sessionID,
        permission: permissionMode(permissionModeId()).rules,
        directory: location ?? selectedSession()?.location?.directory,
      })
      forgetRun(sessionID)
      pendingPrompts.add({
        id,
        sessionID,
        directory: location ?? selectedSession()?.location?.directory,
        text,
        files,
        agent: agent(),
        ...(model ? { model } : {}),
        delivery: mode,
      })
      setStreamedChars(0)
      if (!keepDraft) {
        setPrompt("")
        setAttachments([])
      }
      // Queued prompts wait here, not in the engine: the legacy runner has no queue of its own, so
      // one sent now would join the turn in flight instead of following it. pending-prompts.ts
      // sends it when the session goes idle, which is also what makes it cancellable.
      if (mode === "queue") return sessionID
      try {
        await current.session.send({
          sessionID,
          directory: location ?? selectedSession()?.location?.directory,
          id,
          text: expandPastes(text),
          agent: agent(),
          ...(model ? { model } : {}),
          ...(files.length > 0 ? { files: files.map(({ uri, name }) => ({ uri, name })) } : {}),
        })
      } catch (cause) {
        pendingPrompts.remove(id)
        throw cause
      }
      return sessionID
    }, t("Message sent"))
  }

  /** Resends the prompt that opened a failed turn, leaving whatever is typed in the composer alone. */
  const retryTurn = (messageID: string) => {
    const message = activeMessages()?.find((item) => item.id === messageID)
    if (message?.type !== "user") return
    const text = (message as { text?: string }).text ?? ""
    const files = ((message as { files?: Array<{ uri: string; name?: string }> }).files ?? []).map((file) => ({
      uri: file.uri,
      name: file.name ?? file.uri,
    }))
    if (chatView()) return sendChat(text, files, true)
    submitPrompt(text, files, true)
  }

  const send = () => {
    const text = prompt().trim()
    const files = attachments()
    if (!text && files.length === 0) return
    recordPrompt(text)
    if (chatView()) return sendChat(text, files)

    if (text.startsWith("/")) {
      const [rawName, ...rest] = text.slice(1).split(/\s+/)
      const name = rawName ?? ""
      const args = rest.join(" ").trim()
      if (UNAVAILABLE_FEATURES.has(name)) {
        setPrompt("")
        toast(t("Coming soon"), "info")
        return
      }
      // A workflow is launched like a command, with what was typed after it as its first input
      // (H-21): `/feature add search to the sidebar`. Built-in names are matched first, so a
      // workflow cannot take one over by being written down.
      const workflow = workflowNamed(name)
      if (workflow) {
        startWorkflow(workflow, args)
        return
      }
      if (name === "new" || name === "clear") {
        setPrompt("")
        newSession()
        return
      }
      if (name === "about") {
        setPrompt("")
        setAboutOpen(true)
        return
      }
      if (name === "compact") {
        void run(async (current) => {
          const model = selectedModel()
          const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
          await current.session.compact({ sessionID })
          setPrompt("")
          return sessionID
        }, t("Session compacted"))
        return
      }
      if (name === "steps") {
        setPrompt("")
        setShowTools((value) => !value)
        return
      }
      if (name === "mcp") {
        setPrompt("")
        setMcpOpen(true)
        return
      }
      if (name === "stash") {
        stashPrompt(args, false)
        if (args) setPrompt("")
        return
      }
      if (name === "stashes") {
        setPrompt("")
        setStashOpen(true)
        return
      }
      if (name === "settings") {
        setPrompt("")
        setSettingsOpen(true)
        return
      }
      if (name === "routines") {
        setPrompt("")
        showScreen("routines")
        return
      }
      if (name === "remote") {
        setPrompt("")
        setRemoteOpen(true)
        return
      }
      if (name === "artifacts") {
        setPrompt("")
        showScreen("artifacts")
        return
      }
      if (name === "skills") {
        setPrompt("")
        setSkillsOpen(true)
        return
      }
      if (name === "memory") {
        setPrompt("")
        setMemoryOpen(true)
        return
      }
      if (name === "config") {
        setPrompt("")
        setConfigOpen(true)
        return
      }
      const skill = skills()?.data?.find((item) => item.name === name)
      if (skill) {
        void run(async (current) => {
          const sessionID = selected() ?? (await current.session.create()).id
          await current.session.skill({ sessionID, skill: skill.name })
          setPrompt("")
          return sessionID
        }, t("Skill executed"))
        return
      }
      void run(async (current) => {
        const model = selectedModel()
        const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
        await current.session.command({ sessionID, command: name, ...(args ? { arguments: args } : {}) })
        setPrompt("")
        return sessionID
      }, t("Command executed"))
      return
    }

    if (text.startsWith("!")) {
      const command = text.slice(1).trim()
      if (!command) return
      void run(async (current) => {
        const sessionID = selected() ?? (await current.session.create()).id
        await current.session.shell({ sessionID, command })
        setPrompt("")
        return sessionID
      }, t("Command launched"))
      return
    }

    submitPrompt(text, files)
  }

  /**
   * The repo bar's commit button.
   *
   * It used to write a prompt and send it, so pressing it cost a model turn to run `git add` and
   * `git commit`. It now opens the diff, where the commit is made by the server — which is also the
   * only place a reader can see what they are about to commit before they commit it.
   */
  const commitChanges = () => openChanges()

  /**
   * The top strip: the navigation, the session, and what the engine is doing.
   *
   * A component rather than a value, because it is placed in one of two places and only one of
   * them exists at a time. In the desktop app it is a row of its own across the window, which is
   * where the window controls are; in a browser the window already has a bar of its own above the
   * page, so the strip stays over the session, where it has always been.
   */
  const TopStrip = () => (
          <Show
            when={!mobileRemote()}
            fallback={
              <Show when={mobileScreen() === "session"}>
                <header class="fc-mobile-header">
                  <button
                    class="fc-icon-button fc-mobile-back"
                    type="button"
                    aria-label={t("Back")}
                    onClick={() =>
                      window.history.state?.flupcode === "session" ? window.history.back() : leaveMobileSession()
                    }
                  >
                    ←
                  </button>
                  <span class="fc-mobile-heading">
                    <span class="fc-mobile-title">
                      {sessionTitle(selectedSession()) || (chatView() ? t("New chat") : t("New session"))}
                    </span>
                    <Show
                      when={
                        !chatView() &&
                        (targetDirectory() ?? selectedSession()?.location?.directory)?.split("/").filter(Boolean).at(-1)
                      }
                    >
                      {(project) => <span class="fc-mobile-subtitle">{project()}</span>}
                    </Show>
                  </span>
                  <button
                    class={`fc-remote-dot fc-remote-dot-${remote.status() === "connected" ? "online" : "connecting"} fc-mobile-host`}
                    type="button"
                    aria-label={t("Remote: {name}", { name: remote.activeHost()?.name ?? "" })}
                    onClick={() => setRemoteOpen(true)}
                  />
                </header>
              </Show>
            }
          >
            <Topbar
            showTabs={desktopWindow() || collapsed()}
              streamState={streamState()}
              blockedElsewhere={blockedElsewhere()}
              onOpenBlocked={selectSession}
              healthLoading={health.loading}
              healthHealthy={health()?.healthy === true}
              healthError={!health.loading && health()?.healthy === false}
              canGoBack={canGoBack()}
              canGoForward={canGoForward()}
              onBack={goBack}
              onForward={goForward}
              onToggleSidebar={toggleSidebar}
              view={view()}
              onViewChange={changeView}
              sidebarCollapsed={collapsed()}
              contextPanel={
                selectedSession() && !chatView() ? { open: !contextHidden(), onToggle: toggleContextPanel } : undefined
              }
              onOpenPalette={() => setPaletteOpen(true)}
              onTogglePanel={togglePanel}
              remote={
                remote.activeHost()
                  ? {
                      name: remote.activeHost()!.name,
                      connected: remote.status() === "connected",
                      onOpen: () => setRemoteOpen(true),
                    }
                  : undefined
              }
              hostRemote={hostRemotePill()}
              sessionTitle={
                <Show when={!splitActive() && selectedSession()}>
                  {(session) => <SessionTitle session={session()} />}
                </Show>
              }
              sessionActions={
                <Show when={!splitActive() && selectedSession()}>
                  {(session) => (
                    <SessionActions
                      session={session()}
                      projects={projects()}
                      reverting={!!session().revert}
                      onFork={forkSession}
                      onCompact={compactSession}
                      onRename={renameSession}
                      onExport={exportMarkdown}
                      onShare={shareSession}
                      onUnshare={unshareSession}
                      onMove={moveSession}
                      onDelete={deleteSession}
                      onUndo={undo}
                      onRedo={redo}
                      onCommitRevert={commitRevert}
                    />
                  )}
                </Show>
              }
            />
          </Show>
  )

  return (
    <div
      class="fc-app"
      classList={{
        "fc-mobile-remote": mobileRemote(),
        // The desktop window has no title bar of its own, so the page draws the top strip and has to
        // leave room for the window controls: on the left on macOS, on the right on Windows, and
        // over whichever element the window's corner happens to land on.
        "fc-desktop": desktopWindow(),
        "fc-desktop-win": desktopWindow() && window.flupcode?.platform === "win32",
        "fc-sidebar-hidden": collapsed(),
      }}
    >
      <Show when={desktopWindow()}>
        <TopStrip />
      </Show>
      <div class="fc-body">
      <Show when={!mobileRemote()}>
        <Show when={narrow() && !collapsed()}>
          <div class="fc-sidebar-backdrop" onClick={() => setCollapsed(true)} />
        </Show>
        <PanelBoundary name={t("The sidebar")}>
          <Sidebar
            showBrand={!desktopWindow()}
            collapsed={collapsed()}
            width={sidebarWidth()}
            displayName={displayName()}
            view={view()}
            onViewChange={changeView}
            sessions={viewSessions()}
            sessionsLoading={sessions.loading || (ready() && enginePaths.loading)}
            selectedSession={selected()}
            runningSessions={Object.keys(runState()).filter((id) => runState()[id])}
            blockedSessions={blockedSessions()}
            pinnedSessions={pinned()}
            expandedProjects={expanded()}
            noFolderSessions={noFolderSessions()}
            onDisplayName={updateDisplayName}
            onToggleSessionPin={togglePin}
            onToggleProject={toggleProject}
            onNewSession={newSession}
            onSelectSession={selectSession}
            onSplitSession={openSplit}
            splitSessions={splitActive() ? splitPanes() : []}
            onDeleteSession={deleteSession}
            onRenameSession={renameSession}
            onDeleteProject={deleteProject}
            onResize={updateSidebarWidth}
            onCollapse={toggleSidebar}
            onCopyPath={copyPath}
            onRefresh={refresh}
            onAbout={() => setAboutOpen(true)}
            onSettings={() => setSettingsOpen(true)}
            onRoutines={(focus) => {
              setRoutineFocus(focus)
              showScreen("routines")
            }}
            routines={routines()}
            onSearch={() => setPaletteOpen(true)}
            onRuns={() => showScreen("runs")}
            onUsage={() => showScreen("usage")}
            onContext={() => showScreen("context")}
            onAgents={() => showScreen("agents")}
            onSkills={() => showScreen("skills")}
            onArtifacts={() => showScreen("artifacts")}
            onProviders={() => setProvidersOpen(true)}
            onConfig={() => setConfigOpen(true)}
            onRemote={() => setRemoteOpen(true)}
            onMcp={() => setMcpOpen(true)}
          />
        </PanelBoundary>
      </Show>
      <main class="fc-main" classList={{ "fc-main-chat-home": chatView() && !selected() && !mobileRemote() }}>
        <Show when={!desktopWindow()}>
          <TopStrip />
        </Show>
        <Show when={onboarded() && !remote.activeHost() && !health.loading && health()?.healthy !== true}>
          <div class="fc-offline-banner">
            <span>
              {health()?.blocked ? t("Connection blocked by the browser") : t("Server offline")} —{" "}
              {t("start it and connect from Settings")} ·{" "}
              <code>opencode serve --port 4096 --cors {window.location.origin}</code>
            </span>
            <button class="fc-button" type="button" onClick={() => void refetchHealth()}>
              {t("Retry")}
            </button>
          </div>
        </Show>
        <Show
          when={!splitActive()}
          fallback={
            <div class="fc-split">
              {/* Keyed by id: the session list refreshes while sessions run, and a pane must keep its state. */}
              <For each={splitPanes()}>
                {(id) => (
                  <Show when={sessionList()?.find((session) => session.id === id)}>
                    {(session) => (
                      <SessionPane
                        session={session()}
                        serverUrl={serverUrl()}
                        focused={selected() === session().id}
                        running={!!runState()[session().id]}
                        chat={isChat(session())}
                        chatsDirectory={chatsDirectory()}
                        showTools={showTools()}
                        showReasoning={showReasoning()}
                        models={modelList()}
                        defaultModel={modelRef()}
                        favorites={favorites()}
                        agents={agents()?.data ?? []}
                        agent={agent()}
                        permissionModeId={permissionModeId()}
                        delivery={delivery()}
                        onDeliveryChange={changeDelivery}
                        projects={projects()}
                        history={promptHistory()}
                        modelName={modelName}
                        searchFiles={searchFiles}
                        collapsePaste={collapsePaste}
                        expandPastes={expandPastes}
                        readFiles={readAttachments}
                        onFocus={() => selectSession(session().id)}
                        onClose={() => closeSplitPane(session().id)}
                        onOpenModelPicker={() => setModelPickerOpen(true)}
                        onAgentChange={changeAgent}
                        onPermissionModeChange={changePermissionMode}
                      />
                    )}
                  </Show>
                )}
              </For>
            </div>
          }
        >
          <SubagentList sessions={subagents()} onOpen={selectSession} />
          <Show
            when={selected()}
            fallback={
              mobileRemote() ? (
                mobileComposing() ? (
                  <div class="fc-mobile-new">
                    <p class="fc-onboarding-text">
                      {chatView()
                        ? t("Write a message to start a chat.")
                        : t("Describe a task to start a new session.")}
                    </p>
                  </div>
                ) : (
                  <RemoteHome
                    view={view()}
                    onViewChange={changeView}
                    sessions={remoteSessions()}
                    loading={sessions.loading}
                    projects={projects()}
                    onOpen={openMobileSession}
                    onNew={startMobileSession}
                    onAddDevice={() => setRemoteOpen(true)}
                  />
                )
              ) : chatView() ? (
                <ChatHero displayName={displayName()} />
              ) : (
                <HomeCanvas
                  displayName={displayName()}
                  range={range()}
                  metrics={metrics()}
                  messages={messageCount()}
                  activity={activity()}
                  comparison={comparisonLine()}
                  error={error()}
                  onRangeChange={setRange}
                />
              )
            }
          >
            <PanelBoundary name={t("The conversation")}>
              <SessionView
                messages={activeMessages()}
                sessionKey={selected()}
                loading={messagesLoading()}
                busy={generating()}
                usage={liveUsage()}
                startedAt={generationStartedAt()}
                modelName={modelName}
                showTools={showTools()}
                showReasoning={showReasoning()}
                chat={chatView()}
                pending={pendingForSession()}
                onEditUser={editMessage}
                onForkUser={forkSession}
                onRetry={retryTurn}
              />
            </PanelBoundary>
          </Show>
          <Show when={!mobileRemote() || mobileScreen() === "session"}>
            <div class="fc-docks">
              <Show when={missingModel()}>
                {(ref) => (
                  <ModelUnavailableDock
                    model={ref()}
                    replacement={missingModelReplacement()}
                    disabled={generating()}
                    onUse={(model) => pickModel(model.providerID, model.id)}
                    onChoose={() => setModelPickerOpen(true)}
                  />
                )}
              </Show>
              <For each={permissionData}>
                {(request) => (
                  <PermissionDock
                    request={request}
                    messages={activeMessages()}
                    busy={busy()}
                    onReply={(reply, message) => replyPermission(request, reply, message)}
                  />
                )}
              </For>
              <For each={questionData}>
                {(request) => (
                  <QuestionDock
                    request={request}
                    busy={busy()}
                    onReply={(answers) => replyQuestion(request, answers)}
                    onReject={() => rejectQuestion(request)}
                  />
                )}
              </For>
            </div>
            <Show
              when={!mobileRemote()}
              fallback={
                <MobileComposer
                  mode={view()}
                  value={prompt()}
                  sending={busy()}
                  attachments={attachments()}
                  models={modelList()}
                  modelKey={modelKey()}
                  modelLabel={modelLabel()}
                  favorites={favorites()}
                  variants={variants()}
                  variantKey={variantKey()}
                  agents={agents()?.data ?? []}
                  agent={agent()}
                  permissionMode={permissionModeId()}
                  onInput={setPrompt}
                  onSend={send}
                  onAttach={addAttachments}
                  onRemoveAttachment={removeAttachment}
                  onModelChange={pickModel}
                  onVariantChange={changeVariant}
                  onAgentChange={changeAgent}
                  onPermissionModeChange={changePermissionMode}
                />
              }
            >
              <Composer
                mode={view()}
                value={prompt()}
                sending={busy()}
                generating={!!selected() && generating()}
                onStop={stopSession}
                models={modelList()}
                modelKey={modelKey()}
                favorites={favorites()}
                onModelChange={pickModel}
                modelLabel={modelLabel()}
                variants={variants()}
                variantKey={variantKey()}
                usage={contextUsage()}
                repo={
                  vcsDirectory() && !chatView()
                    ? {
                        directory: vcsDirectory()!,
                        branch: vcsInfo()?.branch,
                        additions: vcsTotals().additions,
                        deletions: vcsTotals().deletions,
                        onCommit: commitChanges,
                        onOpenChanges: openChanges,
                        onClear: !selected() && targetDirectory() ? () => changeTargetDirectory(undefined) : undefined,
                      }
                    : undefined
                }
                pullRequest={
                  vcsDirectory() && !chatView()
                    ? {
                        state: branchState(),
                        creating: openingPullRequest(),
                        suggestedTitle: branchState()?.subject ?? branchState()?.branch ?? "",
                        onOpenPullRequest: openPullRequest,
                        onOpen: (url) => window.open(url, "_blank", "noopener,noreferrer"),
                        onCheckLog: (job) =>
                          createHarnessClient(harnessServerUrl())
                            .git.checkLog(vcsDirectory() ?? "", job)
                            .then((log) => {
                              if (!log) throw new Error(t("Could not read that log"))
                              return log
                            }),
                      }
                    : undefined
                }
                attachments={attachments()}
                commands={commandOptions()}
                projects={projects()}
                targetDirectory={targetDirectory() ?? selectedSession()?.location?.directory}
                agents={agents()?.data ?? []}
                agent={agent()}
                permissionMode={permissionModeId()}
                delivery={delivery()}
                onDeliveryChange={changeDelivery}
                suggestion={currentSuggestion()}
                history={promptHistory()}
                onInput={(value) => {
                  setPrompt(value)
                  if (value) setSuggestion(undefined)
                }}
                onSend={send}
                onCommandPick={(name) => setPrompt(`/${name} `)}
                onCommandRun={(name) => {
                  setPrompt(`/${name} `)
                  send()
                }}
                onOpenModelPicker={() => setModelPickerOpen(true)}
                onVariantChange={changeVariant}
                onAttach={addAttachments}
                onRemoveAttachment={removeAttachment}
                searchFiles={searchFiles}
                onPasteText={collapsePaste}
                onStash={() => stashPrompt(prompt(), true)}
                onTargetChange={changeTargetDirectory}
                onOpenFolder={() => setFolderOpen(true)}
                onAgentChange={changeAgent}
                onPermissionModeChange={changePermissionMode}
              />
            </Show>
            <Show when={chatView() && !selected() && !mobileRemote()}>
              <ChatStarters onPick={(text) => setPrompt(text)} />
            </Show>
          </Show>
        </Show>
      </main>
      <Show when={!mobileRemote() && !chatView()}>
        <PanelBoundary name={t("The side panels")}>
          <WorkspacePanels
            panels={panels()}
            serverUrl={serverUrl()}
            session={selectedSession()}
            revision={[messages(), vcsStatus()]}
            changedFiles={changedFiles()}
            onOpenChanges={openChanges}
            width={workspaceWidth()}
            onResize={updateWorkspaceWidth}
            onClose={closePanel}
          />
        </PanelBoundary>
        <Show when={contextPanelShown()}>
          <PanelBoundary name={t("The context panel")}>
            <RightAside
              usage={contextUsage()}
              todos={todos()}
              onClearTodos={clearTodos}
              width={contextWidth()}
              onResize={updateContextWidth}
              onHide={toggleContextPanel}
              serverUrl={serverUrl()}
              sessionID={selected()}
            />
          </PanelBoundary>
        </Show>
      </Show>
      </div>
      <CommandPalette
        open={paletteOpen()}
        commands={commandOptions()}
        sessions={sessionList() ?? []}
        projects={projects()}
        artifacts={artifactList()}
        routines={routines()}
        runs={runs()}
        onClose={() => setPaletteOpen(false)}
        onCommand={runCommand}
        onSession={selectSession}
        onProject={(directory) => {
          leaveScreen()
          changeTargetDirectory(directory)
        }}
        onArtifact={() => showScreen("artifacts")}
        onRoutine={(id) => {
          setRoutineFocus(id)
          showScreen("routines")
        }}
        onRun={() => showScreen("runs")}
        onFile={(path) => setPrompt((value) => (value ? `${value} @${path} ` : `@${path} `))}
        searchFiles={searchFiles}
      />
      <McpManager
        open={mcpOpen()}
        servers={mcp()?.data ?? []}
        busy={busy()}
        onAdd={addMcp}
        onRemove={removeMcp}
        onConnect={connectMcp}
        onDisconnect={disconnectMcp}
        onClose={() => setMcpOpen(false)}
        onBack={() => {
          setMcpOpen(false)
          setSettingsOpen(true)
        }}
      />
      <ProvidersPanel
        open={providersOpen()}
        providers={providerDirectory()?.all ?? []}
        auth={providerAuth() ?? {}}
        connected={providerDirectory()?.connected ?? []}
        integrations={integrations()?.data ?? []}
        unlinked={unlinkedProviders() ?? []}
        busy={busy()}
        onSave={saveProvider}
        onRemove={removeProvider}
        onOAuth={startOAuth}
        onOAuthStatus={oAuthStatus}
        onOAuthCancel={cancelOAuth}
        onOAuthDone={finishOAuth}
        onLinkConfigured={linkConfiguredKeys}
        onClose={() => setProvidersOpen(false)}
      />
      <ModelPicker
        open={modelPickerOpen()}
        models={modelList()}
        loading={models.loading}
        selectedKey={modelKey()}
        favorites={favorites()}
        onSelect={pickModel}
        onToggleFavorite={toggleFavoriteModel}
        onRetry={() => void refetchModels()}
        onClose={() => setModelPickerOpen(false)}
      />
      <About
        open={aboutOpen()}
        onClose={() => setAboutOpen(false)}
        onBack={() => {
          setAboutOpen(false)
          setSettingsOpen(true)
        }}
      />
      <StashDialog
        open={stashOpen()}
        items={stashes()}
        onRestore={restoreStash}
        onRemove={removeStash}
        onClose={() => setStashOpen(false)}
      />
      <RenameDialog
        open={!!renameTarget()}
        title={t("Rename")}
        initial={renameTarget()?.title ?? ""}
        onSave={commitRename}
        onClose={() => setRenameTarget(undefined)}
      />
      <SettingsPanel
        open={settingsOpen()}
        theme={theme()}
        colorTheme={colorTheme()}
        locale={getLocale()}
        displayName={displayName()}
        serverInput={serverInput()}
        serverStatus={serverStatus()}
        engineProfile={engineProfile()}
        engineVersion={health()?.version}
        engineVersionMismatch={engineVersionMismatch()}
        running={generating()}
        models={modelList()}
        modelKey={modelKey()}
        showTools={showTools()}
        showReasoning={showReasoning()}
        replySuggestions={suggestionsOn()}
        onToggleReplySuggestions={toggleSuggestions}
        suggestionModel={suggestionModel()}
        onSuggestionModel={(key) => {
          setSuggestionModel(key)
          writeStorage(STORAGE_KEYS.suggestionModel, key)
        }}
        notifications={notifications()}
        paletteKey={paletteKey()}
        savedPermissions={savedPermissions()?.data ?? []}
        onRevokePermission={revokePermission}
        onTheme={updateTheme}
        onColorTheme={updateColorTheme}
        onLocale={setLocale}
        onDisplayName={updateDisplayName}
        onServerInput={setServerInput}
        onServerCommit={commitServer}
        onModelChange={changeModel}
        onToggleTools={() => setShowTools((value) => !value)}
        onToggleReasoning={toggleReasoning}
        onToggleNotifications={toggleNotifications}
        onPaletteKey={changePaletteKey}
        onOpenMcp={() => {
          setSettingsOpen(false)
          setMcpOpen(true)
        }}
        onOpenRemote={() => {
          setSettingsOpen(false)
          setRemoteOpen(true)
        }}
        onOpenConfig={() => {
          setSettingsOpen(false)
          setConfigOpen(true)
        }}
        onOpenAbout={() => {
          setSettingsOpen(false)
          setAboutOpen(true)
        }}
        onClose={() => setSettingsOpen(false)}
      />
      <RunsPanel
        open={runsOpen()}
        runs={runs()}
        serverAvailable={routinesServerAvailable()}
        onStop={stopRun}
        onRemove={removeRun}
        onClear={clearRuns}
        onStopAll={stopAllRuns}
        onApprove={approveRun}
        activity={taskActivity() ?? {}}
        touched={touched() ?? {}}
        onOpenSession={(id) => {
          leaveScreen()
          selectSession(id)
        }}
        onClose={() => leaveScreen()}
      />
      <SkillCatalogue
        open={skillsScreenOpen()}
        files={skillFiles() ?? []}
        skills={skills()?.data ?? []}
        loading={skillFiles.loading}
        serverAvailable={routinesServerAvailable()}
        hasProject={!!vcsDirectory()}
        onRead={readSkillFile}
        onSave={saveSkill}
        onDelete={deleteSkillFile}
        onClose={() => leaveScreen()}
      />
      <AgentsPanel
        open={agentsOpen()}
        files={agentFiles() ?? []}
        agents={folderAgents() ?? []}
        tools={engineTools() ?? []}
        mcp={mcp()?.data ?? []}
        models={agentModels()}
        loading={agentFiles.loading}
        serverAvailable={routinesServerAvailable()}
        hasProject={!!vcsDirectory()}
        onSave={saveAgent}
        onDelete={deleteAgent}
        onClose={() => leaveScreen()}
      />
      <ContextPanel
        open={contextOpen()}
        directory={vcsDirectory()}
        report={contextReport()}
        loading={contextReport.loading}
        serverAvailable={routinesServerAvailable()}
        skills={skills()?.data ?? []}
        agents={agents()?.data ?? []}
        agent={agent()}
        tools={engineTools() ?? []}
        mcp={mcp()?.data ?? []}
        tokens={contextTokens()}
        compactions={compactions()}
        onRead={readInstruction}
        onClose={() => leaveScreen()}
      />
      <UsagePanel
        open={usageOpen()}
        report={usage()}
        loading={usage.loading}
        error={usage.error ? (usage.error instanceof Error ? usage.error.message : String(usage.error)) : undefined}
        days={usageDays()}
        onDays={setUsageDays}
        directory={vcsDirectory()}
        onlyProject={usageOnlyProject()}
        onOnlyProject={setUsageOnlyProject}
        serverAvailable={routinesServerAvailable()}
        onOpenRuns={() => showScreen("runs")}
        onClose={() => leaveScreen()}
      />
      <ChangesPanel
        open={changesOpen()}
        directory={vcsDirectory()}
        branch={vcsInfo()?.branch}
        defaultBranch={vcsInfo()?.default_branch}
        changes={changes() ?? []}
        loading={changes.loading}
        error={changesError()}
        mode={diffMode()}
        canCommit={routinesServerAvailable()}
        committing={committing()}
        onMode={setDiffMode}
        onRefresh={() => void refetchChanges()}
        onCommit={commitPicked}
        onBranch={startBranch}
        checkpoints={checkpoints() ?? []}
        checkpointBusy={checkpointBusy()}
        onCheckpointPlan={checkpointPlan}
        onCheckpointRestore={restoreCheckpoint}
        onCheckpointTake={takeCheckpoint}
        onCheckpointRemove={removeCheckpoint}
        findings={findings() ?? []}
        onResolveFinding={resolveFinding}
        onClose={() => leaveScreen()}
      />
      <RoutinesPanel
        open={routinesOpen()}
        focus={routineFocus()}
        onFocused={() => setRoutineFocus(undefined)}
        routines={routines()}
        busy={routineBusy()}
        busyRoutineID={routineBusyID()}
        serverAvailable={routinesServerAvailable()}
        serverLoading={routinesServerLoading()}
        projects={routineProjects()}
        models={modelList()}
        agents={agents()?.data ?? []}
        onAdd={addRoutine}
        onUpdate={updateRoutine}
        onToggle={toggleRoutine}
        onRemove={removeRoutine}
        onRun={runRoutine}
        onStop={stopRoutine}
        onOpenSession={(id) => {
          leaveScreen()
          selectSession(id)
        }}
        onClose={() => leaveScreen()}
      />
      <FolderDialog
        open={folderOpen()}
        initial={targetDirectory()}
        recents={projects()
          .map((project) => project.directory)
          .filter((directory) => directory !== chatsDirectory())}
        home={async () => (await client().paths()).home}
        list={(directory, path) => client().file.list({ directory, path })}
        onOpen={(path) => {
          setTargetDirectory(path)
          setFolderOpen(false)
        }}
        onClose={() => setFolderOpen(false)}
      />
      <Onboarding
        open={!onboarded() && !remote.activeHost() && !remote.pairing() && remote.status() !== "connecting"}
        remoteClient={!desktopRemote()}
        onRemote={(name) => {
          completeOnboarding(name)
          setRemoteOpen(true)
        }}
        serverHealthy={health()?.healthy}
        serverBlocked={health()?.blocked === true}
        engineProfile={engineProfile()}
        serverInput={serverInput()}
        onServerInput={setServerInput}
        onConnect={() => {
          commitServer()
          void refetchHealth()
        }}
        onDone={completeOnboarding}
      />
      <RemotePanel
        open={remoteOpen()}
        initialUrl={serverUrl()}
        onClose={() => {
          setRemoteOpen(false)
          remote.dismissPairing()
        }}
        onBack={() => {
          setRemoteOpen(false)
          setSettingsOpen(true)
        }}
      />
      <ArtifactsPanel
        open={artifactsOpen()}
        artifacts={artifactList()}
        sessionFiles={artifacts()}
        serverAvailable={routinesServerAvailable()}
        onCopy={copyPath}
        onRemove={removeArtifact}
        onOpenRun={() => showScreen("runs")}
        onClose={() => leaveScreen()}
      />
      <SkillsPanel
        open={skillsOpen()}
        skills={skills()?.data ?? []}
        onInsert={(name) => {
          setPrompt(`/${name} `)
          setSkillsOpen(false)
        }}
        onClose={() => setSkillsOpen(false)}
      />
      <MemoryPanel open={memoryOpen()} serverUrl={serverUrl()} onClose={() => setMemoryOpen(false)} />
      <ConfigPanel
        open={configOpen()}
        serverUrl={serverUrl()}
        onClose={() => setConfigOpen(false)}
        onBack={() => {
          setConfigOpen(false)
          setSettingsOpen(true)
        }}
      />
      <ImagePreview />
      {/* Drawn last: the warning opens over the modal that asked for the change (Customize, the picker). */}
      <ModelSwitchDialog
        open={!!pendingModelSwitch()}
        from={pendingModelSwitch()?.from ?? ""}
        to={pendingModelSwitch()?.to ?? ""}
        onCancel={() => setPendingModelSwitch(undefined)}
        onConfirm={(skipNextTime) => {
          const pending = pendingModelSwitch()
          if (!pending) return
          rememberModelSwitch(skipNextTime)
          setPendingModelSwitch(undefined)
          applyModel(pending.next.providerID, pending.next.id)
        }}
      />
      <Toaster />
    </div>
  )
}
