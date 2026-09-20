import { createResource, createSignal, type Component } from "solid-js"
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

  const client = () => createClient(serverUrl())
  const [health] = createResource(serverUrl, (url) => createClient(url).health.get())
  const [projects, { refetch: refetchProjects }] = createResource(serverUrl, (url) =>
    createClient(url).project.list(),
  )
  const [sessions, { refetch: refetchSessions }] = createResource(serverUrl, (url) =>
    createClient(url).session.list(),
  )

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
      const session = await current.session.create(directory ? { location: { directory } } : {})
      return session.id
    })

  const send = () => {
    const text = prompt().trim()
    if (!text) return
    void run(async (current) => {
      const sessionID = selected() ?? (await current.session.create({})).id
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
        <Composer value={prompt()} sending={busy()} onInput={setPrompt} onSend={send} />
      </main>
    </div>
  )
}
