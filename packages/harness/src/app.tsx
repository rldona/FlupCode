import { For, Show, createEffect, createResource, createSignal, onCleanup, type Component } from "solid-js"
import type { PermissionV2Request, QuestionV2Request } from "@opencode-ai/client"
import { createClient, resolveServerUrl } from "./client"
import { STORAGE_KEYS, readStorage, writeStorage } from "./storage"
import type { Attachment, CommandOption } from "./types"
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

type Client = ReturnType<typeof createClient>

const BUILTIN_COMMANDS: CommandOption[] = [
  { name: "new", description: "Nueva sesión" },
  { name: "compact", description: "Compactar la sesión actual" },
  { name: "about", description: "Acerca de OpenHarness" },
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

  const commandOptions = (): CommandOption[] => [
    ...BUILTIN_COMMANDS,
    ...(commands()?.data ?? []).map((command) => ({ name: command.name, description: command.description })),
  ]

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
    setPrompt(`/${name} `)
  }

  createEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key !== "k" && key !== "p") return
      event.preventDefault()
      setPaletteOpen(true)
    }
    document.addEventListener("keydown", handler)
    onCleanup(() => document.removeEventListener("keydown", handler))
  })

  createEffect(() => {
    const url = serverUrl()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void (async () => {
      try {
        for await (const event of createClient(url).event.subscribe({ signal: controller.signal })) {
          if (event.type.startsWith("permission.")) void refetchPermissions()
          else if (event.type.startsWith("question.")) void refetchQuestions()
          else if (event.type.startsWith("message.")) void refetchMessages()
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
      const session = await current.session.create({
        ...(model ? { model } : {}),
        ...(directory ? { location: { directory } } : {}),
      })
      return session.id
    }, "Sesión creada")

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
    }, "Sesión bifurcada")
  }

  const compactSession = () => {
    void run(async (current) => {
      const model = selectedModel()
      const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
      await current.session.compact({ sessionID })
      return sessionID
    }, "Sesión compactada")
  }

  const renameSession = () => {
    const sessionID = selected()
    if (!sessionID) return
    const currentTitle = sessionList()?.find((session) => session.id === sessionID)?.title ?? ""
    const title = window.prompt("Nuevo título", currentTitle)
    if (!title) return
    void run(async (current) => {
      await current.session.rename({ sessionID, title })
      return undefined
    }, "Sesión renombrada")
  }

  const moveSession = (directory: string) => {
    const sessionID = selected()
    if (!sessionID) return
    void run(async (current) => {
      await current.session.move({ sessionID, directory })
      return undefined
    }, "Sesión movida")
  }

  const deleteSession = () => {
    const sessionID = selected()
    if (!sessionID) return
    if (!window.confirm("¿Eliminar esta sesión?")) return
    void (async () => {
      setBusy(true)
      try {
        await createClient(serverUrl()).session.remove({ sessionID })
        setSelected(undefined)
        toast("Sesión eliminada", "success")
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
    toast("Transcripción exportada", "success")
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
        }, "Sesión compactada")
        return
      }
      void run(async (current) => {
        const model = selectedModel()
        const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
        await current.session.command({ sessionID, command: name, ...(args ? { arguments: args } : {}) })
        setPrompt("")
        return sessionID
      }, "Comando ejecutado")
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
      }, "Comando lanzado")
      return
    }

    void run(async (current) => {
      const model = selectedModel()
      const sessionID = selected() ?? (await current.session.create(model ? { model } : {})).id
      await current.session.prompt({
        sessionID,
        text,
        ...(files.length > 0 ? { files: files.map(({ uri, name }) => ({ uri, name })) } : {}),
      })
      setPrompt("")
      setAttachments([])
      return sessionID
    }, "Mensaje enviado")
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
        onAbout={() => setAboutOpen(true)}
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
        <Show when={selectedSession()}>
          {(session) => (
            <SessionToolbar
              session={session()}
              agents={agents()?.data ?? []}
              projects={projects() ?? []}
              busy={busy()}
              onFork={forkSession}
              onCompact={compactSession}
              onRename={renameSession}
              onExport={exportMarkdown}
              onMove={moveSession}
              onDelete={deleteSession}
              onAgentChange={changeAgent}
            />
          )}
        </Show>
        <Show
          when={selected()}
          fallback={
            <HomeCanvas
              displayName={displayName()}
              sessionCount={sessionList()?.length ?? 0}
              serverVersion={health()?.version}
              selectedSession={selected()}
              busy={busy()}
              error={error()}
            />
          }
        >
          <SessionView messages={messages()?.data} loading={messages.loading} busy={busy()} />
        </Show>
        <div class="oh-docks">
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
          onInput={setPrompt}
          onSend={send}
          onCommandPick={(name) => setPrompt(`/${name} `)}
          onModelChange={changeModel}
          onVariantChange={changeVariant}
          onToggleAuto={() => setAuto((value) => !value)}
          onAttach={addAttachments}
          onRemoveAttachment={removeAttachment}
          searchFiles={searchFiles}
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
      <About open={aboutOpen()} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
