import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, type Component } from "solid-js"
import type { PermissionV2Request, QuestionV2Request } from "@opencode-ai/client"
import { createClient, resolveServerUrl } from "./client"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"
import { activityByDay, comparison, computeMetrics, filterByRange, type UsageRange } from "./metrics"
import type { Attachment, CommandOption, McpConfig, Routine, SessionTags, StashedPrompt } from "./types"
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
import { TodoDock } from "./components/TodoDock"
import { McpManager } from "./components/McpManager"
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
  const [error, setError] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal(readStorage(STORAGE_KEYS.sidebarCollapsed, false))
  const [pinned, setPinned] = createSignal(readStorage<string[]>(STORAGE_KEYS.pinnedProjects, []))
  const [displayName, setDisplayName] = createSignal(readStorage(STORAGE_KEYS.displayName, ""))
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [auto, setAuto] = createSignal(true)
  const [modelRef, setModelRef] = createSignal<{ providerID: string; id: string; variant?: string }>()
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [aboutOpen, setAboutOpen] = createSignal(false)
  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [showTools, setShowTools] = createSignal(true)
  const [mcpOpen, setMcpOpen] = createSignal(false)
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [routinesOpen, setRoutinesOpen] = createSignal(false)
  const [remoteOpen, setRemoteOpen] = createSignal(false)
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
  const [health] = createResource(serverUrl, (url) => createClient(url).health.get())
  const [projects, { refetch: refetchProjects }] = createResource(serverUrl, (url) =>
    createClient(url).project.list(),
  )
  const [sessions, { refetch: refetchSessions }] = createResource(serverUrl, (url) =>
    createClient(url).session.list(),
  )
  const [models] = createResource(serverUrl, (url) => createClient(url).model.list())
  const [defaultModel] = createResource(serverUrl, (url) => createClient(url).model.default())
  const [agents] = createResource(serverUrl, (url) => createClient(url).agent.list())
  const [skills] = createResource(serverUrl, (url) => createClient(url).skill.list())
  const [mcp, { refetch: refetchMcp }] = createResource(serverUrl, (url) => createClient(url).mcp.list())
  const [commands] = createResource(serverUrl, (url) => createClient(url).command.list())
  const [permissions, { refetch: refetchPermissions }] = createResource(serverUrl, (url) =>
    createClient(url).permission.request.list(),
  )
  const [questions, { refetch: refetchQuestions }] = createResource(serverUrl, (url) =>
    createClient(url).question.request.list(),
  )
  const [messages, { refetch: refetchMessages }] = createResource(
    () => {
      const sessionID = selected()
      return sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    (source) => createClient(source.url).message.list({ sessionID: source.sessionID, order: "asc" }),
  )
  const [children] = createResource(
    () => {
      const sessionID = selected()
      return sessionID ? { url: serverUrl(), sessionID } : undefined
    },
    (source) => createClient(source.url).session.list({ parentID: source.sessionID }),
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
          if (event.type.startsWith("permission.")) {
            if (event.type === "permission.v2.asked") notify(t("Permission needed"), "")
            void refetchPermissions()
          } else if (event.type.startsWith("question.")) {
            if (event.type === "question.v2.asked") notify(t("Question asked"), "")
            void refetchQuestions()
          } else if (event.type.startsWith("message.")) void refetchMessages()
          else if (event.type.startsWith("session.")) void refetchSessions()
        }
      } catch {
        return
      }
    })()
  })

  const selectedModel = () => (auto() ? undefined : modelRef())
  const modelKey = () => {
    const ref = selectedModel()
    return ref ? `${ref.providerID}/${ref.id}` : undefined
  }
  const currentModel = () => {
    const ref = modelRef()
    if (!ref) return
    return models()?.data?.find((model) => model.providerID === ref.providerID && model.modelID === ref.id)
  }
  const variants = () => (auto() ? [] : (currentModel()?.variants ?? []))
  const variantKey = () => (auto() ? undefined : modelRef()?.variant)

  createEffect(() => {
    if (modelRef()) return
    const fallback = defaultModel()?.data ?? models()?.data?.find((model) => model.enabled) ?? models()?.data?.[0]
    if (!fallback) return
    setModelRef({ providerID: fallback.providerID, id: fallback.modelID })
  })

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

  const sessionList = () => sessions()?.data
  const selectedSession = () => sessionList()?.find((session) => session.id === selected())

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
        if (part.type !== "tool" || part.state.status === "streaming") continue
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
    writeStorage(STORAGE_KEYS.pinnedProjects, next)
  }

  const toggleSidebar = () => {
    const next = !collapsed()
    setCollapsed(next)
    writeStorage(STORAGE_KEYS.sidebarCollapsed, next)
  }

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
    void refetchProjects()
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
        ...(model ? { model } : {}),
        ...(location ? { location: { directory: location } } : {}),
      })
      return session.id
    }, t("Session created"))

  const replyPermission = (request: PermissionV2Request, reply: PermissionReply) =>
    run(async (current) => {
      await current.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply })
      void refetchPermissions()
      return undefined
    })

  const replyQuestion = (request: QuestionV2Request, answers: string[][]) =>
    run(async (current) => {
      await current.question.reply({ sessionID: request.sessionID, requestID: request.id, answers })
      void refetchQuestions()
      return undefined
    })

  const rejectQuestion = (request: QuestionV2Request) =>
    run(async (current) => {
      await current.question.reject({ sessionID: request.sessionID, requestID: request.id })
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

  const renameSession = () => {
    const sessionID = selected()
    if (!sessionID) return
    const currentTitle = sessionList()?.find((session) => session.id === sessionID)?.title ?? ""
    const title = window.prompt(t("New title"), currentTitle)
    if (!title) return
    void run(async (current) => {
      await current.session.rename({ sessionID, title })
      return undefined
    }, t("Session renamed"))
  }

  const moveSession = (directory: string) => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.move({ sessionID, directory })
      return undefined
    }, t("Session moved"))
  }

  const deleteSession = () => {
    const sessionID = selected()
    if (!sessionID) return
    if (!window.confirm(t("Delete this session?"))) return
    void (async () => {
      setBusy(true)
      try {
        await createClient(serverUrl()).session.remove({ sessionID })
        setSelected(undefined)
        toast(t("Session deleted"), "success")
        void refetchSessions()
      } catch (cause) {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
      } finally {
        setBusy(false)
      }
    })()
  }

  const changeAgent = (agent: string) => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.switchAgent({ sessionID, agent })
      return undefined
    })
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
            ...(model ? { model } : {}),
            ...(location ? { location: { directory: location } } : {}),
          })
        ).id
      await current.session.prompt({
        sessionID,
        text: expandPastes(text),
        ...(files.length > 0 ? { files: files.map(({ uri, name }) => ({ uri, name })) } : {}),
      })
      setPrompt("")
      setAttachments([])
      return sessionID
    }, t("Message sent"))
  }

  return (
    <div class="fc-app">
      <Sidebar
        collapsed={collapsed()}
        displayName={displayName()}
        projects={projects()}
        projectsLoading={projects.loading}
        pinned={pinned()}
        sessions={sessionList()}
        sessionsLoading={sessions.loading}
        selectedSession={selected()}
        onDisplayName={updateDisplayName}
        onTogglePin={togglePin}
        onNewSession={newSession}
        onSelectSession={selectSession}
        onRefresh={refresh}
        onAbout={() => setAboutOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onRoutines={() => setRoutinesOpen(true)}
        onArtifacts={() => setArtifactsOpen(true)}
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
        />
        <Show when={selectedSession()}>
          {(session) => (
            <SessionToolbar
              session={session()}
              agents={agents()?.data ?? []}
              projects={projects() ?? []}
              busy={busy()}
              reverting={!!session().revert}
              onFork={forkSession}
              onCompact={compactSession}
              onRename={renameSession}
              onExport={exportMarkdown}
              onMove={moveSession}
              onDelete={deleteSession}
              onAgentChange={changeAgent}
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
            />
          }
        >
          <SessionView
            messages={messages()?.data}
            loading={messages.loading}
            busy={busy()}
            showTools={showTools()}
            onEditUser={editMessage}
          />
        </Show>
        <div class="fc-docks">
          <TodoDock todos={todos()} />
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
          models={models()?.data ?? []}
          modelKey={modelKey()}
          variants={variants()}
          variantKey={variantKey()}
          auto={auto()}
          attachments={attachments()}
          commands={commandOptions()}
          projects={projects() ?? []}
          targetDirectory={targetDirectory()}
          onInput={setPrompt}
          onSend={send}
          onCommandPick={(name) => setPrompt(`/${name} `)}
          onModelChange={changeModel}
          onVariantChange={changeVariant}
          onToggleAuto={() => setAuto((value) => !value)}
          onAttach={addAttachments}
          onRemoveAttachment={removeAttachment}
          searchFiles={searchFiles}
          onPasteText={collapsePaste}
          onStash={() => stashPrompt(prompt(), true)}
          onTargetChange={setTargetDirectory}
        />
      </main>
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
      />
      <About open={aboutOpen()} onClose={() => setAboutOpen(false)} />
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
        models={models()?.data ?? []}
        modelKey={modelKey()}
        auto={auto()}
        showTools={showTools()}
        notifications={notifications()}
        paletteKey={paletteKey()}
        onTheme={updateTheme}
        onLocale={setLocale}
        onDisplayName={updateDisplayName}
        onServerInput={setServerInput}
        onServerCommit={commitServer}
        onModelChange={changeModel}
        onToggleAuto={() => setAuto((value) => !value)}
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
      <RemotePanel open={remoteOpen()} initialUrl={serverUrl()} onClose={() => setRemoteOpen(false)} />
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
      <ConfigPanel open={configOpen()} serverUrl={serverUrl()} onClose={() => setConfigOpen(false)} />
    </div>
  )
}
