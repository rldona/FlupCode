import { createEffect, createResource, createSignal, type Component } from "solid-js"
import { createClient, resolveServerUrl } from "./client"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"
import { Sidebar } from "./components/Sidebar"
import { Topbar } from "./components/Topbar"
import { HomeCanvas } from "./components/HomeCanvas"
import { Composer } from "./components/Composer"

type Client = ReturnType<typeof createClient>

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
  const [modelRef, setModelRef] = createSignal<{ providerID: string; id: string }>()

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

  const selectedModel = () => (auto() ? undefined : modelRef())
  const modelKey = () => {
    const ref = selectedModel()
    return ref ? `${ref.providerID}/${ref.id}` : undefined
  }

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

  const sessionList = () => sessions()?.data
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

  const run = async (action: (current: Client) => Promise<string | undefined>) => {
    setBusy(true)
    setError(undefined)
    try {
      const id = await action(client())
      if (id) selectSession(id)
      void refetchSessions()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const newSession = (directory?: string) =>
    run(async (current) => {
      const model = selectedModel()
      const session = await current.session.create({
        ...(model ? { model } : {}),
        ...(directory ? { location: { directory } } : {}),
      })
      return session.id
    })

  const send = () => {
    const text = prompt().trim()
    if (!text) return
    void run(async (current) => {
      const model = selectedModel()
      const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
      await current.session.prompt({ sessionID, text })
      setPrompt("")
      return sessionID
    })
  }

  return (
    <div class="oh-app">
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
      />
      <main class="oh-main">
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
        />
        <HomeCanvas
          displayName={displayName()}
          sessionCount={sessionList()?.length ?? 0}
          serverVersion={health()?.version}
          selectedSession={selected()}
          busy={busy()}
          error={error()}
        />
        <Composer
          value={prompt()}
          sending={busy()}
          models={models()?.data ?? []}
          modelKey={modelKey()}
          auto={auto()}
          onInput={setPrompt}
          onSend={send}
          onModelChange={changeModel}
          onToggleAuto={() => setAuto((value) => !value)}
        />
      </main>
    </div>
  )
}
