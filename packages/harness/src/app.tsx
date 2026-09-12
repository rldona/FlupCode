import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type Component } from "solid-js"
import type { PermissionV2Request, QuestionV2Request } from "./engine-types"
import type { SessionMessageAssistant } from "./engine-types"
import { createClient, resolveServerUrl } from "./client"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"
import { activityByDay, comparison, computeMetrics, filterByRange, type UsageRange } from "./metrics"
import type { ModelInfo } from "./engine-types"
import type { Attachment, CommandOption, McpConfig, ProjectItem, Routine, SessionTags, StashedPrompt } from "./types"
import { getLocale, setLocale, t, type Locale } from "./i18n"
import { Toaster, toast } from "./toast"
import { Sidebar } from "./components/Sidebar"
import { About } from "./components/About"
import { Topbar } from "./components/Topbar"
import { HomeCanvas } from "./components/HomeCanvas"
import { Composer } from "./components/Composer"
import { PermissionDock, type PermissionReply } from "./components/PermissionDock"
import { QuestionDock } from "./components/QuestionDock"
import { CommandPalette } from "./components/CommandPalette"
import { SessionView } from "./components/SessionView"
import { SessionToolbar } from "./components/SessionToolbar"
import { SubagentList } from "./components/SubagentList"
import { RightAside } from "./components/RightAside"
import { WorkspacePanels } from "./components/WorkspacePanels"
import { McpManager } from "./components/McpManager"
import { ModelPicker } from "./components/ModelPicker"
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
  { name: "remote", descriptionKey: "Remote access / mobile" },
  { name: "artifacts", descriptionKey: "Artifacts" },
  { name: "about", descriptionKey: "About FlupCode" },
]

