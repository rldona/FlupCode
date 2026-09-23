import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type Component } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { RemoteHostState } from "@flupcode/remote"
import { createResource } from "./resource"
import { createReconciledList } from "./reconciled"
import { compareFromSearch, screenFromPath, searchForCompare, urlForScreen, type Screen } from "./screen"
import { ChangesPanel, type DiffMode } from "./components/ChangesPanel"
import { UsagePanel } from "./components/UsagePanel"
import { AgentsPanel } from "./components/AgentsPanel"
import { SkillCatalogue } from "./components/SkillCatalogue"
import { FilesPanel } from "./components/FilesPanel"
import { ExportDialog } from "./components/ExportDialog"
import { downloadFile, sessionJson, sessionMarkdown, type ExportMessage, type ExportOptions } from "./export"
import { addSource, removeSource, normalizeSources, EMPTY_SOURCES, type SkillSourceKind, type SkillSources } from "./skill-sources"
import { ContextPanel, type ContextTokens } from "./components/ContextPanel"
import type { TaskActivity, TaskTools, TouchedFiles } from "./types"
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
  isSessionGone,
  probeEngineProfile,
  probeServer,
  resolveHarnessServerUrl,
  resolveServerUrl,
} from "./client"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"
import { activityByDay, computeMetrics, contextFigures, filterByRange, type UsageRange } from "./metrics"
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
import { CHAT_PERMISSION, CHAT_SYSTEM, COWORK_AGENT, COWORK_SYSTEM, sessionChatClass, type AppView, type ChatClass } from "./chat"
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
import { questionSessions as findQuestionSessions, type PendingRequest } from "./pending-questions"
import { recoverablePrompt } from "./unsend"
import { browser, isLocalPreview } from "./browser"
import type { ModelInfo, SessionInfo, ConsoleOrg } from "./engine-types"
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
  SessionPrefs,
  Task,
  Workflow,
  WorkflowFile,
  StashedPrompt,
  ContextPack,
  ProjectMemory,
} from "./types"
import { UNAVAILABLE_FEATURES } from "./features"
import {
  KEYBIND_ACTIONS,
  loadKeybinds,
  matchesKeybind,
  withKeybind,
  type KeybindAction,
  type Keybinds,
} from "./keybinds"
import { getLocale, setLocale, t, type Locale } from "./i18n"
import { ImagePreview } from "./image-preview"
import { Toaster, clearToast, toast } from "./toast"
import { SIDEBAR_WIDTH_DEFAULT, Sidebar, sessionGroupKey } from "./components/Sidebar"
import { About } from "./components/About"
import { Topbar } from "./components/Topbar"
import { HomeCanvas } from "./components/HomeCanvas"
import { Composer } from "./components/Composer"
import { PermissionDock, type PermissionReply } from "./components/PermissionDock"
import { QuestionDock } from "./components/QuestionDock"
import { CommandPalette } from "./components/CommandPalette"
import { SessionView } from "./components/SessionView"
import { SessionActions, SessionTitle } from "./components/SessionToolbar"
import { CONTEXT_PANEL_WIDTH, RightAside } from "./components/RightAside"
import { WORKSPACE_WIDTH_DEFAULT, WorkspacePanels } from "./components/WorkspacePanels"
import type { CommandDraft } from "./components/CommandsPanel"
import { ModelPicker } from "./components/ModelPicker"
import { ModelSwitchDialog } from "./components/ModelSwitchDialog"
import { ModelUnavailableDock } from "./components/ModelUnavailableDock"
import { FolderDialog } from "./components/FolderDialog"
import { RenameDialog } from "./components/RenameDialog"
import { TagsDialog } from "./components/TagsDialog"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { permissionMode } from "./permission-modes"
import { StashDialog } from "./components/StashDialog"
import { SettingsPanel, type SettingsSection } from "./components/SettingsPanel"
import { RoutinesPanel } from "./components/RoutinesPanel"
import { RunsPanel } from "./components/RunsPanel"
import { Onboarding } from "./components/Onboarding"
import { RemotePanel } from "./components/RemotePanel"
import { ArtifactsPanel } from "./components/ArtifactsPanel"
import { SkillsPanel } from "./components/SkillsPanel"
import { WorkflowsPanel } from "./components/WorkflowsPanel"
import { WorkflowLaunchDialog, type WorkflowLaunch } from "./components/WorkflowLaunchDialog"
import { BestOfNDialog, type BestOfNLaunch } from "./components/BestOfNDialog"
import { ReplayPanel } from "./components/ReplayPanel"
import { ComparePanel } from "./components/ComparePanel"
import { runSnapshot } from "./compare"
import { MemoryPanel } from "./components/MemoryPanel"
import { ConfigPanel } from "./components/ConfigPanel"
import { canOpenLocalFiles, desktopRemote, openInEditor, openLocalPath, remote, remoteBaseUrl, touchDevice } from "./remote"
import { RemoteHome, type RemoteSessionItem } from "./components/RemoteHome"
import { ChatHero, ChatStarters } from "./components/ChatHome"
import { SessionPane } from "./components/SessionPane"
import { SessionTabs } from "./components/SessionTabs"
import { PanelBoundary } from "./components/PanelBoundary"
import { closePane, keepExisting, openInSplit, showInFocusedPane } from "./split"
import { closeTab, cycleTab, keepTabs, openTab, tabAfterClose } from "./tabs"
import { publishSessionEvent } from "./session-events"
import { annotateLocalNetwork, askLocalNetwork, engineFetch } from "./transport"
import {
  addressSpaceOf,
  localNetworkGated,
  localNetworkPermissions,
  queryLocalNetworkPermission,
  type LocalNetworkState,
} from "./local-network"
import { normalizeRoutineSchedule } from "./routine-schedule"
import { skillifyPrompt } from "./skillify"
import { resumePrompt } from "./resume"

type Client = ReturnType<typeof createClient>

// The FlupCode palette is the default, so anything unknown falls back to it. "default" was the
// neutral palette's id before it was renamed to "classic".
function readColorTheme() {
  const saved = readStorage<string>(STORAGE_KEYS.colorTheme, "flupcode")
  if (saved === "classic" || saved === "default") return "classic"
  if (saved === "sublime") return "sublime"
  if (saved === "sublime-dark") return "sublime-dark"
  if (saved === "github") return "github"
  if (saved === "copilot") return "copilot"
  if (saved === "vercel") return "vercel"
  return "flupcode"
}

/** Whether a key event is going into a text field, where a bare shortcut must not fire. */
function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null
  if (!element) return false
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.isContentEditable
}

/**
 * App actions reachable from the palette and the composer's slash menu (H-24). `session` marks the
 * ones that need an open session, so they are not offered when there is none.
 */
