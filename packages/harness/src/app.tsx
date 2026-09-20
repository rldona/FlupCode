import { For, Show, createEffect, createMemo, createSignal, onCleanup, untrack, type Component } from "solid-js"
import { createResource } from "./resource"
import type { PermissionV2Request, ProviderDirectoryInfo, QuestionV2Request } from "./engine-types"
import type { SessionMessageAssistant } from "./engine-types"
import { createClient, invalidateLegacyHistory, resolveServerUrl } from "./client"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"
import { activityByDay, comparison, computeMetrics, filterByRange, sessionCost, type UsageRange } from "./metrics"
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
import { CHAT_PERMISSION, CHAT_SYSTEM, isChatSession, type AppView } from "./chat"
import type { ModelInfo } from "./engine-types"
import type { Attachment, CommandOption, McpConfig, ProjectItem, Routine, StashedPrompt } from "./types"
import { getLocale, setLocale, t, type Locale } from "./i18n"
import { toast } from "./toast"
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
import { FolderDialog } from "./components/FolderDialog"
import { permissionMode } from "./permission-modes"
import { ProvidersPanel } from "./components/ProvidersPanel"
import { StashDialog } from "./components/StashDialog"
import { SettingsPanel } from "./components/SettingsPanel"
import { RoutinesPanel } from "./components/RoutinesPanel"
import { Onboarding } from "./components/Onboarding"
import { RemotePanel } from "./components/RemotePanel"
import { ArtifactsPanel } from "./components/ArtifactsPanel"
import { SkillsPanel } from "./components/SkillsPanel"
import { ConfigPanel } from "./components/ConfigPanel"
import { desktopRemote, remote, remoteBaseUrl, touchDevice } from "./remote"
import { RemoteHome, type RemoteSessionItem } from "./components/RemoteHome"
import { MobileComposer } from "./components/MobileComposer"
import { ChatHero, ChatStarters } from "./components/ChatHome"
import { SessionPane } from "./components/SessionPane"
import { closePane, keepExisting, openInSplit, showInFocusedPane } from "./split"
import { publishSessionEvent } from "./session-events"
import { engineFetch } from "./transport"

type Client = ReturnType<typeof createClient>

const BUILTIN_COMMANDS: Array<{ name: string; descriptionKey: string }> = [
  { name: "new", descriptionKey: "New session…" },
  { name: "compact", descriptionKey: "Compact the current session" },
  { name: "steps", descriptionKey: "Show or hide tool steps" },
  { name: "mcp", descriptionKey: "MCP servers…" },
  { name: "stash", descriptionKey: "Save the current prompt" },
  { name: "stashes", descriptionKey: "View saved prompts" },
  { name: "skills", descriptionKey: "Skills" },
  { name: "config", descriptionKey: "Config (advanced)" },
  { name: "settings", descriptionKey: "Customize FlupCode" },
  { name: "routines", descriptionKey: "Scheduled tasks" },
  { name: "remote", descriptionKey: "Remote control / mobile" },
  { name: "artifacts", descriptionKey: "Artifacts" },
  { name: "about", descriptionKey: "About FlupCode" },
]