export const App: Component = () => {
  const [serverUrl, setServerUrl] = createSignal(readStorage(STORAGE_KEYS.serverUrl, resolveServerUrl()))
  const [serverInput, setServerInput] = createSignal(serverUrl())
  const [selected, setSelected] = createSignal<string>()
  const [prompt, setPrompt] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [streamedChars, setStreamedChars] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal(readStorage(STORAGE_KEYS.sidebarCollapsed, false))
  const [pinned, setPinned] = createSignal(readStorage<string[]>(STORAGE_KEYS.pinnedSessions, []))
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>(
    readStorage<Record<string, boolean>>(STORAGE_KEYS.expandedProjects, {}),
  )
  const [sidebarWidth, setSidebarWidth] = createSignal(readStorage(STORAGE_KEYS.sidebarWidth, 280))
  const [agent, setAgent] = createSignal(readStorage(STORAGE_KEYS.agent, "build"))
  const [permissionModeId, setPermissionModeId] = createSignal(readStorage(STORAGE_KEYS.permissionMode, "auto"))
  const [panels, setPanels] = createSignal<string[]>(readStorage<string[]>(STORAGE_KEYS.workspacePanels, []))
  const [workspaceWidth, setWorkspaceWidth] = createSignal(readStorage(STORAGE_KEYS.workspaceWidth, 420))
  const [displayName, setDisplayName] = createSignal(readStorage(STORAGE_KEYS.displayName, ""))
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [modelRef, setModelRef] = createSignal<{ providerID: string; id: string; variant?: string }>()
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
  const [artifactsOpen, setArtifactsOpen] = createSignal(false)
  const [skillsOpen, setSkillsOpen] = createSignal(false)
  const [configOpen, setConfigOpen] = createSignal(false)
  const [tags, setTags] = createSignal<SessionTags>(readStorage<SessionTags>(STORAGE_KEYS.sessionTags, {}))
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
  const [health] = createResource(serverUrl, async (url) => createClient(url).health.get())
  const [sessions, { refetch: refetchSessions }] = createResource(serverUrl, async (url) =>
    createClient(url).session.list(),
  )
  const sessionList = () => sessions()?.data
  const selectedSession = () => sessionList()?.find((session) => session.id === selected())
  const modelLocation = () => targetDirectory() ?? selectedSession()?.location?.directory
  const [models, { refetch: refetchModels }] = createResource(
    () => [serverUrl(), modelLocation()] as const,
    ([url, directory]) => createClient(url).model.list(directory ? { location: { directory } } : undefined),
  )
  const [modelDirectory, { refetch: refetchModelDirectory }] = createResource(serverUrl, async (url) =>
    createClient(url).model.directory(),
  )
  const modelList = createMemo(() => models()?.data ?? [])
  const [agents] = createResource(serverUrl, async (url) => createClient(url).agent.list())
  const [skills] = createResource(serverUrl, async (url) => createClient(url).skill.list())
  const [mcp, { refetch: refetchMcp }] = createResource(serverUrl, async (url) => createClient(url).mcp.list())
  const [providerDirectory, { refetch: refetchProviderDirectory }] = createResource(serverUrl, async (url) =>
    createClient(url).provider.directory(),
  )
  const [providerAuth] = createResource(serverUrl, async (url) => createClient(url).provider.auth())
  const [commands] = createResource(serverUrl, async (url) => createClient(url).command.list())
  const [permissions, { refetch: refetchPermissions }] = createResource(
    () => {
      const sessionID = selected()
      return sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    (source) => createClient(source.url).session.permission.list({ sessionID: source.sessionID }),
  )
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => {
      const sessionID = selected()
      return sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    (source) => createClient(source.url).session.question.list({ sessionID: source.sessionID }),
  )
  const [messages, { refetch: refetchMessages }] = createResource(
    () => {
      const sessionID = selected()
      return sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    async (source) => createClient(source.url).message.list({ sessionID: source.sessionID, order: "asc" }),
  )
  const generating = () => {
    if (busy()) return true
    const list = messages()?.data ?? []
    const last = list[list.length - 1]
    if (!last) return false
    if (last.type === "user") return true
    if (last.type !== "assistant") return false
    const time = (last as { time?: { completed?: number } }).time
    return time !== undefined && time.completed === undefined
  }
  const liveUsage = () => {
    const list = messages()?.data ?? []
    const last = list[list.length - 1]
    if (last?.type === "assistant") {
      const assistant = last as SessionMessageAssistant
      if (assistant.tokens) return { tokens: assistant.tokens, cost: assistant.cost }
    }
    const chars = streamedChars()
    if (chars <= 0) return undefined
    return { tokens: { input: 0, output: Math.ceil(chars / 4), reasoning: 0 }, cost: undefined }
  }
  const generationStartedAt = () => {
    const list = messages()?.data ?? []
    const last = list[list.length - 1]
    if (last?.type === "user") return (last as { time?: { created?: number } }).time?.created
    if (last?.type === "assistant") return (last as SessionMessageAssistant).time?.created
    return undefined
  }
  const [children] = createResource(
    () => {
      const sessionID = selected()
      return sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    async     (source) => createClient(source.url).session.children({ sessionID: source.sessionID }),
  )

  const todos = () => {
    const data = messages()?.data ?? []
    const assistants = [...data].reverse().flatMap((message) =>
      message.type === "assistant" ? [message] : [],
    )
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

  createEffect(() => {
    const url = serverUrl()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void (async () => {
      try {
        for await (const event of createClient(url).event.subscribe({ signal: controller.signal })) {
          const type = event.type ?? ""
          const payload = (event as { data?: { sessionID?: string; delta?: string } }).data
          if (type === "session.next.step.started") {
            if (payload?.sessionID === selected()) setStreamedChars(0)
            void refetchMessages()
          } else if (type.endsWith(".delta")) {
            const delta = payload?.delta
            if (payload?.sessionID === selected() && typeof delta === "string")
              setStreamedChars((value) => value + delta.length)
            continue
          }
          if (type.startsWith("permission.")) {
            if (type === "permission.v2.asked") notify(t("Permission needed"), "")
            void refetchPermissions()
          } else if (type.startsWith("question.")) {
            if (type === "question.v2.asked") notify(t("Question asked"), "")
            void refetchQuestions()
          } else if (type.startsWith("message.") || type.startsWith("session.")) {
            void refetchMessages()
            void refetchSessions()
          }
        }
      } catch {
        return
      }
    })()
  })

  const selectedModel = () => modelRef()
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
  const variantKey = () => modelRef()?.variant

  createEffect(() => {
    if (modelRef()) return
    const preferred = Object.entries(modelDirectory()?.default ?? {}).find(([providerID, id]) =>
      modelList().some((model) => model.providerID === providerID && model.id === id),
    )
    const fallback = preferred ? { providerID: preferred[0], id: preferred[1] } : modelList()[0]
    if (!fallback) return
    setModelRef({ providerID: fallback.providerID, id: fallback.id })
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
      if (!directory) continue
      if (map.has(directory)) continue
      map.set(directory, {
        id: session.projectID || directory,
        directory,
        name: directory.split("/").filter(Boolean).at(-1) || directory,
      })
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
  })

  const [range, setRange] = createSignal<UsageRange>("all")
  const filteredSessions = createMemo(() => filterByRange(sessionList() ?? [], range()))
  const metrics = createMemo(() => computeMetrics(filteredSessions()))
  const activity = createMemo(() => activityByDay(sessionList() ?? [], 365))
  const comparisonLine = createMemo(() => comparison(metrics().tokens))
  const [messageCount] = createResource(
    () => {
      const ids = filteredSessions()
        .slice(0, 30)
        .map((session) => session.id)
      return ids.length ? { url: serverUrl(), ids } : undefined
    },
    async (source) => {
      const client = createClient(source.url)
      const counts = await Promise.all(
        source.ids.map(async (id) => {
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
    for (const message of messages()?.data ?? []) {
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
    setSelected(id)
    if (history()[historyIndex()] === id) return
    const next = history().slice(0, historyIndex() + 1)
    next.push(id)
    setHistory(next)
    setHistoryIndex(next.length - 1)
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault()
        toggleSidebar()
      }
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  const updateDisplayName = (value: string) => {
    setDisplayName(value)
    writeStorage(STORAGE_KEYS.displayName, value)
  }

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
    }
    apply()
    media.addEventListener("change", apply)
    onCleanup(() => media.removeEventListener("change", apply))
  })

  const commitServer = () => {
    const next = serverInput().trim()
    if (!next) return
    setServerUrl(next)
    writeStorage(STORAGE_KEYS.serverUrl, next)
  }

  const refresh = () => {
    void refetchSessions()
  }

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path)
    toast(t("Path copied"), "success")
  }

  const currentTags = () => tags()[selected() ?? ""] ?? []

  const addTag = (value: string) => {
    const sessionID = selected()
    if (!sessionID) return
    const next = { ...tags(), [sessionID]: [...(tags()[sessionID] ?? []), value] }
    setTags(next)
    writeStorage(STORAGE_KEYS.sessionTags, next)
  }

  const removeTag = (value: string) => {
    const sessionID = selected()
    if (!sessionID) return
    const next = { ...tags(), [sessionID]: (tags()[sessionID] ?? []).filter((entry) => entry !== value) }
    setTags(next)
    writeStorage(STORAGE_KEYS.sessionTags, next)
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
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random()}`

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
    persistRoutines([
      ...routines(),
      { id: newId(), ...input, enabled: true, createdAt: Date.now() },
    ])
    toast(t("Routine created"), "success")
  }

  const toggleRoutine = (id: string) => {
    persistRoutines(routines().map((routine) => (routine.id === id ? { ...routine, enabled: !routine.enabled } : routine)))
  }

  const removeRoutine = (id: string) => {
    persistRoutines(routines().filter((routine) => routine.id !== id))
  }

  const markRoutineRun = (id: string) => {
    persistRoutines(
      routines().map((routine) => (routine.id === id ? { ...routine, lastRunAt: Date.now() } : routine)),
    )
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

  const run = async (
    action: (current: Client) => Promise<string | undefined>,
    successMessage?: string,
  ) => {
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

  const newSession = (directory?: string) =>
    run(async (current) => {
      const model = selectedModel()
      const location = directory ?? targetDirectory()
      const session = await current.session.create({
        agent: agent(),
        ...(model ? { model } : {}),
        ...(location ? { location: { directory: location } } : {}),
      })
      await current.session.setPermission({
        sessionID: session.id,
        permission: permissionMode(permissionModeId()).rules,
        directory: location,
      })
      return session.id
    }, t("Session created"))

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
      return undefined
    }, t("Provider removed"))

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
    const lastUser = [...(messages()?.data ?? [])].reverse().find((message) => message.type === "user")
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
    for (const message of messages()?.data ?? []) {
      if (message.type === "user") {
        lines.push("## User", "", (message as { text?: string }).text ?? "", "")
        continue
      }
      if (message.type !== "assistant") continue
      for (const part of message.content) {
        if (part.type === "text") lines.push(part.text, "")
        else if (part.type === "reasoning") lines.push("<details><summary>Reasoning</summary>", "", part.text, "", "</details>", "")
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

  const send = () => {
    const text = prompt().trim()
    const files = attachments()
    if (!text && files.length === 0) return

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
      const sessionID =
        selected() ??
        (
          await current.session.create({
            agent: agent(),
            ...(model ? { model } : {}),
            ...(location ? { location: { directory: location } } : {}),
          })
        ).id
      await current.session.setPermission({
        sessionID,
        permission: permissionMode(permissionModeId()).rules,
        directory: location ?? selectedSession()?.location?.directory,
      })
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

  return (
    <div
      class="fc-app"
      style={{
        "--fc-content-left": collapsed() ? "0px" : `${sidebarWidth()}px`,
        "--fc-content-right": `${(panels().length > 0 ? workspaceWidth() : 0) + (selectedSession() ? 300 : 0)}px`,
      }}
    >
      <Sidebar
        collapsed={collapsed()}
        width={sidebarWidth()}
        displayName={displayName()}
        sessions={sessionList()}
        sessionsLoading={sessions.loading}
        selectedSession={selected()}
        pinnedSessions={pinned()}
        expandedProjects={expanded()}
        onDisplayName={updateDisplayName}
        onToggleSessionPin={togglePin}
        onToggleProject={toggleProject}
        onNewSession={newSession}
        onSelectSession={selectSession}
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
      <main class="fc-main">
        <Topbar
          serverInput={serverInput()}
          healthLoading={health.loading}
          healthHealthy={health()?.healthy === true}
          healthError={!!health.error}
          canGoBack={canGoBack()}
          canGoForward={canGoForward()}
          onBack={goBack}
          onForward={goForward}
          onToggleSidebar={toggleSidebar}
          onRefreshServer={commitServer}
          onServerInput={setServerInput}
          onOpenPalette={() => setPaletteOpen(true)}
          workspace={panels()}
          onTogglePanel={togglePanel}
        />
        <Show when={selectedSession()}>
          {(session) => (
            <SessionToolbar
              session={session()}
              projects={projects()}
              busy={busy()}
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
              tags={currentTags()}
              onAddTag={addTag}
              onRemoveTag={removeTag}
            />
          )}
        </Show>
        <SubagentList sessions={children()?.data} onOpen={selectSession} />
        <Show
          when={selected()}
          fallback={
            <HomeCanvas
              displayName={displayName()}
              range={range()}
              metrics={metrics()}
              messages={messageCount()}
              activity={activity()}
              comparison={comparisonLine()}
              error={error()}
              onRangeChange={setRange}
              onAction={(value) => setPrompt(value)}
            />
          }
        >
          <SessionView
            messages={messages()?.data}
            loading={messages.loading}
            busy={generating()}
            usage={liveUsage()}
            startedAt={generationStartedAt()}
            modelName={modelName}
            showTools={showTools()}
            onEditUser={editMessage}
          />
        </Show>
        <div class="fc-docks">
          <For each={permissions()?.data ?? []}>
            {(request) => (
              <PermissionDock
                request={request}
                busy={busy()}
                onReply={(reply) => replyPermission(request, reply)}
              />
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
        <Composer
          value={prompt()}
          sending={busy()}
          modelLabel={modelLabel()}
          variants={variants()}
          variantKey={variantKey()}
          attachments={attachments()}
          commands={commandOptions()}
          projects={projects()}
          targetDirectory={targetDirectory()}
          agents={agents()?.data ?? []}
          agent={agent()}
          permissionMode={permissionModeId()}
          onInput={setPrompt}
          onSend={send}
          onCommandPick={(name) => setPrompt(`/${name} `)}
          onOpenModelPicker={() => setModelPickerOpen(true)}
          onVariantChange={changeVariant}
          onAttach={addAttachments}
          onRemoveAttachment={removeAttachment}
          searchFiles={searchFiles}
          onPasteText={collapsePaste}
          onStash={() => stashPrompt(prompt(), true)}
          onTargetChange={setTargetDirectory}
          onAgentChange={changeAgent}
          onPermissionModeChange={changePermissionMode}
        />
      </main>
      <WorkspacePanels
        panels={panels()}
        serverUrl={serverUrl()}
        session={selectedSession()}
        width={workspaceWidth()}
        onResize={updateWorkspaceWidth}
        onClose={closePanel}
      />
      <Show when={selectedSession()}>
        {(session) => (
          <RightAside session={session()} models={modelList()} todos={todos()} />
        )}
      </Show>
      <Toaster />
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
        busy={busy()}
        onSave={saveProvider}
        onRemove={removeProvider}
        onClose={() => setProvidersOpen(false)}
      />
      <ModelPicker
        open={modelPickerOpen()}
        models={modelList()}
        selectedKey={modelKey()}
        favorites={favorites()}
        onSelect={pickModel}
        onToggleFavorite={toggleFavoriteModel}
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
        models={modelList()}
        modelKey={modelKey()}
        showTools={showTools()}
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
      <Onboarding open={!onboarded()} serverHealthy={health()?.healthy} onDone={completeOnboarding} />
      <RemotePanel
        open={remoteOpen()}
        initialUrl={serverUrl()}
        onClose={() => setRemoteOpen(false)}
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