const BUILTIN_COMMANDS: Array<{ name: string; descriptionKey: string; session?: boolean }> = [
  { name: "new", descriptionKey: "New session…" },
  { name: "compact", descriptionKey: "Compact the current session", session: true },
  { name: "resume", descriptionKey: "Checkpoint of this session", session: true },
  { name: "steps", descriptionKey: "Show or hide tool steps" },
  { name: "mcp", descriptionKey: "MCP servers…" },
  { name: "stash", descriptionKey: "Save the current prompt" },
  { name: "stashes", descriptionKey: "View saved prompts" },
  { name: "skills", descriptionKey: "Skills" },
  { name: "workflows", descriptionKey: "Workflows" },
  { name: "replay", descriptionKey: "Replay this session", session: true },
  { name: "compare", descriptionKey: "Compare two runs" },
  { name: "best-of-n", descriptionKey: "Best of N: one task, several models" },
  { name: "skillify", descriptionKey: "Save this session as a skill", session: true },
  { name: "next-tab", descriptionKey: "Next session tab" },
  { name: "prev-tab", descriptionKey: "Previous session tab" },
  { name: "close-tab", descriptionKey: "Close this session tab", session: true },
  { name: "memory", descriptionKey: "Memory" },
  { name: "config", descriptionKey: "Config (advanced)" },
  { name: "settings", descriptionKey: "Customize FlupCode" },
  { name: "routines", descriptionKey: "Scheduled tasks" },
  { name: "remote", descriptionKey: "Remote control / mobile" },
  { name: "artifacts", descriptionKey: "Artifacts" },
  { name: "files", descriptionKey: "Files" },
  { name: "about", descriptionKey: "About FlupCode" },
  // Actions that used to live only in a menu, now reachable from the launcher too (H-24). Kept at
  // the end so the ones people already know stay where they were.
  { name: "split", descriptionKey: "Split view", session: true },
  { name: "rename", descriptionKey: "Rename session", session: true },
  { name: "pin", descriptionKey: "Pin or unpin this session", session: true },
  { name: "archive", descriptionKey: "Archive this session", session: true },
  { name: "delete", descriptionKey: "Delete this session", session: true },
  { name: "toggle-sidebar", descriptionKey: "Toggle sidebar" },
  { name: "providers", descriptionKey: "Providers & API keys" },
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
    workflow:
      item.workflow && typeof item.workflow === "object" && "name" in item.workflow &&
      typeof (item.workflow as { name: unknown }).name === "string" &&
      (item.workflow as { name: string }).name.trim()
        ? {
            name: (item.workflow as { name: string }).name.trim(),
            inputs: (item.workflow as { inputs?: unknown }).inputs as Record<string, string> | undefined,
          }
        : undefined,
    policy: (item.policy ?? undefined) as Routine["policy"],
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
  // A fold this app asked for is in flight. The engine's own folds are read from the transcript,
  // but this app answers the request directly, so the transcript does not show it yet.
  const [compactingManually, setCompactingManually] = createSignal(false)
  const [routineBusy, setRoutineBusy] = createSignal(false)
  const [routineBusyID, setRoutineBusyID] = createSignal<string>()
  const [routineRunID, setRoutineRunID] = createSignal<string>()
  const [streamedChars, setStreamedChars] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal(readStorage(STORAGE_KEYS.sidebarCollapsed, false))
  // Closed until there is something to watch, or until the reader opens it: the conversation gets
  // the room, and the panel's own effect opens it for work and closes it when the work is done.
  const [contextHidden, setContextHidden] = createSignal(readStorage(STORAGE_KEYS.contextPanelHidden, true))
  const [contextWidth, setContextWidth] = createSignal(
    readStorage(STORAGE_KEYS.contextPanelWidth, CONTEXT_PANEL_WIDTH.default),
  )
  const [narrow, setNarrow] = createSignal(typeof window !== "undefined" && window.innerWidth < 768)
  // Phones controlling a computer get their own layout: a sessions home and a focused session screen.
  const mobileRemote = () => touchDevice && !desktopRemote() && !!remote.activeHost()
  const [mobileComposing, setMobileComposing] = createSignal(false)
  // Run state from the event stream; it takes precedence over the last activity snapshot.
  const [runState, setRunState] = createSignal<Record<string, boolean>>({})
  // Why a session is stalled while the engine retries a failed provider call, kept per session so
  // the status line can say "Usage limit exceeded" instead of thinking on forever.
  const [retryState, setRetryState] = createSignal<Record<string, { message: string; attempt: number }>>({})
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
    setRetryState(({ [sessionID]: _dropped, ...rest }) => rest)
  }
  // A v2 run is many steps, and the next one only starts once the model streams again, so a step's end
  // says nothing about the run; nor does anything arrive when a run is stopped between steps. While a
  // run goes on, ask the engine whether it still lists the session as active. A legacy turn — every
  // Code and Chat turn — never appears there, only in its folder's status map, so both are asked: a
  // lost `session.idle` otherwise leaves the status line spinning over a turn that already ended.
  const watchRun = (sessionID: string, delay: number) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.set(
      sessionID,
      setTimeout(async () => {
        const engine = createClient(serverUrl())
        const directory = sessionDirectory(sessionID)
        const [active, status] = await Promise.all([
          engine.session.active().catch(() => undefined),
          directory ? engine.session.status({ directory }).catch(() => undefined) : undefined,
        ])
        if (!idleTimers.has(sessionID)) return
        // A poll nobody answered says nothing. Clearing the run on a missing answer would end the
        // status line because the engine was briefly unreachable, which is the very thing this poll
        // exists to prevent, so keep the run and ask again.
        if (active === undefined && status === undefined) return watchRun(sessionID, 2000)
        if (active?.has(sessionID) !== true && status?.has(sessionID) !== true) return setRunning(sessionID, false)
        setRunState((state) => (state[sessionID] ? state : { ...state, [sessionID]: true }))
        watchRun(sessionID, 2000)
      }, delay),
    )
  }
  const trackActivity = (
    type: string,
    data: { sessionID?: string; status?: { type?: string; message?: string; attempt?: number } } | undefined,
  ) => {
    const sessionID = data?.sessionID
    if (!sessionID) return
    if (type === "session.next.prompted" || type === "session.next.step.started") {
      setRunState((state) => (state[sessionID] ? state : { ...state, [sessionID]: true }))
      return watchRun(sessionID, 2000)
    }
    if (type === "session.next.step.ended" || type === "session.next.step.failed") return watchRun(sessionID, 700)
    // Legacy runs (chats) report their own status, which already spans every step.
    const status = data?.status?.type
    if (status === "busy" || status === "retry") {
      setRunning(sessionID, true)
      // The turn's end arrives as `session.idle` on a stream; when that is lost, this poll notices.
      if (sessionDirectory(sessionID)) watchRun(sessionID, 2000)
    }
    // The engine only says why it is waiting while it retries, so the notice is kept until the turn
    // moves on; otherwise the status line falls back to "Thinking…" between attempts.
    setRetryState((state) => {
      if (status === "retry")
        return {
          ...state,
          [sessionID]: { message: data?.status?.message ?? "", attempt: data?.status?.attempt ?? 1 },
        }
      if (!state[sessionID]) return state
      if (status === "busy" || status === "idle" || type === "session.idle")
        return Object.fromEntries(Object.entries(state).filter(([key]) => key !== sessionID))
      return state
    })
    if (type === "session.idle" || status === "idle") setRunning(sessionID, false)
  }
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
  const [showTools, setShowTools] = createSignal(readStorage(STORAGE_KEYS.showTools, true))
  const toggleTools = () => {
    const next = !showTools()
    setShowTools(next)
    writeStorage(STORAGE_KEYS.showTools, next)
  }
  // The model's thinking stays out of the conversation unless it is asked for, as in Claude Code.
  const [showReasoning, setShowReasoning] = createSignal(readStorage(STORAGE_KEYS.showReasoning, false))
  const toggleReasoning = () => {
    const next = !showReasoning()
    setShowReasoning(next)
    writeStorage(STORAGE_KEYS.showReasoning, next)
  }
  // Open sessions as a tab strip (H-36). Off by default: a window that opens one session at a time
  // reads cleaner, and the strip is a preference rather than the shape of the app.
  const [sessionTabsEnabled, setSessionTabsEnabled] = createSignal(
    readStorage(STORAGE_KEYS.sessionTabsEnabled, false),
  )
  const toggleSessionTabs = () => {
    const next = !sessionTabsEnabled()
    setSessionTabsEnabled(next)
    writeStorage(STORAGE_KEYS.sessionTabsEnabled, next)
  }
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  /** The settings section to show when the panel opens (CU-1). */
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection | undefined>(undefined)
  /** Settings, opened on a section: agents and the rest live on one surface (F4-3). */
  const openSettings = (section?: SettingsSection) => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }
  /** The agents section is showing: its files, tools and models load like a screen did. */
  const agentsSectionVisible = () => settingsOpen() && settingsSection() === "agents"
  // Which full screen is open, and where in the URL it lives, so a reload comes back to it and the
  // browser's Back leaves it. One signal rather than a flag per screen: only one can be open, and
  // two flags could disagree.
  const [screen, setScreen] = createSignal<Screen | undefined>(screenFromPath(window.location.pathname))
  // The pair a comparison link names (H-44). Kept beside the screen because both arrive in the same
  // address: a best-of-n lands on /compare?left=…&right=…, and a reload comes back to the same pair.
  const [compareArgs, setCompareArgs] = createSignal(compareFromSearch(window.location.search))
  const showScreen = (next: Screen | undefined, search?: string) => {
    const same = screen() === next
    setScreen(next)
    if (same && search === undefined) return
    window.history.pushState(
      null,
      "",
      search === undefined
        ? urlForScreen(next, window.location)
        : urlForScreen(next, { search, hash: window.location.hash }),
    )
  }
  const routinesOpen = () => screen() === "routines"
  const runsOpen = () => screen() === "runs"
  const artifactsOpen = () => screen() === "artifacts"
  const filesOpen = () => screen() === "files"
  const changesOpen = () => screen() === "changes"
  const usageOpen = () => screen() === "usage"
  const contextOpen = () => screen() === "context"
  const agentsOpen = () => screen() === "agents"
  const skillsScreenOpen = () => screen() === "skills"
  const workflowsScreenOpen = () => screen() === "workflows"
  const replayOpen = () => screen() === "replay"
  const compareOpen = () => screen() === "compare"
  /**
   * The tool screens that live in the main column (HF-9): runs, workflows, artifacts, changes,
   * routines, context, agents, skills and usage render where the conversation goes, with the
   * sidebar visible, instead of a fixed overlay. Anything else keeps its overlay.
   */
  const toolScreen = () => {
    const current = screen()
    return (
      current === "runs" ||
      current === "workflows" ||
      current === "changes" ||
      current === "artifacts" ||
      current === "routines" ||
      current === "context" ||
      current === "agents" ||
      current === "skills" ||
      current === "usage" ||
      current === "compare"
    )
  }
  /** Leave whatever screen is open. Doing anything with a session means leaving it. */
  const leaveScreen = () => showScreen(undefined)
  createEffect(() => {
    const follow = () => {
      setScreen(screenFromPath(window.location.pathname))
      setCompareArgs(compareFromSearch(window.location.search))
    }
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
  /** The providers section is showing: its directory, methods and links load like a screen did. */
  const providersSectionVisible = () => settingsOpen() && settingsSection() === "providers"
  const [folderOpen, setFolderOpen] = createSignal(false)

  const [skillsOpen, setSkillsOpen] = createSignal(false)
  const [memoryOpen, setMemoryOpen] = createSignal(false)
  const [configOpen, setConfigOpen] = createSignal(false)
  const [notifications, setNotifications] = createSignal(readStorage(STORAGE_KEYS.notifications, false))
  const [keybinds, setKeybinds] = createSignal<Keybinds>(
    loadKeybinds(
      readStorage<Partial<Keybinds> | undefined>(STORAGE_KEYS.keybinds, undefined),
      readStorage<string | undefined>(STORAGE_KEYS.paletteKey, undefined),
    ),
  )
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
  const [tagsTarget, setTagsTarget] = createSignal<{ id: string; title: string; tags: string[] }>()
  // What a destructive action asks before doing it (H-24), instead of `window.confirm`.
  const [confirmTarget, setConfirmTarget] = createSignal<{
    title: string
    message: string
    confirmLabel?: string
    onConfirm: () => void
  }>()
  // Filled from the harness server below (H-18): a stash kept in the browser was neither durable
  // nor visible on the phone.
  const [stashes, setStashes] = createSignal<StashedPrompt[]>([])
  // The refs of a draft being saved as a context pack (H-26): set when the composer asks, cleared
  // once the name dialog answers.
  const [packRefs, setPackRefs] = createSignal<string[] | undefined>()

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
      const asked = await askLocalNetwork(`${serverUrl().replace(/\/$/, "")}/global/health`, engine)
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
      if (result.healthy) return { ...result, blocked: false, authRequired: false }
      const status = await probeServer(url)
      return { ...result, blocked: status === "blocked", authRequired: status === "unauthorized" }
    },
  )
  // The engine answers but refuses the call: it was started with `OPENCODE_SERVER_PASSWORD`, and a
  // browser page has no credentials to send (only the desktop app injects any). Named apart from a
  // stopped engine so the banner can point at the fix instead of "start it".
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
      Boolean(localNetworkEngine() && health()?.blocked) && (localNetwork() === "prompt" || localNetwork() === "denied"),
  )
  // Only probed once the engine answers, so the onboarding can tell FlupCode's build from the
  // stock OpenCode CLI, whose extras (permission modes, memory) are missing.
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
  // How many sessions one page asks for (H-18), and how many pages are loaded. The list used to stop
  // at a hard 200; the engine returns a cursor instead, so "Load more" walks it a page at a time and
  // the oldest session stays reachable without fetching everything.
  const SESSION_PAGE = 80
  const [sessionPages, setSessionPages] = createSignal(1)
  const [sessions, { refetch: refetchSessions }] = createResource(
    () => (ready() ? `${serverUrl()}\n${sessionPages()}` : undefined),
    async (key) => {
      const [url = "", pages = "1"] = key.split("\n")
      const client = createClient(url)
      const data: SessionInfo[] = []
      let cursor: string | undefined
      for (let page = 0; page < Number(pages); page++) {
        const response = await client.session.list({ limit: SESSION_PAGE, cursor })
        data.push(...(response.data ?? []))
        cursor = response.cursor?.next ?? undefined
        // A short page is the end of the list: asking again would only get less.
        if ((response.data?.length ?? 0) < SESSION_PAGE || !cursor) break
      }
      return { data, cursor: { next: cursor } }
    },
  )
  // The engine sets a cursor beside every non-empty page, so the cursor alone cannot say whether
  // more exist. A page that came back full is the honest signal; a short one is the end of the list.
  const hasMoreSessions = () => {
    const result = sessions()
    const count = result?.data?.length ?? 0
    return count > 0 && count % SESSION_PAGE === 0 && !!result?.cursor?.next
  }
  const loadMoreSessions = () => setSessionPages((pages) => pages + 1)
  // Server-side session search (H-18), for the palette: it reaches sessions the page above never
  // loaded. The title is what the engine matches; the palette still searches folders too.
  const searchSessions = (query: string) =>
    createClient(serverUrl())
      .session.list({ search: query, limit: 50 })
      .then((response) => response.data ?? [])
      .catch(() => [] as SessionInfo[])
  // Reply suggestions run in throwaway child sessions that are never shown.
  const sessionList = () => sessions()?.data?.filter((session) => !isSuggestionSession(session))
  // The sessions working right now, listed under the home card. Top-level only: a child's work is
  // its parent's, and the parent is what a click should open.
  const activeSessions = createMemo(() =>
    (sessionList() ?? [])
      .filter((session) => !session.parentID && !session.time.archived && runState()[session.id] === true)
      .sort((a, b) => b.time.updated - a.time.updated),
  )
  const selectedSession = () => sessionList()?.find((session) => session.id === selected())
  // The walk back from this session to its root, oldest first, for the breadcrumb (H-18). A parent
  // not on the loaded page stops the walk rather than inventing a step.
  const lineage = createMemo(() => {
    const start = selectedSession()
    if (!start) return []
    const chain = [start]
    const seen = new Set([start.id])
    let parentID = start.parentID
    while (parentID && !seen.has(parentID)) {
      const parent = sessionList()?.find((session) => session.id === parentID)
      if (!parent) break
      chain.unshift(parent)
      seen.add(parent.id)
      parentID = parent.parentID
    }
    return chain
  })
  // A project the reader opened a session in stays open. The list used to expand only the selected
  // session's project and collapse the previous one, so choosing a session lower down removed the
  // rows above it and the sidebar's scroll jumped up. Expansion is now something the list only adds.
  // The group key comes from the sidebar so the no-folder bucket is kept open too.
  createEffect(() => {
    const session = selectedSession()
    if (!session) return
    const key = sessionGroupKey(session, noFolderSessions())
    if (expanded()[key]) return
    const next = { ...expanded(), [key]: true }
    setExpanded(next)
    writeStorage(STORAGE_KEYS.expandedProjects, next)
  })
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
  type ClassifiedSession = { agent?: string; location?: { directory?: string } }
  // A chat-class session is one of the two conversations in the chat tab: a plain chat, which lives
  // in the engine's state folder, or a Cowork chat, which runs in the project under its reserved
  // agent. Everything else is a code session. See chat.ts and ADR-0013.
  const chatClass = (session: ClassifiedSession | undefined): ChatClass | undefined =>
    session ? sessionChatClass(session, chatsDirectory()) : undefined
  const isPlainChat = (session: ClassifiedSession | undefined) => chatClass(session) === "chat"
  const isChatLike = (session: ClassifiedSession | undefined) => chatClass(session) !== undefined
  // Which tab's icon earns a dot: any session working under that kind. Chat covers chats and Cowork.
  const viewActivity = createMemo(() => ({
    chat: activeSessions().some((session) => isChatLike(session)),
    code: activeSessions().some((session) => !isChatLike(session)),
  }))
  const selectedChatClass = () => chatClass(selectedSession())
  // The Chat/Cowork choice for the next new conversation, remembered like the tab itself. A
  // selected session answers with its own class; with none, the remembered choice does.
  const [chatMode, setChatMode] = createSignal<ChatClass>(readStorage<ChatClass>(STORAGE_KEYS.chatMode, "chat"))
  const composerChatClass = (): ChatClass | undefined =>
    chatView() ? (selectedChatClass() ?? chatMode()) : undefined
  const plainChatView = () => chatView() && composerChatClass() === "chat"
  // The Code chrome Cowork earns: repo bar, workspace panels, context panel.
  const codeChrome = () => !plainChatView()
  const changeChatClass = (next: ChatClass) => {
    setChatMode(next)
    writeStorage(STORAGE_KEYS.chatMode, next)
    if (!selected() || selectedChatClass() === next) return
    // Leaving a conversation of the other class goes to this class's home, keeping the draft.
    const sessionID = selected()
    if (sessionID && !messagesLoading() && (activeMessages() ?? []).length === 0) {
      void createClient(serverUrl())
        .session.remove({ sessionID })
        .then(() => refetchSessions())
        .catch(() => undefined)
    }
    setSelected(undefined)
    setMobileComposing(false)
  }
  // Sessions the engine forked for a subagent live in the context panel, under the parent they
  // belong to; as rows in this column they read as projects of their own.
  const viewSessions = () =>
    sessionList()?.filter((session) => isChatLike(session) === chatView() && !session.parentID)
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
      const kind: AppView = isChatLike(session) ? "chat" : "code"
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
    const kind: AppView = isChatLike(session) ? "chat" : "code"
    if (kind !== untrack(view)) {
      setView(kind)
      writeStorage(STORAGE_KEYS.view, kind)
    }
  })
  // The Build/Plan switch follows the open session's agent. `untrack` keeps the effect from
  // fighting the optimistic update when the reader picks an agent in the dock. Chat-class sessions
  // never set it: Cowork's marker agent must not leak into the Code composer.
  createEffect(() => {
    const session = selectedSession()
    if (isChatLike(session)) return
    const next = session?.agent
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
  const [workflows, { refetch: refetchWorkflows }] = createResource(
    () => (harnessServerUrl() ? `${harnessServerUrl()}\n${modelLocation() ?? ""}` : undefined),
    async (key) => {
      const [url = "", directory = ""] = key.split("\n")
      // The failure is kept, not swallowed: the screen says whether the list is the server's or the
      // last one it managed to read.
      return createHarnessClient(url).workflows.list(directory || undefined)
    },
  )
  // What the workflows screen may act on: files it can write, and the status the notice reads.
  const workflowsAvailable = () => !!harnessServerUrl() && !workflows.failure()
  const workflowNamed = (name: string) => (workflows() ?? []).find((workflow) => workflow.name === name)

  /** What the runs left behind (H-14), for the project this session is working in. */
  const [artifactList, setArtifactList] = createSignal<Artifact[]>([])
  // The last artifacts read that failed, so the panel says whether the list is the server's or the
  // last one it managed to read, instead of borrowing the routines connection's state.
  const [artifactsFailure, setArtifactsFailure] = createSignal<Error>()
  const artifactsAvailable = () => !!harnessServerUrl() && !artifactsFailure()
  const refreshArtifacts = async () => {
    const directory = modelLocation()
    try {
      const list = await createHarnessClient(harnessServerUrl()).artifacts.list(directory ? { directory } : {})
      // A server that answers without a list keeps the last one instead of clearing it: the list is
      // rendered and searched as an array, and `undefined` there took the whole app down.
      if (list) setArtifactList(list)
      setArtifactsFailure(undefined)
    } catch (cause) {
      setArtifactsFailure(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }
  createEffect(() => {
    harnessServerUrl()
    modelLocation()
    void refreshArtifacts()
  })

  /**
   * What a reader pinned or tagged (H-18), and the prompts they set aside.
   *
   * Read once from the harness server and then followed on its stream, like runs and artifacts. When
   * the server is unreachable these are simply empty: there is no browser copy to fall back to, by
   * design — the whole point of moving them there is that every device sees the same ones.
   */
  const [sessionPrefs, setSessionPrefs] = createSignal<Record<string, SessionPrefs>>({})
  const prefsFor = (id: string) => sessionPrefs()[id]
  const pinnedSessions = () =>
    Object.values(sessionPrefs())
      .filter((prefs) => prefs.pinned)
      .map((prefs) => prefs.sessionID)
  const applyPrefs = (prefs: SessionPrefs) => {
    const next = { ...sessionPrefs() }
    // A session with nothing kept is dropped, so no empty entry lingers in the map.
    if (!prefs.pinned && prefs.tags.length === 0) delete next[prefs.sessionID]
    else next[prefs.sessionID] = prefs
    setSessionPrefs(next)
  }
  const sessionTags = createMemo(() => {
    const out: Record<string, string[]> = {}
    for (const prefs of Object.values(sessionPrefs())) if (prefs.tags.length > 0) out[prefs.sessionID] = prefs.tags
    return out
  })
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

  const [packs, setPacks] = createSignal<ContextPack[]>([])

  // The project's notes (H-37), handed to every turn so they do not have to be repeated.
  const [projectNotes, setProjectNotes] = createSignal<ProjectMemory[]>([])

  createEffect(() => {
    const url = harnessServerUrl()
    if (!routinesServerAvailable() || !url) return
    if (supports("session-prefs")) {
      void createHarnessClient(url)
        .sessionPrefs.list()
        .then((list) => {
          const map: Record<string, SessionPrefs> = {}
          for (const prefs of list) map[prefs.sessionID] = prefs
          setSessionPrefs(map)
        })
        .catch(() => undefined)
    }
    if (supports("stash")) {
      void createHarnessClient(url)
        .stash.list()
        .then(setStashes)
        .catch(() => undefined)
    }
    if (supports("packs")) {
      const directory = vcsDirectory()
      void createHarnessClient(url)
        .packs.list(directory ?? undefined)
        .then(setPacks)
        .catch(() => undefined)
    }
  })

  createEffect(() => {
    const url = harnessServerUrl()
    const directory = vcsDirectory()
    if (!url || !directory || !routinesServerAvailable() || !supports("memory")) {
      setProjectNotes([])
      return
    }
    void createHarnessClient(url).memory
      .list(directory)
      .then(setProjectNotes)
      .catch(() => setProjectNotes([]))
  })

  const projectMemoryText = () => {
    const notes = projectNotes()
    return notes.length > 0 ? `Project memory:\n${notes.map((note) => `- ${note.text}`).join("\n")}` : ""
  }
  /** The system a turn runs with: whatever it already had, plus the project's notes (H-37). */
  const withProjectMemory = (base?: string) => [base, projectMemoryText()].filter(Boolean).join("\n\n") || undefined
  const addProjectNote = (text: string) => {
    const directory = vcsDirectory()
    if (!directory) return
    void createHarnessClient(harnessServerUrl())
      .memory.add({ directory, text })
      .then((note) => setProjectNotes((list) => [...list, note]))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  const removeProjectNote = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .memory.remove(id)
      .then(() => setProjectNotes((list) => list.filter((note) => note.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const removeArtifact = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .artifacts.remove(id)
      .then(() => setArtifactList(artifactList().filter((artifact) => artifact.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // The file tree and viewer (H-19): the engine lists and finds, the harness server reads the text.
  const listFiles = (path?: string) => {
    const directory = vcsDirectory()
    if (!directory) return Promise.resolve([])
    return createClient(serverUrl())
      .file.list({ directory, ...(path ? { path } : {}) })
      .catch(() => [])
  }
  const searchFileEntries = async (query: string) =>
    (await createClient(serverUrl()).file.find({ query, limit: 40 })).data
  const readFileText = (path: string) =>
    createHarnessClient(harnessServerUrl()).files.read({ directory: vcsDirectory() ?? "", path })

  // Extra skill sources (H-27). The engine reads its own folders; `skills.paths`/`skills.urls` add
  // more, and writing them is a `PATCH /config`, so this is the engine's to own.
  const [skillSources, setSkillSources] = createSignal<SkillSources>(EMPTY_SOURCES)
  createEffect(() => {
    if (!skillsScreenOpen() || !ready()) return
    void createClient(serverUrl())
      .config()
      .then((config) => setSkillSources(normalizeSources((config as { skills?: unknown }).skills)))
      .catch(() => undefined)
  })
  const writeSkillSources = (next: SkillSources) =>
    createClient(serverUrl())
      .updateConfig({ skills: { paths: next.paths, urls: next.urls } })
      .then(() => toast(t("Skill sources saved"), "success"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const addSkillSource = (kind: SkillSourceKind, value: string) => {
    const next = addSource(skillSources(), kind, value)
    setSkillSources(next)
    void writeSkillSources(next)
  }
  const removeSkillSource = (kind: SkillSourceKind, value: string) => {
    const next = removeSource(skillSources(), kind, value)
    setSkillSources(next)
    void writeSkillSources(next)
  }
  const updateArtifact = (id: string, input: { pinned?: boolean; expiresAt?: number | null }) => {
    void createHarnessClient(harnessServerUrl())
      .artifacts
      .update(id, input)
      // Pinned first, so the row moves to where the list says it should be instead of waiting for
      // the next refresh to look right.
      .then((updated) =>
        setArtifactList(
          artifactList()
            .map((artifact) => (artifact.id === id ? updated : artifact))
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt),
        ),
      )
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  // Bumped when the reader asks the engine to reload. The engine re-reads its configuration then, so
  // the resources that carry it — the agent and skill lists above the config — must be asked again.
  const [serverReload, setServerReload] = createSignal(0)
  const [serverReloading, setServerReloading] = createSignal(false)
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
  // The engine's own settings. The context meter needs the compaction ones: they are what decides
  // when the engine folds a session, and how much room the reader really has.
  const [engineConfig] = createResource(
    () => (ready() ? serverUrl() : undefined),
    (url) => createClient(url).config(),
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
  // The reload counter is part of the key so a reload asks for both lists again; the fetcher reads
  // the URL off the same key.
  const [agents] = createResource(
    () => (ready() ? `${serverUrl()}\n${serverReload()}` : undefined),
    async (key) => createClient(key.split("\n")[0]!).agent.list(),
  )
  const [skills] = createResource(
    () => (ready() ? `${serverUrl()}\n${serverReload()}` : undefined),
    async (key) => createClient(key.split("\n")[0]!).skill.list(),
  )
  const [mcp, { refetch: refetchMcp }] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).mcp.list(),
  )
  // What the connected MCP servers expose (H-34). The engine reports resources, not tools.
  const [mcpResources, { refetch: refetchMcpResources }] = createResource(
    () => (ready() ? serverUrl() : undefined),
    async (url) => createClient(url).mcp.resources().catch(() => []),
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
    if (!providersSectionVisible()) return
    void refetchProviderDirectory()
    void refetchIntegrations()
  })
  // Providers whose key lives in the engine's configuration but is not a v2 credential yet. Copying
  // them used to happen on its own on every load, which sent every key through the page (and, while
  // remote-controlling, to the phone). Now the providers panel offers it and the reader asks for it.
  const [unlinkedProviders, { refetch: refetchUnlinkedProviders }] = createResource(
    () => (ready() && providersSectionVisible() ? serverUrl() : undefined),
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
    })

  /** The Console org behind providers, when the engine has one (CO-1). */
  const [consoleActive, { refetch: refetchConsoleActive }] = createResource(
    () => (ready() && providersSectionVisible() ? serverUrl() : undefined),
    async (url) => createClient(url).console.active().catch(() => undefined),
  )
  const [consoleOrgs, { refetch: refetchConsoleOrgs }] = createResource(
    () => (ready() && providersSectionVisible() ? serverUrl() : undefined),
    async (url) => createClient(url).console.orgs().catch(() => [] as ConsoleOrg[]),
  )
  /**
   * Switch the Console org, then reread everything it manages (CO-1). Providers, models and
   * integrations all hang off the active org, so all of them refresh.
   */
  const switchConsoleOrg = (org: ConsoleOrg) => {
    void createClient(serverUrl())
      .console.switchOrg({ accountID: org.accountID, orgID: org.orgID })
      .then(() => {
        void refetchConsoleActive()
        void refetchConsoleOrgs()
        void refetchProviderDirectory()
        void refetchIntegrations()
        void refetchModels()
        void refetchModelDirectory()
        toast(t("Console organization switched"), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

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

  // The runs on screen, as a key that changes only when one of them changes shape or status. Shared
  // by the three per-run reads below, so they refetch together and only when there is a reason to.
  const runsDetailKey = () => {
    if (!runsOpen() || !routinesServerAvailable()) return undefined
    const shape = runs()
      .map((run) => `${run.id}:${run.tasks?.length ?? 0}:${run.status}`)
      .join("|")
    return shape ? `${harnessServerUrl()}\n${shape}` : undefined
  }
  const runIDsOf = (key: string) =>
    key
      .split("\n")[1]
      ?.split("|")
      .map((entry) => entry.split(":")[0]!)
      .filter(Boolean) ?? []

  const [touched] = createResource(runsDetailKey, async (key) => {
    const [url = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const lists = await Promise.all(runIDsOf(key).map((id) => client.runs.files(id).catch(() => undefined)))
    const byTask: Record<string, TouchedFiles> = {}
    for (const list of lists) for (const entry of list ?? []) if (entry.taskID) byTask[entry.taskID] = entry
    return byTask
  })
  const [taskTools] = createResource(runsDetailKey, async (key) => {
    const [url = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const lists = await Promise.all(runIDsOf(key).map((id) => client.runs.tools(id).catch(() => undefined)))
    const byTask: Record<string, TaskTools> = {}
    for (const list of lists) for (const entry of list ?? []) byTask[entry.taskID] = entry
    return byTask
  })
  const [runArtifacts] = createResource(runsDetailKey, async (key) => {
    const [url = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const ids = runIDsOf(key)
    const lists = await Promise.all(ids.map((id) => client.artifacts.list({ runID: id }).catch(() => undefined)))
    const byRun: Record<string, Artifact[]> = {}
    ids.forEach((id, index) => {
      const list = lists[index]
      if (list) byRun[id] = list
    })
    return byRun
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
  // The system prompt the engine assembled, which is the one part of the context no engine endpoint
  // reports. FlupCode's engine plugin records it per request, so it belongs to a session rather than
  // a folder, and is read for the open one.
  const [capturedPrompts] = createResource(
    () => {
      const sessionID = selected()
      return contextOpen() && sessionID && routinesServerAvailable() ? { url: harnessServerUrl(), sessionID } : undefined
    },
    (source) => createHarnessClient(source.url).context.systemPrompt({ sessionID: source.sessionID }),
  )
  // What tools this session ran. It is the only thing there is to say about an MCP server's tools:
  // the engine reports no list of what one offers, only the calls that go through it.
  const [toolUses] = createResource(
    () => {
      const sessionID = selected()
      return contextOpen() && sessionID && routinesServerAvailable() ? { url: harnessServerUrl(), sessionID } : undefined
    },
    (source) => createHarnessClient(source.url).context.toolUses({ sessionID: source.sessionID }),
  )
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
  const folderAgentsKey = () => ((agentsSectionVisible() || agentsOpen()) && ready() ? `${serverUrl()}\n${vcsDirectory() ?? ""}` : undefined)
  const [folderAgents] = createResource(folderAgentsKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createClient(url).agent.listFor(directory || undefined)
  })
  // Agents you can edit (H-13). The files come from the harness server, which can read the disk;
  // what exists comes from the engine, which reports more than there are files.
  const agentFilesKey = () => {
    // Also when Settings is open: who may reach a server is read from the agent files (H-34).
    if ((!settingsOpen() && !agentsOpen()) || !routinesServerAvailable()) return undefined
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
    path?: string
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
  // Commands you can edit (H-25). The files behind the engine's slash commands; the palette already
  // reads what the engine lists, so a save here shows up without touching the palette.
  const [commandsRefresh, setCommandsRefresh] = createSignal(0)
  const commandFilesKey = () => {
    if (!settingsOpen() || !routinesServerAvailable()) return undefined
    return `${harnessServerUrl()}\n${vcsDirectory() ?? ""}\n${commandsRefresh()}`
  }
  const [commandFiles] = createResource(commandFilesKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).commands.list(directory ? { directory } : {})
  })
  const saveCommand = (draft: CommandDraft) => {
    const directory = vcsDirectory()
    void createHarnessClient(harnessServerUrl())
      .commands.save({ ...draft, ...(directory ? { directory } : {}) })
      .then(() => setCommandsRefresh((count) => count + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  const deleteCommand = (path: string) => {
    const directory = vcsDirectory()
    void createHarnessClient(harnessServerUrl())
      .commands.remove({ path, ...(directory ? { directory } : {}) })
      .then(() => setCommandsRefresh((count) => count + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  // The configured MCP servers (H-25): so the form can open one for editing, not just add a new one.
  const [mcpConfigs, { refetch: refetchMcpConfigs }] = createResource(
    () => (settingsOpen() && ready() ? serverUrl() : undefined),
    async (url) => createClient(url).mcp.config(),
  )
  // The engine's permission policy (H-25), edited in Settings. Runtime grants ("Allow always") are
  // a different thing and are read from the engine on their own.
  const [permissionPolicy, { refetch: refetchPermissionPolicy }] = createResource(
    () => (settingsOpen() && ready() ? serverUrl() : undefined),
    async (url) => ((await createClient(url).config()) as { permission?: unknown }).permission,
  )
  const savePermissionPolicy = (policy: Record<string, unknown>) =>
    void createClient(serverUrl())
      .updateConfig({ permission: policy })
      .then(() => {
        void refetchPermissionPolicy()
        toast(t("Permissions saved"))
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const toolsKey = () => ((contextOpen() || agentsOpen() || agentsSectionVisible()) && ready() ? serverUrl() : undefined)
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
        setCheckpointTick((tick) => tick + 1)
        void refetchChanges()
        void refetchVcsStatus()
        toast(t("Checkpoint restored"), "success", {
          description: t("Restored: {written} rewritten, {removed} deleted", {
            written: plan?.write.length ?? 0,
            removed: plan?.remove.length ?? 0,
          }),
        })
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
  /** Sessions with a question to answer, told apart from plain blocked ones (QH-1). */
  const questionSessions = () => findQuestionSessions((blocked()?.data ?? []) as PendingRequest[])

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
    // A session the engine no longer has is handled below, not reported as the engine being away.
    if (isSessionGone(messages.failure())) return
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
  // A session the reader left open is remembered across reloads, but the engine may not have it: it
  // was deleted, or it lives in another engine than the one at this address now. That looked exactly
  // like an empty session — the transcript failed to load, the composer invited writing into it, and
  // the app kept asking the engine for a session it answers 404 to. Let it go, forget it, and say it.
  createEffect(() => {
    const failure = messages.failure()
    if (!isSessionGone(failure) || !selected()) return
    clearToast(STALE_TOAST)
    setSelected(undefined)
    writeStorage(STORAGE_KEYS.selectedSession, "")
    toast(t("That session is no longer in the engine"), "info")
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
   * Whether the session is being folded right now. A compaction is a turn of its own — the engine
   * writes its summary as an assistant message — so the status line reads like any other answer
   * unless this is checked. The newest settled message decides: while it is the request and its
   * summary has not landed, the engine is compacting.
   */
  const compacting = () => {
    if (compactingManually()) return true
    if (!generating()) return false
    const list = activeMessages() ?? []
    const settled = list.filter((message) => {
      const time = (message as { time?: { completed?: number } }).time
      return message.type !== "assistant" || time?.completed !== undefined
    })
    const last = settled[settled.length - 1]
    return last !== undefined && !!(last as { compaction?: unknown }).compaction
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
      contextFigures(
        selectedSession(),
        activeMessages() ?? [],
        modelList(),
        currentModel(),
        engineConfig()?.compaction,
      )

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
      async (source) => {
        const response = await createClient(source.url).session.children({ sessionID: source.sessionID })
        // The session is kept with the list so a reader who just switched cannot read the last
        // session's children as this one's, which would open the panel for work that is not here.
        return { sessionID: source.sessionID, data: response.data ?? [] }
      },
    )
    const subagents = () => {
      const result = children()
      if (!result || result.sessionID !== selected()) return []
      return result.data.filter((session) => !isSuggestionSession(session))
    }

    // Subagents the reader removed from the context panel, per session. The children belong to the
    // engine, so removal only hides them here, and one spawned later still shows up.
    const [clearedSubagents, setClearedSubagents] = createSignal<Record<string, string[]>>(
      readStorage(STORAGE_KEYS.clearedSubagents, {}),
    )
    const clearSubagents = (ids: string[]) => {
      const sessionID = selected()
      if (!sessionID) return
      const next = {
        ...clearedSubagents(),
        [sessionID]: [...new Set([...(clearedSubagents()[sessionID] ?? []), ...ids])],
      }
      setClearedSubagents(next)
      writeStorage(STORAGE_KEYS.clearedSubagents, next)
    }
    const visibleSubagents = () => {
      const cleared = clearedSubagents()[selected() ?? ""] ?? []
      return subagents()?.filter((session) => !cleared.includes(session.id))
    }

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

    /**
     * The model's last written todo list, read from the transcript. This is only what the panel
     * falls back to: the engine's own store (below) is the source that matters, because a long
     * session can drop the tool part this reads and leave the panel on a list the model moved past.
     */
    const transcriptTodos = () => {
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

    // The engine keeps the todos the todowrite tool wrote, in a store of its own that is not pruned.
    // Reread it whenever the transcript's list moves, and prefer it: it is what the model last wrote.
    const [engineTodos] = createResource(
      () => {
        const sessionID = selected()
        if (!ready() || !sessionID) return undefined
        return [
          serverUrl(),
          sessionID,
          selectedSession()?.location?.directory ?? "",
          JSON.stringify(transcriptTodos()),
        ].join("\n")
      },
      async (key) => {
        const [url = "", sessionID = "", directory = ""] = key.split("\n")
        const data = await createClient(url)
          .session.todos({ sessionID, directory: directory || undefined })
          .then((result) => result.data ?? [])
          .catch(() => undefined)
        // Kept with the session for the same reason as the children list: a resource holds the last
        // session's value while the open one loads, and that is not this session's work.
        return { sessionID, data }
      },
    )
    // The model does not always close its own list: a task it was working on when the turn ended is
    // left in_progress, in the engine's store as much as in the transcript. Once nothing is running,
    // what is still in progress is work that finished and was never marked, so it reads as done.
    const allTodos = () => {
      const stored = engineTodos()
      const list =
        stored && stored.sessionID === selected() && stored.data !== undefined ? stored.data : transcriptTodos()
      if (generating()) return list
      return list.map((todo) => (todo.status === "in_progress" ? { ...todo, status: "completed" } : todo))
    }

    // Tasks the reader removed from the context panel, per session. The engine keeps the model's
    // todo list, so removal only hides them here. Hiding is not limited to completed ones: "Clear
    // all" has to take a task the engine left unfinished, and it goes on reporting it.
    const [clearedTodos, setClearedTodos] = createSignal<Record<string, string[]>>(
      readStorage(STORAGE_KEYS.clearedTodos, {}),
    )
    const todos = () => {
      const cleared = clearedTodos()[selected() ?? ""] ?? []
      return allTodos().filter((todo) => !cleared.includes(todo.content))
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
        // An action that acts on the open session is not offered when there is none.
        disabled: UNAVAILABLE_FEATURES.has(command.name) || (command.session === true && !selected()),
        source: "builtin" as const,
      })),
      // A chat has no project behind it, so the engine's commands, its skills and its workflows are
      // not offered there: what is typed after a built-in is a message, as it has always been.
      ...(chatView()
        ? []
        : [
            ...(commands()?.data ?? []).map((command) => ({
              name: command.name,
              description: command.description,
              source: "command" as const,
            })),
            ...(skills()?.data ?? []).map((skill) => ({
              name: skill.name,
              description: skill.description ?? "Skill",
              source: "skill" as const,
            })),
            // A workflow is a command: that is the audit's "launcher unificado", and the reason it
            // goes in the same list rather than a menu of its own.
            ...(workflows() ?? []).map((workflow) => ({
              name: workflow.name,
              description: workflow.description || t("Workflow"),
              source: "workflow" as const,
            })),
          ]),
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
        openSettings("mcp")
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
      if (name === "files") {
        showScreen("files")
        return
      }
      if (name === "skills") {
        setSkillsOpen(true)
        return
      }
      if (name === "workflows") {
        showScreen("workflows")
        return
      }
      if (name === "replay") {
        showScreen("replay")
        return
      }
      if (name === "compare") {
        showScreen("compare")
        return
      }
      if (name === "best-of-n") {
        setBestOfNOpen(true)
        return
      }
      if (name === "skillify") {
        skillifySession()
        return
      }
      if (name === "compact") {
        compactSession()
        return
      }
      if (name === "resume") {
        resumeSession()
        return
      }
      if (name === "next-tab") {
        cycleSessionTab(1)
        return
      }
      if (name === "prev-tab") {
        cycleSessionTab(-1)
        return
      }
      if (name === "close-tab") {
        const id = selected()
        if (id) closeSessionTab(id)
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
      if (name === "providers") {
        openSettings("providers")
        return
      }
      if (name === "toggle-sidebar") {
        toggleSidebar()
        return
      }
      // Actions on the open session, which the palette offers next to the engine's commands (H-24).
      if (name === "split") {
        if (selected() && !splitActive()) openSplit(selected()!)
        return
      }
      if (name === "rename") {
        renameSession()
        return
      }
      if (name === "pin") {
        if (selected()) togglePin(selected()!)
        return
      }
      if (name === "archive") {
        if (selected()) archiveSession(selected()!, true)
        return
      }
      if (name === "delete") {
        deleteSession()
        return
      }
      setPrompt(`/${name} `)
    }

    // Escape and Tab behave the same in every dialog (H-24): Escape closes the topmost one, and Tab
    // stays inside it. Done once here, a dialog added later gets both without remembering to.
    createEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        // The stand-in a closing dialog leaves behind (modal-motion) is a copy with the same role:
        // it must not answer for the dialog still underneath it.
        const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(
          (dialog) => !dialog.closest(".fc-modal-leaving") && dialog.offsetParent !== null,
        )
        const top = dialogs.at(-1)
        if (!top) return
        if (event.key === "Escape") {
          const close = top.querySelector<HTMLButtonElement>('button[aria-label="Close"], button[aria-label="Cerrar"]')
          event.preventDefault()
          close?.click()
          return
        }
        if (event.key !== "Tab") return
        const selector =
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        const focusable = Array.from(top.querySelectorAll<HTMLElement>(selector)).filter(
          (node) => node.offsetParent !== null,
        )
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        const active = document.activeElement
        if (event.shiftKey && (active === first || !top.contains(active))) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && (active === last || !top.contains(active))) {
          event.preventDefault()
          first.focus()
        }
      }
      document.addEventListener("keydown", onKey, true)
      onCleanup(() => document.removeEventListener("keydown", onKey, true))
    })

    // Every editable shortcut runs here, read from the registry, so one changed in Settings takes
    // effect without a reload (H-24). The old code hard-coded each one.
    const runShortcut = (action: KeybindAction) => {
      if (action === "palette") return setPaletteOpen(true)
      if (action === "toggleSidebar") return toggleSidebar()
      if (action === "toggleContextPanel") return toggleContextPanel()
      if (action === "settings") return setSettingsOpen(true)
      if (action === "newSession") return newSession()
      if (action === "compact") return compactSession()
      if (action === "split" && selected() && !splitActive()) return openSplit(selected()!)
    }
    createEffect(() => {
      const bindings = keybinds()
      const handler = (event: KeyboardEvent) => {
        if (event.repeat) return
        const typing = isTypingTarget(event.target)
        for (const action of KEYBIND_ACTIONS) {
          const binding = bindings[action]
          if (!binding || !matchesKeybind(binding, event)) continue
          // A binding with no modifier must not fire while the reader is typing into a field.
          if (typing && !binding.includes("mod") && !binding.includes("alt")) continue
          event.preventDefault()
          runShortcut(action)
          return
        }
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
      // Reconcile on every turn end, not only when a refetch was asked for mid-turn: a run whose
      // folder no stream is following is seen only by the poll, and this is the refetch that turns
      // its finished answer into something the reader can see.
      if (sessionID !== selected()) return
      reconcileWhenIdle = false
      reconcileTranscript()
    }
    onCleanup(() => {
      if (refetchTimer) clearTimeout(refetchTimer)
    })

    /**
     * Which sessions are working, asked of the engine itself.
     *
     * Events only report what happens while a stream is open, so a run that started before this
     * window connected — one followed from the desktop, say — has no event to announce it.
     * `/api/session/active` only knows about v2 runs, and a legacy turn — which is now every Code
     * and Chat turn — shows up in its folder's status map instead. The folder of a session nobody
     * is streaming is still asked: the home lists what is working before anything is opened.
     */
    const resyncRuns = async (engine: ReturnType<typeof createClient>, directories: string[]) => {
      const sessions = untrack(sessionList)
      const [v2Result, ...legacyResults] = await Promise.all([
        engine.session.active().catch(() => undefined),
        ...directories.map((directory) => engine.session.status({ directory }).catch(() => undefined)),
      ])
      const v2 = v2Result ?? new Set<string>()
      const legacy = new Set(legacyResults.flatMap((set) => (set ? [...set] : [])))
      const running = new Set([...v2, ...legacy])
      const known = new Set([
        ...v2,
        ...(sessions ?? [])
          .filter((session) => directories.includes(session.location?.directory ?? ""))
          .map((session) => session.id),
      ])
      // A source that could not be reached answers nothing, so its silence is not evidence: clearing
      // on it would end a run because the engine was briefly away. Only clear once every source
      // answered and none of them lists the session.
      const answered = v2Result !== undefined && legacyResults.every((set) => set !== undefined)
      if (answered)
        Object.entries(runState())
          .filter(([id, isRunning]) => isRunning && known.has(id) && !running.has(id))
          .forEach(([id]) => setRunning(id, false))
      running.forEach((id) => {
        setRunning(id, true)
        // A legacy run in a folder this window cannot name is left to its idle event: without the
        // folder there is no status map to ask, and clearing it on the v2 set alone would be a lie.
        if (v2.has(id) || sessionDirectory(id)) watchRun(id, 2000)
      })
    }

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
            // Untracked: this effect owns the global stream, and re-running it on every change of
            // the session list or the open session would drop and reopen that stream for no reason.
            void untrack(() => resyncRuns(createClient(url), runDirectories())).catch(() => undefined)
            void refetchPermissions()
            void refetchQuestions()
            void refetchBlocked()
            for await (const event of createClient(url).event.subscribe({ signal: controller.signal })) {
              attempt = 0
              setStreamState("global", "live")
              const type = event.type ?? ""
              const payload = (event as { data?: { sessionID?: string; delta?: string } }).data
              trackActivity(
                type,
                payload as
                  | { sessionID?: string; status?: { type?: string; message?: string; attempt?: number } }
                  | undefined,
              )
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
                void refetchBlocked()
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
      // What is on screen first: the conversation being read is the one that needs its stream. The
      // folders behind it (the code project, the chats) come after, so a chat in a project the app
      // is not browsing still streams instead of being dropped by the budget below.
      const directories = [...open, chatsDirectory(), targetDirectory()].filter(
        (value): value is string => typeof value === "string" && value.length > 0,
      )
      return [...new Set(directories)].slice(0, WATCHED_DIRECTORIES)
    }

    /** Every folder a loaded session lives in, plus the folders followed live. */
    const runDirectories = () => [
      ...new Set([
        ...watchedDirectories(),
        ...(sessionList() ?? []).flatMap((session) => session.location?.directory ?? []),
      ]),
    ]
    // A string so a refetched-but-equal list does not re-seed the run state on every turn's refetch.
    const listedDirectories = createMemo(() =>
      [...new Set((sessionList() ?? []).flatMap((session) => session.location?.directory ?? []))].sort().join("\n"),
    )
    // The list arrives after the global stream connects, and a legacy run started in another window
    // has no event here; re-seed once the folders the list knows about are in.
    createEffect(() => {
      const directories = listedDirectories()
      if (!directories || !ready()) return
      void resyncRuns(createClient(serverUrl()), directories.split("\n")).catch(() => undefined)
    })

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
                  status?: { type?: string; message?: string; attempt?: number }
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
        if (!directory || isPlainChat(session)) continue
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
        .filter((session) => !session.parentID && !session.time.archived && isChatLike(session) === chatView())
        .sort((a, b) => b.time.updated - a.time.updated)
        .map((session) => {
          const directory = session.location?.directory
          const running = session.id in runs ? runs[session.id] : activity?.busy.has(session.id)
          return {
            id: session.id,
            title: sessionTitle(session),
            project: isPlainChat(session) ? undefined : directory?.split("/").filter(Boolean).at(-1),
            cowork: chatClass(session) === "cowork",
            branch: directory ? activity?.branches[directory] : undefined,
            updated: session.time.updated,
            state: activity?.waiting.has(session.id) ? "waiting" : running ? "busy" : "idle",
          }
        })
    })

    // The runs still going, for the phone supervisor (H-12). Finished ones are history; a phone is
    // for seeing what needs an answer, not for reading back.
    const remoteRuns = createMemo(() =>
      mobileRemote() ? runs().filter((run) => run.status === "running" || run.status === "awaiting") : [],
    )

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
      // Opening a session leaves behind any folder picked for one that never started. Without this
      // the repo bar keeps showing that folder instead of the selected session's own directory.
      setTargetDirectory(undefined)
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

    // Session tabs (H-36): which sessions are open in this window. The selected session is the active
    // tab, so this only keeps the strip and what happens when one is closed or cycled.
    const [sessionTabs, setSessionTabs] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.sessionTabs, []))
    createEffect(() => writeStorage(STORAGE_KEYS.sessionTabs, sessionTabs()))
    createEffect(() => {
      const id = selected()
      if (!id) return
      setSessionTabs((tabs) => (tabs.includes(id) ? tabs : openTab(tabs, id)))
    })
    // A tab whose session was deleted has nothing to show, so it goes without a click.
    createEffect(() => {
      const list = sessionList()
      if (!list || sessions.loading) return
      setSessionTabs((tabs) => {
        const next = keepTabs(tabs, (id) => list.some((session) => session.id === id))
        return next.length === tabs.length ? tabs : next
      })
    })
    const sessionTabList = () =>
      sessionTabs().map((id) => ({ id, title: sessionList()?.find((session) => session.id === id)?.title }))
    const closeSessionTab = (id: string) => {
      const next = tabAfterClose(sessionTabs(), id)
      setSessionTabs((tabs) => closeTab(tabs, id))
      if (id !== selected()) return
      if (next) selectSession(next)
      else setSelected(undefined)
    }
    const cycleSessionTab = (delta: number) => {
      const next = cycleTab(sessionTabs(), selected(), delta)
      if (next) selectSession(next)
    }

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

    /**
     * The composer's folder picker. In Code, choosing a folder that already has sessions resumes the
     * latest one; a Cowork conversation has no code session to resume, so the folder is only where
     * the new conversation will work and the reader stays on the chat home. `Open folder…` never
     * resumed anything, which is why it already worked.
     */
    const changeComposerTarget = (directory: string | undefined) => {
      if (composerChatClass() !== "cowork") return changeTargetDirectory(directory)
      setTargetDirectory(directory)
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

    // Pins live on the harness server (H-18), so this is a request rather than a browser write. The
    // answer, and the stream event that follows it, are what move the row.
    const togglePin = (id: string) => {
      const pinned = !prefsFor(id)?.pinned
      void createHarnessClient(harnessServerUrl())
        .sessionPrefs.update(id, { pinned })
        .then(applyPrefs)
        .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
    }

    const setTags = (id: string, tags: string[]) => {
      void createHarnessClient(harnessServerUrl())
        .sessionPrefs.update(id, { tags })
        .then(applyPrefs)
        .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
    }

    const editTags = (id: string) => {
      const session = sessionList()?.find((entry) => entry.id === id)
      setTagsTarget({ id, title: session ? sessionTitle(session) : t("Session"), tags: prefsFor(id)?.tags ?? [] })
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

    // Whether the current stretch of work has already been offered, and whether the panel is open
    // because of it rather than because the reader opened it.
    let offeredForWork = false
    let openedForWork = false

    const toggleContextPanel = () => {
      const next = !contextHidden()
      setContextHidden(next)
      writeStorage(STORAGE_KEYS.contextPanelHidden, next)
      // The reader has taken over: from here the panel is theirs, not the work's to close later.
      openedForWork = false
    }
    const contextPanelShown = () => !!selectedSession() && !contextHidden()

    /**
     * The panel is for watching work, so it comes and goes with it: open while there is a task left
     * to do or one of this session's children is being worked on or waiting on a permission, closed
     * when there is nothing to watch.
     *
     * It offers itself once per stretch. A reader who closes it is not fought until the work stops
     * and starts again, and a stretch the reader opened through is left open when it ends.
     */
    createEffect(() => {
      const sessionID = selected()
      // The session's own context is still loading while the resources hold the last session's
      // value: deciding now would offer the panel for work that belongs to the session left behind,
      // which is the flash of it a reader sees right after switching.
      if (sessionID && (children()?.sessionID !== sessionID || engineTodos()?.sessionID !== sessionID)) return
      const work =
        todos().some((todo) => todo.status !== "completed") ||
        (subagents() ?? []).some((child) => !!runState()[child.id] || blockedSessions().includes(child.id))
      if (work) {
        if (offeredForWork) return
        offeredForWork = true
        if (!contextHidden()) return
        openedForWork = true
        setContextHidden(false)
        return
      }
      offeredForWork = false
      if (!openedForWork) return
      openedForWork = false
      setContextHidden(true)
    })
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
      setAgentsRefresh((count) => count + 1)
      await Promise.allSettled([
        refetchHealth(),
        refetchSessions(),
        refetchModels(),
        refetchModelDirectory(),
        refetchProviderDirectory(),
      ])
      setServerReloading(false)
      toast(t("Engine reloaded"), "success")
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

    const changeKeybind = (action: KeybindAction, binding: string) => {
      const next = withKeybind(keybinds(), action, binding)
      setKeybinds(next)
      writeStorage(STORAGE_KEYS.keybinds, next)
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

    // The stash lives on the harness server (H-18), so it is the same list on every device. The
    // stream event adds it back; this only asks and, once it answers, shows it.
    const stashPrompt = (text: string, clear: boolean) => {
      const value = text.trim()
      if (!value) {
        toast(t("No prompt to save"), "info")
        return
      }
      void createHarnessClient(harnessServerUrl())
        .stash.add(value)
        .then((prompt) => {
          setStashes((list) => [prompt, ...list])
          if (clear) setPrompt("")
          toast(t("Prompt saved"), "success")
        })
        .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
    }

    const restoreStash = (id: string) => {
      const item = stashes().find((entry) => entry.id === id)
      if (!item) return
      setPrompt(item.text)
      removeStash(id)
      setStashOpen(false)
    }

    const removeStash = (id: string) => {
      setStashes((list) => list.filter((entry) => entry.id !== id))
      void createHarnessClient(harnessServerUrl())
        .stash.remove(id)
        .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
    }

    // A context pack (H-26): the refs a draft already mentions, saved under a name so they can be
    // pulled back with one `@`.
    const savePack = (name: string) => {
      const refs = packRefs()
      setPackRefs(undefined)
      const trimmed = name.trim()
      if (!refs || refs.length === 0 || !trimmed) return
      const directory = vcsDirectory()
      void createHarnessClient(harnessServerUrl())
        .packs
        .save({ name: trimmed, refs, ...(directory ? { directory } : {}) })
        .then((pack) => {
          setPacks((current) =>
            [...current.filter((entry) => entry.name !== pack.name), pack].sort((left, right) =>
              left.name.localeCompare(right.name),
            ),
          )
          toast(t("Pack saved"), "success")
        })
        .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
    }

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
    prefs?: unknown
    prompt?: unknown
    promptID?: unknown
  }) => {
      // What a reader keeps about a session, and their stash (H-18). The whole thing travels in the
      // event, so a pin on the phone is a pin on the desk without either asking again.
      if (event.type === "session.changed") {
        const prefs = event.prefs as SessionPrefs | undefined
        if (prefs?.sessionID) applyPrefs(prefs)
        return
      }
      if (event.type === "stash.added") {
        const prompt = event.prompt as StashedPrompt | undefined
        if (prompt?.id && !stashes().some((entry) => entry.id === prompt.id))
          setStashes((list) => [prompt, ...list])
        return
      }
      if (event.type === "stash.removed" && typeof event.promptID === "string") {
        const removed = event.promptID
        setStashes((list) => list.filter((entry) => entry.id !== removed))
        return
      }
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
          // The stream ending is not the server being unreachable: the next `refreshRoutines` above
          // asks over a plain request and is what decides that. Marking it here made every harness
          // screen say "not reachable" whenever the event stream dropped, while requests still worked.
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
      .then(() => {
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setOpeningPullRequest(false))
  }

  // Git (H-20). Committing was a prompt: `"Commit the current changes with a clear message."` went
  // to the model, which then ran the commands itself. A whole turn, paid for in tokens, to run two
  // commands the server can run for nothing — and with no say in what went into the commit.
  const [committing, setCommitting] = createSignal(false)
  const commitPicked = (input: { message: string; paths: string[]; hunks?: Record<string, number[]> }) => {
    const directory = vcsDirectory()
    if (!directory) return
    setCommitting(true)
    void createHarnessClient(harnessServerUrl())
      .git.commit({ directory, ...input })
      .then(() => {
        void refetchChanges()
        void refetchVcsStatus()
        void refetchVcsInfo()
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setCommitting(false))
  }
  /** Throws a change away, or the named hunks of it (H-20). */
  const discardChanges = (input: { path: string; hunks?: number[] }) => {
    const directory = vcsDirectory()
    if (!directory) return
    void createHarnessClient(harnessServerUrl())
      .git.discard({ directory, ...input })
      .then(() => {
        void refetchChanges()
        void refetchVcsStatus()
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  /** A commit message written from the picked change, by a throwaway engine session (H-20). */
  const generateCommitMessage = (input: { paths: string[]; hunks?: Record<string, number[]> }) => {
    const directory = vcsDirectory()
    if (!directory) return Promise.resolve(undefined)
    return createHarnessClient(harnessServerUrl())
      .git.message({ directory, ...input })
      .then((answer) => answer.message)
      .catch((cause) => {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
        return undefined
      })
  }
  const startBranch = (name: string) => {
    const directory = vcsDirectory()
    if (!directory) return
    void createHarnessClient(harnessServerUrl())
      .git.branch({ directory, name })
      .then(() => {
        void refetchVcsInfo()
        void refetchChanges()
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const stopAllRuns = () => {
    void createHarnessClient(harnessServerUrl())
      .runs.stopAll()
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Start a workflow from the composer.
   *
   * Everything typed after the name fills its first input, which is what `/feature add search` means.
   * A workflow that asks for more than one cannot be said on a single line, so it opens the launcher
   * instead of refusing — or, worse, starting with the rest of them empty (H-28).
   */
  const [launching, setLaunching] = createSignal<{ workflow: Workflow; args?: string }>()
  const runWorkflow = (name: string, launch: Partial<WorkflowLaunch>) =>
    createHarnessClient(harnessServerUrl())
      .workflows.run(name, {
        ...(launch.inputs ? { inputs: launch.inputs } : {}),
        directory: modelLocation(),
        ...(launch.packs && launch.packs.length > 0 ? { packs: launch.packs } : {}),
        ...(launch.worktrees ? { worktrees: true } : {}),
        ...(launch.policy ? { policy: launch.policy } : {}),
        ...(launch.until ? { until: launch.until } : {}),
      })
      // Straight to the supervisor: a run nobody can see is the thing this replaces.
      .then(() => showScreen("runs"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const startWorkflow = (workflow: Workflow, args: string) => {
    if (workflow.inputs.length > 1) {
      setPrompt("")
      setLaunching({ workflow, args })
      return
    }
    const first = workflow.inputs[0]
    if (first && !args.trim()) {
      toast(t("{name} needs {input}", { name: workflow.name, input: first }), "info")
      return
    }
    setPrompt("")
    void runWorkflow(workflow.name, first ? { inputs: { [first]: args.trim() } } : {})
  }

  /**
   * One task, several models (H-44).
   *
   * Each model gets its own run, so the comparison the batch exists for is the screen H-33 already
   * built, opened with the first two runs already chosen. Worktrees are on by default there, because
   * N agents writing the same tree would be comparing a fight; the dialog can turn them off.
   */
  const [bestOfNOpen, setBestOfNOpen] = createSignal(false)
  const launchBestOfN = (launch: BestOfNLaunch) => {
    setBestOfNOpen(false)
    void createHarnessClient(harnessServerUrl())
      .runs.bestOfN({
        prompt: launch.prompt,
        models: launch.models,
        directory: modelLocation(),
        ...(launch.worktrees ? { worktrees: true } : {}),
      })
      .then((created) => {
        const [left, right] = created
        if (!left || !right) {
          showScreen("runs")
          return
        }
        setCompareArgs({ left: left.id, right: right.id })
        showScreen("compare", searchForCompare([left.id, right.id]))
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // The workflow editor (H-28): the file as written, saved back, and removed. Each one refreshes the
  // list, because a save can rename a workflow and a delete removes a row.
  const readWorkflowFile = (name: string) =>
    createHarnessClient(harnessServerUrl()).workflows.get(name, modelLocation())
  const saveWorkflowFile = (name: string, input: { source: string; directory?: string; scope?: "project" | "global" }) =>
    createHarnessClient(harnessServerUrl())
      .workflows.save(name, input)
      .then((saved) => {
        void refetchWorkflows()
        return saved
      })
  const deleteWorkflowFile = (name: string) =>
    createHarnessClient(harnessServerUrl())
      .workflows.remove(name, modelLocation())
      .then((removed) => {
        void refetchWorkflows()
        return removed
      })

  /** One page of the open session's durable events, for the replay (H-33). */
  const replayPage = (after?: number) => {
    const sessionID = selected()
    if (!sessionID) return Promise.resolve({ data: [], hasMore: false })
    return createClient(serverUrl()).session.history({ sessionID, after, limit: 200 })
  }

  /** Everything the comparison needs about one run (H-33): itself, its tasks, and what they changed. */
  const compareSnapshot = async (id: string) => {
    const client = createHarnessClient(harnessServerUrl())
    const [run, tasks, files] = await Promise.all([client.runs.get(id), client.runs.tasks(id), client.runs.files(id)])
    return runSnapshot(run, tasks, files)
  }

  const approveRun = (id: string) => {    void createHarnessClient(harnessServerUrl())
      .runs.approve(id)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // Each task of a worktree run wrote on its own branch (H-29); merging and cleaning up are the two
  // things a reader does with them once the run is over.
  const mergeWorktrees = (id: string) =>
    void createHarnessClient(harnessServerUrl())
      .runs.mergeWorktrees(id)
      .then((result) => toast(t("Merged {n} worktrees", { n: result.merged.length }), "success"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const cleanupWorktrees = (id: string) =>
    void createHarnessClient(harnessServerUrl())
      .runs.cleanupWorktrees(id)
      .then((result) => toast(t("Removed {n} worktrees", { n: result.removed.length }), "success"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))

  /**
   * Do a task again (H-12). The server adds it as a new task of the same run, so the stream carries
   * it back like any other and nothing here has to guess where it goes.
   */
  const retryTask = (taskID: string, model?: { providerID: string; id: string; variant?: string }) => {
    void createHarnessClient(harnessServerUrl())
      .runs.retry(taskID, model ? { model } : {})
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Take a queued task off its run (HF-4). The stream carries the stopped row back like any
   * other change, so nothing here has to guess where it goes.
   */
  const cancelTask = (taskID: string) => {
    void createHarnessClient(harnessServerUrl())
      .runs.cancelTask(taskID)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Pick up a run that ended with work still queued (HF-5). Settled tasks stay as they are;
   * the drive continues from the first task the graph allows.
   */
  const resumeRun = (id: string) => {
    void createHarnessClient(harnessServerUrl())
      .runs.resume(id)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Steer a running task by sending a message to its own session. The legacy runner absorbs a prompt
   * sent while a turn is going, so this is a steer and not a second turn (H-01, H-12).
   */
  const steerTask = (taskID: string, text: string) => {
    const run = runs().find((entry) => (entry.tasks ?? []).some((task) => task.id === taskID))
    const task = run?.tasks?.find((entry) => entry.id === taskID)
    if (!task?.sessionID) return
    void createClient(serverUrl())
      .session.send({ sessionID: task.sessionID, ...(run?.directory ? { directory: run.directory } : {}), text })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const clearRuns = () => {
    void createHarnessClient(harnessServerUrl())
      .runs.clear()
      .then(() => {
        setRuns(runs().filter((run) => run.status === "running"))
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
    void run(async (current) => {
      await current.session.abort({ sessionID, directory: sessionDirectory(sessionID) })
      return undefined
    })
  }

  /**
   * Take a sent prompt back (UN-1): the text returns to the composer first so nothing that
   * follows can lose it, then the turn stops and the prompt plus its partial turn are deleted
   * newest-first. Anything already deleted or appended in the meantime leaves the text recovered
   * with an honest note instead of rewritten history.
   */
  const unsendMessage = (messageID: string) => {
    const sessionID = selected()
    const plan = recoverablePrompt(activeMessages() ?? [], messageID)
    if (!sessionID || !plan) return
    setPrompt(plan.text)
    void (async () => {
      try {
        const client = createClient(serverUrl())
        await client.session.abort({ sessionID, directory: sessionDirectory(sessionID) })
        const deadline = Date.now() + 10_000
        while (generating() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300))
        for (const id of plan.deleteIDs) {
          await client.session.removeMessage({ sessionID, messageID: id, directory: sessionDirectory(sessionID) })
        }
        void refetchMessages()
      } catch {
        toast(t("Kept in the composer; the turn could not be fully recalled"), "info")
      }
    })()
  }

  const forkSession = (messageID?: string) => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      const forked = await current.session.fork({ sessionID, messageID })
      return forked.id
    })
  }

  const compactSession = () => {
    // Summarizing is the engine's compaction, and it needs the model to run the summary with.
    const model = selectedModel() ?? selectedSession()?.model
    if (!model) {
      toast(t("Choose a model"), "info")
      return
    }
    void run(async (current) => {
      const sessionID =
        selected() ?? (await current.session.create({ model: { providerID: model.providerID, id: model.id } })).id
      setCompactingManually(true)
      try {
        await current.session.compact({
          sessionID,
          directory: selectedSession()?.location?.directory,
          providerID: model.providerID,
          modelID: model.id,
        })
      } finally {
        setCompactingManually(false)
      }
      void refetchMessages()
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
    })
  }

  // Archiving is the engine's own `time.archived` (H-18): the session stays, it just leaves the
  // list. Bringing it back is the same call with zero.
  const archiveSession = (id: string, archived: boolean) => {
    void createClient(serverUrl())
      .session.setArchived(id, archived)
      .then(() => {
        if (archived && selected() === id) setSelected(undefined)
        return refetchSessions()
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const deleteProject = (directory: string) => {
    const sessions = (sessionList() ?? []).filter((session) => (session.location?.directory ?? "") === directory)
    if (sessions.length === 0) return
    setConfirmTarget({
      title: t("Delete this project and its sessions?"),
      message: t("{n} sessions will be removed. This cannot be undone.", { n: sessions.length }),
      onConfirm: () => {
        setConfirmTarget(undefined)
        void (async () => {
          setBusy(true)
          try {
            const current = createClient(serverUrl())
            for (const session of sessions) await current.session.remove({ sessionID: session.id })
            if (sessions.some((session) => session.id === selected())) setSelected(undefined)
            void refetchSessions()
            toast(t("Project deleted"), "success", {
              description: t("{name} and its sessions were removed", { name: directory.split("/").filter(Boolean).at(-1) ?? directory }),
            })
          } catch (cause) {
            toast(cause instanceof Error ? cause.message : String(cause), "error")
          } finally {
            setBusy(false)
          }
        })()
      },
    })
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
    setConfirmTarget({
      title: t("Delete this session?"),
      message: t("It will be removed from the engine and cannot be restored."),
      onConfirm: () => {
        setConfirmTarget(undefined)
        void (async () => {
          setBusy(true)
          try {
            await createClient(serverUrl()).session.remove({ sessionID })
            if (selected() === sessionID) setSelected(undefined)
            void refetchSessions()
            toast(t("Session deleted"), "success")
          } catch (cause) {
            toast(cause instanceof Error ? cause.message : String(cause), "error")
          } finally {
            setBusy(false)
          }
        })()
      },
    })
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
      void refetchMcpConfigs()
      void refetchMcpResources()
      return undefined
    }, t("MCP server added"))

  const removeMcp = (server: string) =>
    run(async (current) => {
      await current.mcp.remove({ server })
      void refetchMcp()
      void refetchMcpConfigs()
      void refetchMcpResources()
      return undefined
    }, t("MCP server removed"))

  const connectMcp = (server: string) =>
    run(async (current) => {
      await current.mcp.connect({ server })
      void refetchMcp()
      void refetchMcpResources()
      return undefined
    }, t("MCP server connected"))

  const disconnectMcp = (server: string) =>
    run(async (current) => {
      await current.mcp.disconnect({ server })
      void refetchMcp()
      void refetchMcpResources()
      return undefined
    }, t("MCP server disconnected"))

  /**
   * OAuth for a server that needs it (SE-2): the engine hands over the authorization URL, the
   * reader approves it in a tab, and `authenticate` waits for the engine's callback before the
   * list is read again. Opening the tab first matters: `authenticate` blocks until it completes.
   */
  const oauthMcp = (server: string) =>
    run(async (current) => {
      const started = (await current.mcp.authStart({ server })) as { authorizationUrl?: string }
      if (!started?.authorizationUrl) throw new Error(t("This server did not offer OAuth"))
      window.open(started.authorizationUrl, "_blank", "noopener,noreferrer")
      await current.mcp.authenticate({ server })
      void refetchMcp()
      void refetchMcpResources()
      return undefined
    }, t("MCP server connected"))

  const saveProvider = (providerID: string, key: string) =>
    run(async (current) => {
      await current.auth.set({ providerID, key })
      await current.integration.connectKey({ integrationID: providerID, key, label: providerID }).catch(() => undefined)
      await current.auth.reload().catch(() => undefined)
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
      await current.auth.reload().catch(() => undefined)
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
      void client()
        .auth.reload()
        .catch(() => undefined)
        .then(() => {
          void refetchProviderDirectory()
          void refetchModelDirectory()
          void refetchModels()
          void refetchIntegrations()
        })
    }
    refresh()
    // The engine marks the attempt complete just before persisting the
    // credential, so refresh again once it has landed.
    setTimeout(refresh, 800)
  }

  /**
   * Legacy provider OAuth, for a stock OpenCode CLI whose v2 integration registry has no OAuth
   * method (Copilot's device flow is registered only here). `authorize` returns the URL and
   * instructions; `callback` blocks until the provider authorizes and stores the credential.
   */
  const legacyOAuthAuthorize = (providerID: string, method: number, inputs?: Record<string, string>) =>
    client().provider.oauth.authorize({ providerID, method, inputs })

  const legacyOAuthCallback = (providerID: string, method: number, code?: string) =>
    client()
      .provider.oauth.callback({ providerID, method, code })
      .then(() => undefined)

  const editMessage = (messageID: string, text: string) => {
    const sessionID = selected()
    if (!sessionID) return
    setPrompt(text)
    void run(async (current) => {
      await current.session.revert.stage({ sessionID, messageID, directory: sessionDirectory(sessionID) })
      void refetchMessages()
      return undefined
    })
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
      await current.session.revert.stage({ sessionID, messageID: lastUser.id, directory: sessionDirectory(sessionID) })
      void refetchMessages()
      return undefined
    })
  }

  const redo = () => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.revert.clear({ sessionID, directory: sessionDirectory(sessionID) })
      void refetchMessages()
      return undefined
    })
  }

  const commitRevert = () => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.revert.commit({ sessionID, directory: sessionDirectory(sessionID) })
      void refetchMessages()
      return undefined
    })
  }

  // Exporting (H-35): markdown with options, or the raw JSON. The dialog holds the choices; this
  // builds the file.
  const [exportOpen, setExportOpen] = createSignal(false)
  const runExport = (format: "markdown" | "json", options: ExportOptions) => {
    const sessionID = selected()
    if (!sessionID) return
    const title = sessionTitle(selectedSession()) || sessionID
    const messages = (activeMessages() ?? []) as ExportMessage[]
    if (format === "markdown") {
      downloadFile(`${sessionID}.md`, sessionMarkdown(title, messages, options), "text/markdown")
    } else {
      downloadFile(`${sessionID}.json`, sessionJson(title, messages), "application/json")
    }
    setExportOpen(false)
    toast(t("Transcript exported"), "success")
  }
  // The harness's own share (H-35): it keeps the conversation and serves it at a link, so sharing
  // does not depend on the engine's remote host.
  const runShare = (options: ExportOptions) => {
    const sessionID = selected()
    if (!sessionID) return
    const title = sessionTitle(selectedSession()) || sessionID
    const markdown = sessionMarkdown(title, (activeMessages() ?? []) as ExportMessage[], options)
    void createHarnessClient(harnessServerUrl())
      .shares.create({ title, markdown })
      .then(async (share) => {
        const url = `${harnessServerUrl().replace(/\/$/, "")}${share.url}`
        await navigator.clipboard?.writeText(url).catch(() => undefined)
        toast(t("Share link copied"), "success")
        setExportOpen(false)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
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
      // Same as Code: a line sent while the chat is answering interrupts it and starts a turn of
      // its own, so the answer is about this line rather than the one in flight.
      if (generating()) await current.session.abort({ sessionID, directory }).catch(() => {})
      forgetRun(sessionID)
      await current.session.send({
        sessionID,
        directory,
        text: expandPastes(text),
        system: withProjectMemory(CHAT_SYSTEM),
        files: files.map(({ uri, name }) => ({ uri, name })),
        ...(model ? { model } : {}),
      })
      setStreamedChars(0)
      if (!keepDraft) {
        setPrompt("")
        setAttachments([])
      }
      return sessionID
    })
  }

  /** Sends a prompt to the selected session (or a new one); the composer is cleared unless the draft is kept. */
  const submitPrompt = (text: string, files: Attachment[], keepDraft = false, options?: { agent?: string; system?: string }) => {
    // Delivery only means something when a turn is already running; an idle session starts one.
    const mode = generating() ? delivery() : undefined
    const id = messageID()
    // Cowork overrides the app's agent and adds its system prompt; Code sends neither.
    const promptAgent = options?.agent ?? agent()
    void run(async (current) => {
      const model = selectedModel()
      const location = targetDirectory()
      const existing = selected()
      const created = !existing
      const sessionID =
        existing ??
        (
          await current.session.create({
            agent: promptAgent,
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
      const system = withProjectMemory(options?.system)
      pendingPrompts.add({
        id,
        sessionID,
        directory: location ?? selectedSession()?.location?.directory,
        text,
        files,
        agent: promptAgent,
        ...(system ? { system } : {}),
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
      // A message sent while the agent is working interrupts it — the running tool included — and
      // starts a new turn with this one, so the agent answers now instead of after the work it is
      // waiting on. Queue is how the reader asks for the opposite. The interrupted turn, and the
      // partial output of the tool it was running, stay in history for the next turn to read.
      if (mode === "steer")
        await current.session
          .abort({ sessionID, directory: location ?? selectedSession()?.location?.directory })
          .catch(() => {})
      try {
        await current.session.send({
          sessionID,
          directory: location ?? selectedSession()?.location?.directory,
          id,
          text: expandPastes(text),
          agent: promptAgent,
          ...(system ? { system } : {}),
          ...(model ? { model } : {}),
          ...(files.length > 0 ? { files: files.map(({ uri, name }) => ({ uri, name })) } : {}),
        })
      } catch (cause) {
        pendingPrompts.remove(id)
        // A first turn that never reached the engine (an engine that does not know the agent, a
        // refused model) would otherwise leave an empty session in the list. Drop the one this
        // send just created; the reader is left with the error, not an orphan row.
        if (created) await current.session.remove({ sessionID }).catch(() => {})
        throw cause
      }
      return sessionID
    })
  }

  /**
   * Sends in Cowork: the same path as Code, but in the project folder, with the conversational
   * prompt and the reserved agent that keeps the session a chat-class session. See ADR-0013.
   */
  const sendCowork = (text: string, files: Attachment[], keepDraft = false) => {
    const directory = targetDirectory() ?? selectedSession()?.location?.directory
    if (!directory) {
      setError(t("Choose a project folder for Cowork"))
      return
    }
    submitPrompt(text, files, keepDraft, { agent: COWORK_AGENT, system: COWORK_SYSTEM })
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
    if (chatView()) {
      return composerChatClass() === "cowork" ? sendCowork(text, files, true) : sendChat(text, files, true)
    }
    submitPrompt(text, files, true)
  }

  /**
   * Ask the open session to write down what it learned as a skill (H-43).
   *
   * The turn is visible on purpose: the session that did the work is the one that knows it, so the
   * agent writes `.opencode/skills/<name>/SKILL.md` with its own tools and the Skills screen reads
   * it back like any other. A chat has no project to write into, so it is told to use Code.
   */
  const skillifySession = (keepDraft = true) => {
    if (chatView()) {
      toast(t("Skills come from code sessions"), "info")
      return
    }
    if (!selected()) return
    submitPrompt(skillifyPrompt(), [], keepDraft)
  }

  /**
   * Writes down where the session stands. It is only a prompt, so it runs the same in Code, Chat and
   * Cowork — through the path each view already uses to send — and compacting the session stays on
   * `/compact`, which is the engine's job.
   */
  const resumeSession = (keepDraft = true) => {
    if (!selected()) {
      toast(t("No session"), "info")
      return
    }
    if (chatView()) {
      return composerChatClass() === "cowork"
        ? sendCowork(resumePrompt(), [], keepDraft)
        : sendChat(resumePrompt(), [], keepDraft)
    }
    submitPrompt(resumePrompt(), [], keepDraft)
  }

  const send = () => {
    const text = prompt().trim()
    const files = attachments()
    if (!text && files.length === 0) return
    recordPrompt(text)

    if (text.startsWith("/")) {
      const [rawName, ...rest] = text.slice(1).split(/\s+/)
      const name = rawName ?? ""
      const args = rest.join(" ").trim()
      if (UNAVAILABLE_FEATURES.has(name)) {
        setPrompt("")
        toast(t("Coming soon"), "info")
        return
      }
      // A workflow belongs to a project, so it is launched in Code only; a chat has no workflows.
      const workflow = chatView() ? undefined : workflowNamed(name)
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
        setPrompt("")
        compactSession()
        return
      }
      if (name === "resume") {
        setPrompt("")
        resumeSession(false)
        return
      }
      if (name === "steps") {
        setPrompt("")
        toggleTools()
        return
      }
      if (name === "mcp") {
        setPrompt("")
        openSettings("mcp")
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
      if (name === "workflows") {
        setPrompt("")
        showScreen("workflows")
        return
      }
      if (name === "replay") {
        setPrompt("")
        showScreen("replay")
        return
      }
      if (name === "compare") {
        setPrompt("")
        showScreen("compare")
        return
      }
      if (name === "best-of-n") {
        setPrompt("")
        setBestOfNOpen(true)
        return
      }
      if (name === "skillify") {
        setPrompt("")
        skillifySession(false)
        return
      }
      if (name === "next-tab") {
        setPrompt("")
        cycleSessionTab(1)
        return
      }
      if (name === "prev-tab") {
        setPrompt("")
        cycleSessionTab(-1)
        return
      }
      if (name === "close-tab") {
        setPrompt("")
        const id = selected()
        if (id) closeSessionTab(id)
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
      // A chat has no engine commands or project skills: the built-ins have run by now, and what is
      // left is a message like any other, which is how a chat could always use `/anything`.
      if (chatView()) {
        return composerChatClass() === "cowork" ? sendCowork(text, files) : sendChat(text, files)
      }
      const skill = skills()?.data?.find((item) => item.name === name)
      if (skill) {
        void run(async (current) => {
          const sessionID = selected() ?? (await current.session.create()).id
          await current.session.skill({ sessionID, skill: skill.name })
          setPrompt("")
          return sessionID
        })
        return
      }
      void run(async (current) => {
        const model = selectedModel()
        const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
        await current.session.command({ sessionID, command: name, ...(args ? { arguments: args } : {}) })
        setPrompt("")
        return sessionID
      })
      return
    }

    if (chatView()) {
      return composerChatClass() === "cowork" ? sendCowork(text, files) : sendChat(text, files)
    }

    if (text.startsWith("!")) {
      const command = text.slice(1).trim()
      if (!command) return
      void run(async (current) => {
        const sessionID = selected() ?? (await current.session.create()).id
        await current.session.shell({ sessionID, command })
        setPrompt("")
        return sessionID
      })
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
                        codeChrome() &&
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
              showEngineStatus={desktopWindow()}
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
              viewActivity={viewActivity()}
              codeChrome={codeChrome() && !toolScreen()}
              sidebarCollapsed={collapsed()}
              contextPanel={
                selectedSession() && codeChrome() && !toolScreen() ? { open: !contextHidden(), onToggle: toggleContextPanel } : undefined
              }
              onTogglePanel={togglePanel}
              openPanels={panels()}
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
                <Show when={!splitActive() && !toolScreen() && selectedSession()}>
                  {(session) => <SessionTitle session={session()} lineage={lineage()} onOpenLineage={selectSession} />}
                </Show>
              }
              sessionActions={
                <Show when={!splitActive() && !toolScreen() && selectedSession()}>
                  {(session) => (
                    <SessionActions
                      session={session()}
                      projects={projects()}
                      reverting={!!session().revert}
                      onFork={forkSession}
                      onCompact={compactSession}
                      onRename={renameSession}
                      onExport={() => setExportOpen(true)}
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
            viewActivity={viewActivity()}
            sessions={viewSessions()}
            sessionsLoading={sessions.loading || (ready() && enginePaths.loading)}
            selectedSession={selected()}
            runningSessions={Object.keys(runState()).filter((id) => runState()[id])}
            blockedSessions={blockedSessions()}
            questionSessions={questionSessions()}
            pinnedSessions={pinnedSessions()}
            sessionTags={sessionTags()}
            expandedProjects={expanded()}
            noFolderSessions={noFolderSessions()}
            hasMoreSessions={hasMoreSessions()}
            onDisplayName={updateDisplayName}
            onToggleSessionPin={togglePin}
            onEditTags={editTags}
            onArchiveSession={archiveSession}
            onLoadMoreSessions={loadMoreSessions}
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
            activeScreen={screen()}
            onRuns={() => showScreen("runs")}
            onUsage={() => showScreen("usage")}
            onContext={() => showScreen("context")}
            onAgents={() => showScreen("agents")}
            onSkills={() => showScreen("skills")}
            onWorkflows={() => showScreen("workflows")}
            onArtifacts={() => showScreen("artifacts")}
            onProviders={() => openSettings("providers")}
            onConfig={() => setConfigOpen(true)}
            onRemote={() => setRemoteOpen(true)}
            onMcp={() => openSettings("mcp")}
          />
        </PanelBoundary>
      </Show>
      <main class="fc-main" classList={{ "fc-main-chat-home": chatView() && !selected() && !mobileRemote() }}>
        <Show when={!desktopWindow()}>
          <TopStrip />
        </Show>
        <Show
          when={
            onboarded() &&
            !remote.activeHost() &&
            localNetworkReady() &&
            !health.loading &&
            health()?.healthy !== true
          }
        >
          <div class="fc-offline-banner">
            <Show
              when={localNetworkAsking()}
              fallback={
                <>
                  <Show
                    when={serverAuthRequired()}
                    fallback={
                      <span>
                        {health()?.blocked ? t("Connection blocked by the browser") : t("Server offline")} —{" "}
                        {t("start it and connect from Settings")} ·{" "}
                        <code>env -u OPENCODE_SERVER_PASSWORD opencode serve --port 4096 --cors {window.location.origin}</code>
                      </span>
                    }
                  >
                    <span>
                      {t("The engine is asking for authentication")} —{" "}
                      {t("restart it without a password, or use the desktop app")} ·{" "}
                      <code>
                        env -u OPENCODE_SERVER_PASSWORD opencode serve --port 4096 --cors{" "}
                        {window.location.origin}
                      </code>
                    </span>
                  </Show>
                  <button class="fc-button" type="button" onClick={() => void refetchHealth()}>
                    {t("Retry")}
                  </button>
                </>
              }
            >
              <span>
                {localNetwork() === "denied"
                  ? t(
                      "Local network access is blocked for this site. Allow it in your browser's site settings, then try again.",
                    )
                  : t("This web page needs your permission to reach the engine on this device before it can connect.")}
              </span>
              <Show when={localNetwork() !== "denied"}>
                <button
                  class="fc-button fc-button-primary"
                  type="button"
                  disabled={allowingLocalNetwork()}
                  onClick={() => void allowLocalNetwork()}
                >
                  {allowingLocalNetwork() ? t("Asking…") : t("Allow access")}
                </button>
              </Show>
              <button class="fc-button" type="button" onClick={() => void refetchHealth()}>
                {t("Retry")}
              </button>
            </Show>
          </div>
        </Show>
        {/* Tool screens live in the main column (HF-9): the sidebar stays visible. */}
        <Show when={toolScreen()}>
          <RunsPanel
            open={runsOpen()}
            runs={runs()}
            serverAvailable={routinesServerAvailable()}
            onStop={stopRun}
            onRemove={removeRun}
            onClear={clearRuns}
            onStopAll={stopAllRuns}
            onApprove={approveRun}
            onMergeWorktrees={mergeWorktrees}
            onCleanupWorktrees={cleanupWorktrees}
            activity={taskActivity() ?? {}}
            touched={touched() ?? {}}
            tools={taskTools() ?? {}}
            artifacts={runArtifacts() ?? {}}
            models={modelList()}
            onRetry={retryTask}
            onSteer={steerTask}
            onCancelTask={cancelTask}
            onResume={resumeRun}
            onBestOfN={() => setBestOfNOpen(true)}
            onOpenSession={(id) => {
              leaveScreen()
              selectSession(id)
            }}
            onOpenChanges={(directory) => {
              setTargetDirectory(directory)
              showScreen("changes")
            }}
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
            onDiscard={discardChanges}
            onGenerateMessage={generateCommitMessage}
            onBranch={startBranch}
            checkpoints={checkpoints() ?? []}
            checkpointBusy={checkpointBusy()}
            onCheckpointPlan={checkpointPlan}
            onCheckpointRestore={restoreCheckpoint}
            onCheckpointTake={takeCheckpoint}
            onCheckpointRemove={removeCheckpoint}
            findings={findings() ?? []}
            onResolveFinding={resolveFinding}
          />
          <WorkflowsPanel
            open={workflowsScreenOpen()}
            files={workflows() ?? []}
            loading={workflows.loading}
            serverAvailable={workflowsAvailable()}
            directory={modelLocation()}
            onRead={readWorkflowFile}
            onSave={saveWorkflowFile}
            onDelete={deleteWorkflowFile}
            onRun={(workflow) => setLaunching({ workflow })}
          />
          <ArtifactsPanel
            open={artifactsOpen()}
            artifacts={artifactList()}
            sessionFiles={artifacts()}
            serverAvailable={artifactsAvailable()}
            canOpenFiles={canOpenLocalFiles()}
            rawUrl={(id) => createHarnessClient(harnessServerUrl()).artifacts.rawUrl(id)}
            onCopy={copyPath}
            onRemove={removeArtifact}
            onUpdate={updateArtifact}
            onOpenRun={() => showScreen("runs")}
            onOpenPath={(path) => void openLocalPath(path)}
            onOpenInEditor={(path) => void openInEditor(path)}
          />
          <ComparePanel
            open={compareOpen()}
            runs={runs()}
            initialLeft={compareArgs().left}
            initialRight={compareArgs().right}
            onLoad={compareSnapshot}
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
            prompts={capturedPrompts()}
            promptsLoading={capturedPrompts.loading}
            toolUses={toolUses()?.tools}
            toolCalls={toolUses()?.calls}
            onRead={readInstruction}
          />
          <AgentsPanel
            open={agentsOpen()}
            files={agentFiles() ?? []}
            agents={folderAgents() ?? []}
            tools={engineTools() ?? []}
            mcp={mcp()?.data ?? []}
            models={modelList()}
            favorites={favorites()}
            onToggleFavorite={toggleFavoriteModel}
            loading={agentFiles.loading}
            serverAvailable={routinesServerAvailable()}
            hasProject={!!vcsDirectory()}
            onSave={saveAgent}
            onDelete={deleteAgent}
          />
          <SkillCatalogue
            open={skillsScreenOpen()}
            files={skillFiles() ?? []}
            skills={skills()?.data ?? []}
            loading={skillFiles.loading}
            skillsLoading={skills.loading}
            serverAvailable={routinesServerAvailable()}
            hasProject={!!vcsDirectory()}
            sources={skillSources()}
            agents={agentFiles() ?? []}
            onAddSource={addSkillSource}
            onRemoveSource={removeSkillSource}
            onRead={readSkillFile}
            onSave={saveSkill}
            onDelete={deleteSkillFile}
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
          />
        </Show>
        <Show
          when={!splitActive() && !toolScreen()}
          fallback={
            // A tool screen replaces both branches: the split panes keep their state and return
            // when the screen is left.
            toolScreen() ? (
              <></>
            ) : (
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
                        chat={chatClass(session())}
                        chatsDirectory={chatsDirectory()}
                        showTools={showTools()}
                        showReasoning={showReasoning()}
                        models={modelList()}
                        defaultModel={modelRef()}
                        compaction={engineConfig()?.compaction}
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
            )
          }
        >
          {/* The sessions open in this window (H-36). Hidden while split: the panes are the tabs then. */}
          <Show when={sessionTabsEnabled() && !mobileRemote() && selected() && sessionTabs().length > 1}>
            <SessionTabs
              tabs={sessionTabList()}
              active={selected()}
              onSelect={selectSession}
              onClose={closeSessionTab}
            />
          </Show>
          <Show
            when={selected()}
            fallback={
              mobileRemote() ? (
                mobileComposing() ? (
                  <div class="fc-mobile-new">
                    <p class="fc-onboarding-text">
                      {plainChatView()
                        ? t("Write a message to start a chat.")
                        : t("Describe a task to start a new session.")}
                    </p>
                  </div>
                ) : (
                  <RemoteHome
                    view={view()}
                    onViewChange={changeView}
                    viewActivity={viewActivity()}
                    sessions={remoteSessions()}
                    loading={sessions.loading}
                    projects={projects()}
                    runs={remoteRuns()}
                    onOpen={openMobileSession}
                    onOpenRun={openMobileSession}
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
                  activity={activity()}
                  activeSessions={activeSessions()}
                  onOpenSession={selectSession}
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
                compacting={compacting()}
                retry={(() => {
                  const sessionID = selected()
                  return sessionID ? retryState()[sessionID] : undefined
                })()}
                usage={liveUsage()}
                startedAt={generationStartedAt()}
                modelName={modelName}
                showTools={showTools()}
                showReasoning={showReasoning()}
                chat={plainChatView()}
                pending={pendingForSession()}
                onEditUser={editMessage}
                onRecoverUser={unsendMessage}
                onForkUser={forkSession}
                onRetry={retryTurn}
                onOpenSession={selectSession}
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
            <Composer
              variant={mobileRemote() ? "mobile" : "desktop"}
              mode={view()}
                chatClass={composerChatClass()}
                onChatClassChange={changeChatClass}
                sessionOpen={!!selected()}
                value={prompt()}
                sending={busy()}
                generating={!!selected() && generating()}
                compacting={compacting()}
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
                  vcsDirectory() && codeChrome()
                    ? {
                        directory: vcsDirectory()!,
                        branch: vcsInfo()?.branch,
                        additions: vcsTotals().additions,
                        deletions: vcsTotals().deletions,
                        onCommit: commitChanges,
                        onOpenChanges: openChanges,
                        onClose: selected() ? () => newSession() : undefined,
                        onClear: !selected() && targetDirectory() ? () => changeTargetDirectory(undefined) : undefined,
                      }
                    : undefined
                }
                pullRequest={
                  vcsDirectory() && codeChrome()
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
                artifacts={(artifactList() ?? []).flatMap((artifact): Array<{ id?: string; path?: string; title?: string; kind?: string }> =>
                  artifact.path
                    ? [{ path: artifact.path, title: artifact.title }]
                    : artifact.content
                      ? [{ id: artifact.id, title: artifact.title, kind: artifact.kind }]
                      : [],
                )}
                packs={packs()}
                onSavePack={(refs) => setPackRefs(refs)}
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
                onTargetChange={changeComposerTarget}
                onOpenFolder={() => setFolderOpen(true)}
                onAgentChange={changeAgent}
                onPermissionModeChange={changePermissionMode}
              />
            <Show when={chatView() && !selected() && !mobileRemote()}>
              <ChatStarters onPick={(text) => setPrompt(text)} />
            </Show>
          </Show>
        </Show>
      </main>
      <Show when={!mobileRemote() && codeChrome()}>
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
              todos={todos()}
              onClearTodos={clearTodos}
              subagents={visibleSubagents()}
              onClearSubagents={clearSubagents}
              onOpenSubagent={selectSession}
              runningSubagents={Object.keys(runState()).filter((id) => runState()[id])}
              blockedSubagents={blockedSessions()}
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
        workflows={workflows() ?? []}
        onClose={() => setPaletteOpen(false)}
        onCommand={runCommand}
        onSession={selectSession}
        onProject={(directory) => {
          leaveScreen()
          changeComposerTarget(directory)
        }}
        onArtifact={() => showScreen("artifacts")}
        onRoutine={(id) => {
          setRoutineFocus(id)
          showScreen("routines")
        }}
        onRun={() => showScreen("runs")}
        onWorkflow={(name) => {
          const workflow = workflowNamed(name)
          if (workflow) setLaunching({ workflow })
        }}
        onFile={(path) => setPrompt((value) => (value ? `${value} @${path} ` : `@${path} `))}
        searchFiles={searchFiles}
        searchSessions={searchSessions}
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
      <ExportDialog
        open={exportOpen()}
        title={sessionTitle(selectedSession()) || t("This conversation")}
        canShare={supports("shares")}
        onExport={runExport}
        onShare={runShare}
        onClose={() => setExportOpen(false)}
      />
      <RenameDialog
        open={!!renameTarget()}
        title={t("Rename")}
        initial={renameTarget()?.title ?? ""}
        onSave={commitRename}
        onClose={() => setRenameTarget(undefined)}
      />
      <RenameDialog
        open={!!packRefs()}
        title={t("Name this pack")}
        initial=""
        onSave={savePack}
        onClose={() => setPackRefs(undefined)}
      />
      <WorkflowLaunchDialog
        open={!!launching()}
        workflow={launching()?.workflow}
        packs={packs()}
        initialArgs={launching()?.args}
        onLaunch={(launch) => {
          const workflow = launching()?.workflow
          setLaunching(undefined)
          if (workflow) void runWorkflow(workflow.name, launch)
        }}
        onClose={() => setLaunching(undefined)}
      />
      <BestOfNDialog
        open={bestOfNOpen()}
        models={modelList()}
        loading={models.loading}
        favorites={favorites()}
        onLaunch={launchBestOfN}
        onClose={() => setBestOfNOpen(false)}
      />
      <TagsDialog
        open={!!tagsTarget()}
        title={tagsTarget()?.title ? t("Tags · {name}", { name: tagsTarget()!.title }) : t("Tags")}
        initial={tagsTarget()?.tags ?? []}
        onSave={(tags) => {
          const target = tagsTarget()
          if (target) setTags(target.id, tags)
          setTagsTarget(undefined)
        }}
        onClose={() => setTagsTarget(undefined)}
      />
      <ConfirmDialog
        open={!!confirmTarget()}
        title={confirmTarget()?.title ?? ""}
        message={confirmTarget()?.message ?? ""}
        confirmLabel={confirmTarget()?.confirmLabel}
        onConfirm={() => confirmTarget()?.onConfirm()}
        onClose={() => setConfirmTarget(undefined)}
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
        sessionTabs={sessionTabsEnabled()}
        replySuggestions={suggestionsOn()}
        onToggleReplySuggestions={toggleSuggestions}
        suggestionModel={suggestionModel()}
        onSuggestionModel={(key) => {
          setSuggestionModel(key)
          writeStorage(STORAGE_KEYS.suggestionModel, key)
        }}
        notifications={notifications()}
        keybinds={keybinds()}
        savedPermissions={savedPermissions()?.data ?? []}
        onRevokePermission={revokePermission}
        permissionPolicy={permissionPolicy()}
        permissionServerAvailable={ready()}
        onSavePermissionPolicy={savePermissionPolicy}
        commandFiles={commandFiles() ?? []}
        commandAgents={(agents()?.data ?? []).map((agent) => agent.id)}
        onSaveCommand={saveCommand}
        onDeleteCommand={deleteCommand}
        mcpServers={mcp()?.data ?? []}
        mcpConfigs={mcpConfigs()?.data ?? {}}
        mcpResources={mcpResources() ?? []}
        agentFiles={agentFiles() ?? []}
        mcpBusy={false}
        onAddMcp={addMcp}
        onRemoveMcp={removeMcp}
        onConnectMcp={connectMcp}
        onDisconnectMcp={disconnectMcp}
        onOAuthMcp={oauthMcp}
        onTheme={updateTheme}
        onColorTheme={updateColorTheme}
        onLocale={setLocale}
        onDisplayName={updateDisplayName}
        onServerInput={setServerInput}
        onServerCommit={commitServer}
        onServerReload={reloadEngine}
        serverReloading={serverReloading()}
        onModelChange={changeModel}
        modelVariants={variants()}
        modelVariant={variantKey()}
        onModelVariantChange={changeVariant}
        onToggleTools={toggleTools}
        onToggleReasoning={toggleReasoning}
        onToggleSessionTabs={toggleSessionTabs}
        onToggleNotifications={toggleNotifications}
        onKeybind={changeKeybind}
        section={settingsSection() ?? "appearance"}
        onSectionChange={setSettingsSection}
        agentsList={folderAgents() ?? []}
        agentTools={engineTools() ?? []}
        favorites={favorites()}
        onToggleFavorite={toggleFavoriteModel}
        agentsLoading={agentFiles.loading}
        agentsHasProject={!!vcsDirectory()}
        onSaveAgent={saveAgent}
        onDeleteAgent={deleteAgent}
        providersList={providerDirectory()?.all ?? []}
        providerAuth={providerAuth() ?? {}}
        providerConnected={providerDirectory()?.connected ?? []}
        providerIntegrations={integrations()?.data ?? []}
        providerUnlinked={unlinkedProviders() ?? []}
        providersBusy={busy()}
        onSaveProvider={saveProvider}
        onRemoveProvider={removeProvider}
        onProviderOAuth={startOAuth}
        onProviderOAuthStatus={oAuthStatus}
        onProviderOAuthCancel={cancelOAuth}
        onProviderOAuthDone={finishOAuth}
        onProviderOAuthLegacy={legacyOAuthAuthorize}
        onProviderOAuthLegacyCallback={legacyOAuthCallback}
        onLinkConfiguredProviders={linkConfiguredKeys}
        consoleActive={consoleActive()}
        consoleOrgs={consoleOrgs() ?? []}
        onSwitchConsole={switchConsoleOrg}
        onOpenSkills={() => {
          setSettingsOpen(false)
          showScreen("skills")
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
      <FilesPanel
        open={filesOpen()}
        directory={vcsDirectory()}
        list={listFiles}
        search={searchFileEntries}
        read={readFileText}
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
        serverAuthRequired={serverAuthRequired()}
        localNetwork={localNetwork()}
        allowingLocalNetwork={allowingLocalNetwork()}
        onAllowLocalNetwork={() => void allowLocalNetwork()}
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
      <SkillsPanel
        open={skillsOpen()}
        skills={skills()?.data ?? []}
        onInsert={(name) => {
          setPrompt(`/${name} `)
          setSkillsOpen(false)
        }}
        onClose={() => setSkillsOpen(false)}
      />
      <ReplayPanel
        open={replayOpen()}
        sessionID={selected()}
        title={selectedSession()?.title}
        onPage={replayPage}
        onClose={() => leaveScreen()}
      />
      <MemoryPanel
        open={memoryOpen()}
        serverUrl={serverUrl()}
        notes={projectNotes()}
        onAddNote={addProjectNote}
        onRemoveNote={removeProjectNote}
        onClose={() => setMemoryOpen(false)}
      />
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