export const App: Component = () => {
  const [localServerUrl, setLocalServerUrl] = createSignal(readStorage(STORAGE_KEYS.serverUrl, resolveServerUrl()))
  const [serverInput, setServerInput] = createSignal(localServerUrl())
  const serverUrl = () => {
    const host = remote.activeHost()
    return host ? remoteBaseUrl(host.hostId) : localServerUrl()
  }
  const [selected, setSelected] = createSignal<string | undefined>(
    // Phones controlling a computer always start on the sessions home, not the last open session.
    touchDevice && !desktopRemote() && remote.activeHost()
      ? undefined
      : readStorage<string>(STORAGE_KEYS.selectedSession, "") || undefined,
  )
  const [prompt, setPrompt] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [streamedChars, setStreamedChars] = createSignal(0)
  const [liveText, setLiveText] = createSignal("")
  const [liveReasoning, setLiveReasoning] = createSignal("")
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
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const setRunning = (sessionID: string, running: boolean) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.delete(sessionID)
    setRunState((state) => (state[sessionID] === running ? state : { ...state, [sessionID]: running }))
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
  const [agent, setAgent] = createSignal(readStorage(STORAGE_KEYS.agent, "build"))
  const [permissionModeId, setPermissionModeId] = createSignal(readStorage(STORAGE_KEYS.permissionMode, "auto"))
  const [panels, setPanels] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.workspacePanels, []))
  const [workspaceWidth, setWorkspaceWidth] = createSignal(readStorage(STORAGE_KEYS.workspaceWidth, WORKSPACE_WIDTH_DEFAULT))
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
  const [favorites, setFavorites] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.favoriteModels, []))
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [aboutOpen, setAboutOpen] = createSignal(false)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [showTools, setShowTools] = createSignal(true)
  const [mcpOpen, setMcpOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [routinesOpen, setRoutinesOpen] = createSignal(false)
  const [remoteOpen, setRemoteOpen] = createSignal(false)
  const [providersOpen, setProvidersOpen] = createSignal(false)
  const [folderOpen, setFolderOpen] = createSignal(false)
  const [artifactsOpen, setArtifactsOpen] = createSignal(false)
  const [skillsOpen, setSkillsOpen] = createSignal(false)
  const [configOpen, setConfigOpen] = createSignal(false)
  const [notifications, setNotifications] = createSignal(readStorage(STORAGE_KEYS.notifications, false))
  const [paletteKey, setPaletteKey] = createSignal(readStorage(STORAGE_KEYS.paletteKey, "mod+k"))
  const [targetDirectory, setTargetDirectory] = createSignal<string>()
  const [routines, setRoutines] = createSignal<Routine[]>(readStorage<Routine[]>(STORAGE_KEYS.routines, []))
  const [onboarded, setOnboarded] = createSignal(readStorage(STORAGE_KEYS.onboarded, false))
  const [theme, setTheme] = createSignal(readStorage(STORAGE_KEYS.theme, "system"))
  const [stashOpen, setStashOpen] = createSignal(false)
  const [stashes, setStashes] = createSignal<StashedPrompt[]>(
    readStorage<StashedPrompt[]>(STORAGE_KEYS.stashedPrompts, []),
  )

  const client = () => createClient(serverUrl())
  // Never reject: an errored resource throws on every read and freezes the effects that depend on it.
  const [health, { refetch: refetchHealth }] = createResource(serverUrl, (url) =>
    createClient(url)
      .health.get()
      .catch(() => ({ healthy: false, version: undefined })),
  )
  const ready = () => health()?.healthy === true

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
    if (next === view()) return
    setView(next)
    writeStorage(STORAGE_KEYS.view, next)
    // The open session belongs to the other tab: start from this tab's home.
    if (selected() && isChat(selectedSession()) !== (next === "chat")) {
      setSelected(undefined)
      setTargetDirectory(undefined)
      setMobileComposing(false)
    }
  }
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
  const modelLocation = () => targetDirectory() ?? selectedSession()?.location?.directory
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
  const [linkedProviders, setLinkedProviders] = createSignal<string[]>([])
  createEffect(() => {
    const url = ready() ? serverUrl() : undefined
    const providers = providerDirectory()?.all ?? []
    if (!url || providers.length === 0) return
    const pending = providers.filter(
      (provider): provider is ProviderDirectoryInfo & { key: string } =>
        provider.source === "api" && !!provider.key && !linkedProviders().includes(`${url}::${provider.id}`),
    )
    if (pending.length === 0) return
    setLinkedProviders((previous) => [...previous, ...pending.map((provider) => `${url}::${provider.id}`)])
    const current = createClient(url)
    void current.integration
      .list()
      .then((integrations) =>
        Promise.all(
          pending.map(async (provider) => {
            const connected = integrations.data
              .find((item) => item.id === provider.id)
              ?.connections?.some((connection) => connection.type === "credential")
            if (connected) return
            await current.integration
              .connectKey({ integrationID: provider.id, key: provider.key, label: provider.id })
              .catch(() => undefined)
          }),
        ),
      )
      .then(() => void refetchModels())
      .catch(() => undefined)
  })

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
  const [permissions, { refetch: refetchPermissions }] = createResource(
    () => {
      const sessionID = selected()
      return ready() && sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    (source) => createClient(source.url).session.permission.list({ sessionID: source.sessionID }),
  )
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => {
      const sessionID = selected()
      return ready() && sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    (source) => createClient(source.url).session.question.list({ sessionID: source.sessionID }),
  )
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
  const activeMessages = () => {
    const value = messages()
    if (!value || value.sessionID !== selected()) return undefined
    return value.data
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
    if ((permissions()?.data?.length ?? 0) > 0 || (questions()?.data?.length ?? 0) > 0) return
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
  const contextUsage = () => {
    const session = selectedSession()
    const limit = currentModel()?.limit?.context ?? 0
    const list = activeMessages() ?? []
    const last = [...list].reverse().find((message) => message.type === "assistant") as
      | SessionMessageAssistant
      | undefined
    const tokens = last?.tokens
    const used = tokens ? tokens.input + (tokens.cache?.read ?? 0) : (session?.tokens?.input ?? 0)
    return {
      used,
      limit,
      cost: sessionCost(session, list, modelList()),
      tokens: tokens ? { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning } : undefined,
    }
  }

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
    ...BUILTIN_COMMANDS.map((command) => ({ name: command.name, description: t(command.descriptionKey) })),
    ...(commands()?.data ?? []).map((command) => ({ name: command.name, description: command.description })),
    ...(skills()?.data ?? []).map((skill) => ({ name: skill.name, description: skill.description ?? "Skill" })),
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

  const searchFiles = async (query: string) => {
    const response = await createClient(serverUrl()).file.find({ query, limit: 8 })
    return response.data
  }

  const runCommand = (name: string) => {
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
      setRoutinesOpen(true)
      return
    }
    if (name === "remote") {
      setRemoteOpen(true)
      return
    }
    if (name === "artifacts") {
      setArtifactsOpen(true)
      return
    }
    if (name === "skills") {
      setSkillsOpen(true)
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
      if (wantMessages) {
        void refetchMessages()
        void refetchVcsInfo()
        void refetchVcsStatus()
      }
      if (wantSessions) void refetchSessions()
    }, 300)
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
        try {
          // Runs that started or ended while disconnected send no step events to catch up on.
          void createClient(url)
            .session.active()
            .then((active) => {
              Object.entries(runState())
                .filter(([id, running]) => running && !active.has(id))
                .forEach(([id]) => setRunning(id, false))
              active.forEach((id) => {
                setRunning(id, true)
                watchRun(id, 2000)
              })
            })
            .catch(() => undefined)
          for await (const event of createClient(url).event.subscribe({ signal: controller.signal })) {
            attempt = 0
            const type = event.type ?? ""
            const payload = (event as { data?: { sessionID?: string; delta?: string } }).data
            trackActivity(type, payload as { sessionID?: string; status?: { type?: string } } | undefined)
            if (type === "session.next.step.started") {
              if (payload?.sessionID) publishSessionEvent({ kind: "turn", sessionID: payload.sessionID })
              if (payload?.sessionID === selected()) {
                setStreamedChars(0)
                setLiveText("")
                setLiveReasoning("")
              }
              scheduleRefetch(true, false)
            } else if (type.endsWith(".delta")) {
              const delta = payload?.delta
              if (payload?.sessionID && typeof delta === "string" && (type.includes("text") || type.includes("reasoning"))) {
                publishSessionEvent({
                  kind: "live",
                  sessionID: payload.sessionID,
                  field: type.includes("reasoning") ? "reasoning" : "text",
                  delta,
                })
              }
              if (payload?.sessionID === selected() && typeof delta === "string") {
                setStreamedChars((value) => value + delta.length)
                if (type.includes("reasoning")) setLiveReasoning((value) => value + delta)
                else if (type.includes("text")) setLiveText((value) => value + delta)
              }
              continue
            }
            if (type.startsWith("permission.") || type.startsWith("question.")) {
              setActivityTick((value) => value + 1)
              publishSessionEvent({ kind: "requests" })
            }
            if (type.startsWith("permission.")) {
              if (type === "permission.v2.asked") notify(t("Permission needed"), "")
              void refetchPermissions()
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
                data?: { sessionID?: string; info?: { sessionID?: string }; part?: { sessionID?: string } }
              }
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
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
        if (!controller.signal.aborted) {
          scheduleRefetch(true, true)
          publishSessionEvent({ kind: "changed" })
        }
      }
    })()
  })

  // Chats run through the legacy prompt, whose deltas and status only stream on their folder's events.
  createEffect(() => {
    const directory = chatsDirectory()
    if (!ready() || !directory) return
    const url = serverUrl()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    // Text and reasoning deltas both say `field: "text"`; the part's type comes with its first update.
    const partTypes = new Map<string, string>()
    // The engine updates a user message again mid-answer (its summary), so only a new one starts a turn.
    const lastUserMessage = new Map<string, string>()
    void (async () => {
      for (let attempt = 0; !controller.signal.aborted; attempt++) {
        try {
          const stream = createClient(url).event.subscribeDirectory(directory, { signal: controller.signal })
          for await (const event of stream) {
            attempt = 0
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
            if (type === "message.part.delta") {
              const part = partTypes.get(data?.partID ?? "")
              if (sessionID && typeof data?.delta === "string" && (part === "text" || part === "reasoning")) {
                publishSessionEvent({ kind: "live", sessionID, field: part, delta: data.delta })
              }
              if (sessionID === selected() && typeof data?.delta === "string") {
                const delta = data.delta
                setStreamedChars((value) => value + delta.length)
                if (part === "reasoning") setLiveReasoning((value) => value + delta)
                else if (part === "text") setLiveText((value) => value + delta)
              }
              continue
            }
            if (type === "message.part.updated" && data?.part?.id && data.part.type) {
              partTypes.set(data.part.id, data.part.type)
            }
            if (type.startsWith("message.")) {
              // A new user message starts a turn: drop what streamed for the previous one.
              const newTurn =
                type === "message.updated" &&
                data?.info?.role === "user" &&
                !!sessionID &&
                !!data.info.id &&
                lastUserMessage.get(sessionID) !== data.info.id
              if (newTurn && sessionID && data?.info?.id) {
                lastUserMessage.set(sessionID, data.info.id)
                publishSessionEvent({ kind: "turn", sessionID })
              }
              publishSessionEvent({ kind: "changed", sessionID })
              if (newTurn && sessionID === selected()) {
                setLiveText("")
                setLiveReasoning("")
                setStreamedChars(0)
              }
              invalidateLegacyHistory(sessionID)
              scheduleRefetch(true, false)
            } else if (type === "session.idle") {
              scheduleRefetch(true, true)
            } else if (type.startsWith("session.")) {
              scheduleRefetch(false, true)
            }
          }
        } catch {
          if (controller.signal.aborted) return
        }
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
      }
    })()
  })

  createEffect(() => {
    selected()
    setLiveText("")
    setLiveReasoning("")
    setStreamedChars(0)
  })

  createEffect(() => {
    const list = activeMessages()
    if (!list || list.length === 0) return
    const last = [...list].reverse().find((message) => message.type === "assistant")
    if (!last) return
    const content = (last as SessionMessageAssistant).content ?? []
    const text = content
      .filter((part) => part.type === "text")
      .map((part) => (part as { text: string }).text)
      .join("")
    const reasoning = content
      .filter((part) => part.type === "reasoning")
      .map((part) => (part as { text: string }).text)
      .join("")
    const currentText = liveText()
    if (currentText && text.includes(currentText)) setLiveText("")
    const currentReasoning = liveReasoning()
    if (currentReasoning && reasoning.includes(currentReasoning)) setLiveReasoning("")
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

  createEffect(() => {
    if (narrow()) setCollapsed(true)
  })

  const modelLabel = () => currentModel()?.name ?? t("Default model")
  const modelName = (ref: { providerID: string; id: string }) =>
    modelList().find((entry) => entry.providerID === ref.providerID && entry.id === ref.id)?.name ?? ref.id

  const toggleFavoriteModel = (key: string) => {
    setFavorites((current) => {
      const next = current.includes(key) ? current.filter((item) => item !== key) : [...current, key]
      writeStorage(STORAGE_KEYS.favoriteModels, next)
      return next
    })
  }

  const pickModel = (providerID: string, id: string) => {
    setModelRef({ providerID, id })
    setModelPickerOpen(false)
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.switchModel({ sessionID, model: { id, providerID } })
      return undefined
    })
  }

  const changeModel = (key: string) => {
    const [providerID, ...rest] = key.split("/")
    const id = rest.join("/")
    if (!providerID || !id) return
    setModelRef({ providerID, id })
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.switchModel({ sessionID, model: { id, providerID } })
      return undefined
    })
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
          title: session.title,
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

  const canGoBack = () => historyIndex() > 0
  const canGoForward = () => historyIndex() >= 0 && historyIndex() < history().length - 1

  const selectSession = (id: string) => {
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

  createEffect(() => {
    const mode = theme()
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const apply = () => {
      const dark = mode === "dark" || (mode === "system" && media.matches)
      document.documentElement.classList.toggle("fc-dark", dark)
      // The browser and installed app paint their status bar with this colour.
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0f0f0f" : "#ffffff")
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

  const persistRoutines = (next: Routine[]) => {
    setRoutines(next)
    writeStorage(STORAGE_KEYS.routines, next)
  }

  const addRoutine = (input: { name: string; prompt: string; intervalMinutes: number }) => {
    persistRoutines([...routines(), { id: newId(), ...input, enabled: true, createdAt: Date.now() }])
    toast(t("Routine created"), "success")
  }

  const toggleRoutine = (id: string) => {
    persistRoutines(
      routines().map((routine) => (routine.id === id ? { ...routine, enabled: !routine.enabled } : routine)),
    )
  }

  const removeRoutine = (id: string) => {
    persistRoutines(routines().filter((routine) => routine.id !== id))
  }

  const markRoutineRun = (id: string) => {
    persistRoutines(routines().map((routine) => (routine.id === id ? { ...routine, lastRunAt: Date.now() } : routine)))
  }

  const executeRoutine = (routine: Routine) => {
    void (async () => {
      setBusy(true)
      try {
        const current = createClient(serverUrl())
        const model = selectedModel()
        const session = await current.session.create(model ? { model } : {})
        await current.session.rename({ sessionID: session.id, title: routine.name })
        await current.session.prompt({ sessionID: session.id, text: routine.prompt })
        void refetchSessions()
        toast(t('Routine "{name}" executed', { name: routine.name }), "success")
      } catch (cause) {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
      } finally {
        setBusy(false)
      }
    })()
  }

  const runRoutine = (id: string) => {
    const routine = routines().find((entry) => entry.id === id)
    if (!routine) return
    markRoutineRun(id)
    executeRoutine(routine)
  }

  createEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now()
      for (const routine of routines()) {
        if (!routine.enabled) continue
        if (routine.lastRunAt && now - routine.lastRunAt < routine.intervalMinutes * 60000) continue
        markRoutineRun(routine.id)
        executeRoutine(routine)
      }
    }, 30000)
    onCleanup(() => clearInterval(timer))
  })

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

  const replyPermission = (request: PermissionV2Request, reply: PermissionReply) =>
    run(async (current) => {
      await current.session.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply })
      void refetchPermissions()
      return undefined
    })

  const replyQuestion = (request: QuestionV2Request, answers: string[][]) =>
    run(async (current) => {
      await current.session.question.reply({ sessionID: request.sessionID, requestID: request.id, answers })
      void refetchQuestions()
      return undefined
    })

  const rejectQuestion = (request: QuestionV2Request) =>
    run(async (current) => {
      await current.session.question.reject({ sessionID: request.sessionID, requestID: request.id })
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

  const forkSession = () => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      const forked = await current.session.fork({ sessionID })
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
    const currentTitle = sessionList()?.find((session) => session.id === sessionID)?.title ?? ""
    const title = window.prompt(t("New title"), currentTitle)
    if (!title) return
    void run(async (current) => {
      await current.session.rename({ sessionID, title })
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
    const lines: string[] = [`# ${selectedSession()?.title ?? sessionID}`, ""]
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

  const titleFromText = (value: string) => {
    const line = value.replace(/\s+/g, " ").trim()
    if (!line) return t("New session")
    return line.length > 60 ? `${line.slice(0, 57)}…` : line
  }

  // Chats have no commands or shell: everything typed is the message.
  const sendChat = (text: string, files: Attachment[]) => {
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
        await current.session.rename({ sessionID, title: titleFromText(text) })
        await current.session.setPermission({ sessionID, permission: CHAT_PERMISSION, directory })
      }
      forgetRun(sessionID)
      await current.session.chat({
        sessionID,
        directory,
        text: expandPastes(text),
        system: CHAT_SYSTEM,
        files: files.map(({ uri, name }) => ({ uri, name })),
        ...(model ? { model } : {}),
      })
      setStreamedChars(0)
      setPrompt("")
      setAttachments([])
      return sessionID
    }, t("Message sent"))
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
        setRoutinesOpen(true)
        return
      }
      if (name === "remote") {
        setPrompt("")
        setRemoteOpen(true)
        return
      }
      if (name === "artifacts") {
        setPrompt("")
        setArtifactsOpen(true)
        return
      }
      if (name === "skills") {
        setPrompt("")
        setSkillsOpen(true)
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
      if (!existing) {
        await current.session.rename({ sessionID, title: titleFromText(text) })
        if (!location) setNoFolderSessions((list) => (list.includes(sessionID) ? list : [...list, sessionID]))
      }
      await current.session.setPermission({
        sessionID,
        permission: permissionMode(permissionModeId()).rules,
        directory: location ?? selectedSession()?.location?.directory,
      })
      forgetRun(sessionID)
      await current.session.prompt({
        sessionID,
        text: expandPastes(text),
        ...(files.length > 0 ? { files: files.map(({ uri, name }) => ({ uri, name })) } : {}),
      })
      setStreamedChars(0)
      setPrompt("")
      setAttachments([])
      return sessionID
    }, t("Message sent"))
  }

  const commitChanges = () => {
    setPrompt(t("Commit the current changes with a clear message."))
    send()
  }

  return (
    <div
      class="fc-app"
      classList={{ "fc-mobile-remote": mobileRemote() }}
      style={{
        "--fc-content-left": collapsed() || mobileRemote() ? "0px" : `${sidebarWidth()}px`,
        "--fc-content-right": mobileRemote() || chatView()
          ? "0px"
          : `${(panels().length > 0 ? workspaceWidth() : 0) + (contextPanelShown() ? contextWidth() : 0)}px`,
      }}
    >
      <Show when={!mobileRemote()}>
        <Show when={narrow() && !collapsed()}>
          <div class="fc-sidebar-backdrop" onClick={() => setCollapsed(true)} />
        </Show>
        <Sidebar
          collapsed={collapsed()}
          width={sidebarWidth()}
          displayName={displayName()}
          view={view()}
          onViewChange={changeView}
          sessions={viewSessions()}
          sessionsLoading={sessions.loading || (ready() && enginePaths.loading)}
          selectedSession={selected()}
          runningSessions={Object.keys(runState()).filter((id) => runState()[id])}
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
          onRoutines={() => setRoutinesOpen(true)}
          onArtifacts={() => setArtifactsOpen(true)}
          onProviders={() => setProvidersOpen(true)}
          onConfig={() => setConfigOpen(true)}
          onRemote={() => setRemoteOpen(true)}
          onMcp={() => setMcpOpen(true)}
        />
      </Show>
      <main class="fc-main" classList={{ "fc-main-chat-home": chatView() && !selected() && !mobileRemote() }}>
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
                    {selectedSession()?.title || (chatView() ? t("New chat") : t("New session"))}
                  </span>
                  <Show
                    when={!chatView() && (targetDirectory() ?? selectedSession()?.location?.directory)
                      ?.split("/")
                      .filter(Boolean)
                      .at(-1)}
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
            sessionTitle={
              <Show when={!splitActive() && selectedSession()}>{(session) => <SessionTitle session={session()} />}</Show>
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
        <Show when={onboarded() && !remote.activeHost() && !health.loading && health()?.healthy !== true}>
          <div class="fc-offline-banner">
            <span>
              {t("Server offline")} — {t("start it and connect from Settings")} ·{" "}
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
                        models={modelList()}
                        defaultModel={modelRef()}
                        favorites={favorites()}
                        agents={agents()?.data ?? []}
                        agent={agent()}
                        permissionModeId={permissionModeId()}
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
                      {chatView() ? t("Write a message to start a chat.") : t("Describe a task to start a new session.")}
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
            <SessionView
              messages={activeMessages()}
              loading={messagesLoading()}
              busy={generating()}
              usage={liveUsage()}
              startedAt={generationStartedAt()}
              modelName={modelName}
              liveText={liveText()}
              liveReasoning={liveReasoning()}
              showTools={showTools()}
              chat={chatView()}
              onEditUser={editMessage}
            />
          </Show>
          <Show when={!mobileRemote() || mobileScreen() === "session"}>
            <div class="fc-docks">
              <For each={permissions()?.data ?? []}>
                {(request) => (
                  <PermissionDock request={request} busy={busy()} onReply={(reply) => replyPermission(request, reply)} />
                )}
              </For>
              <For each={questions()?.data ?? []}>
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
                        onClear: !selected() && targetDirectory() ? () => changeTargetDirectory(undefined) : undefined,
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
                suggestion={currentSuggestion()}
                history={promptHistory()}
                onInput={(value) => {
                  setPrompt(value)
                  if (value) setSuggestion(undefined)
                }}
                onSend={send}
                onCommandPick={(name) => setPrompt(`/${name} `)}
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
        <WorkspacePanels
          panels={panels()}
          serverUrl={serverUrl()}
          session={selectedSession()}
          width={workspaceWidth()}
          onResize={updateWorkspaceWidth}
          onClose={closePanel}
        />
        <Show when={contextPanelShown()}>
          <RightAside
            usage={contextUsage()}
            todos={todos()}
            onClearTodos={clearTodos}
            width={contextWidth()}
            onResize={updateContextWidth}
            onHide={toggleContextPanel}
          />
        </Show>
      </Show>
      <CommandPalette
        open={paletteOpen()}
        commands={commandOptions()}
        sessions={sessionList() ?? []}
        onClose={() => setPaletteOpen(false)}
        onCommand={runCommand}
        onSession={selectSession}
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
        busy={busy()}
        onSave={saveProvider}
        onRemove={removeProvider}
        onOAuth={startOAuth}
        onOAuthStatus={oAuthStatus}
        onOAuthCancel={cancelOAuth}
        onOAuthDone={finishOAuth}
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
      <SettingsPanel
        open={settingsOpen()}
        theme={theme()}
        locale={getLocale()}
        displayName={displayName()}
        serverInput={serverInput()}
        serverStatus={serverStatus()}
        models={modelList()}
        modelKey={modelKey()}
        showTools={showTools()}
        replySuggestions={suggestionsOn()}
        onToggleReplySuggestions={toggleSuggestions}
        suggestionModel={suggestionModel()}
        onSuggestionModel={(key) => {
          setSuggestionModel(key)
          writeStorage(STORAGE_KEYS.suggestionModel, key)
        }}
        notifications={notifications()}
        paletteKey={paletteKey()}
        onTheme={updateTheme}
        onLocale={setLocale}
        onDisplayName={updateDisplayName}
        onServerInput={setServerInput}
        onServerCommit={commitServer}
        onModelChange={changeModel}
        onToggleTools={() => setShowTools((value) => !value)}
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
      <RoutinesPanel
        open={routinesOpen()}
        routines={routines()}
        busy={busy()}
        onAdd={addRoutine}
        onToggle={toggleRoutine}
        onRemove={removeRoutine}
        onRun={runRoutine}
        onClose={() => setRoutinesOpen(false)}
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
        artifacts={artifacts()}
        onCopy={copyPath}
        onClose={() => setArtifactsOpen(false)}
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
      <ConfigPanel
        open={configOpen()}
        serverUrl={serverUrl()}
        onClose={() => setConfigOpen(false)}
        onBack={() => {
          setConfigOpen(false)
          setSettingsOpen(true)
        }}
      />
    </div>
  )
}
