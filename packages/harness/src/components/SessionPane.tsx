import { For, Show, batch, createEffect, createSignal, onCleanup, type Component } from "solid-js"
import { createResource } from "../resource"
import type {
  AgentInfo,
  FileSystemEntry,
  ModelInfo,
  PermissionV2Request,
  QuestionV2Request,
  SessionInfo,
  SessionMessageAssistant,
} from "../engine-types"
import type { Attachment, ProjectItem } from "../types"
import { createClient, invalidateLegacyHistory } from "../client"
import { CHAT_SYSTEM } from "../chat"
import { permissionMode } from "../permission-modes"
import { recordPrompt } from "../prompt-history"
import { subscribeSessionEvents } from "../session-events"
import { t } from "../i18n"
import { toast } from "../toast"
import { Composer } from "./Composer"
import { PermissionDock, type PermissionReply } from "./PermissionDock"
import { QuestionDock } from "./QuestionDock"
import { SessionView } from "./SessionView"

type SessionPaneProps = {
  session: SessionInfo
  serverUrl: string
  focused: boolean
  /** The engine is working on this session (from the app's run state). */
  running: boolean
  chat: boolean
  chatsDirectory: string | undefined
  showTools: boolean
  models: ModelInfo[]
  /** The app's current model, for sessions that have not stored their own. */
  defaultModel: { providerID: string; id: string; variant?: string } | undefined
  favorites: string[]
  agents: AgentInfo[]
  agent: string
  permissionModeId: string
  projects: ProjectItem[]
  history: string[]
  modelName: (ref: { providerID: string; id: string }) => string
  searchFiles: (query: string) => Promise<FileSystemEntry[]>
  collapsePaste: (raw: string) => string
  expandPastes: (value: string) => string
  readFiles: (files: File[]) => Promise<Attachment[]>
  onFocus: () => void
  onClose: () => void
  onOpenModelPicker: () => void
  onAgentChange: (agent: string) => void
  onPermissionModeChange: (id: string) => void
}

/**
 * One session in split view: its transcript, live stream, requests and input, independent of the app's
 * selected session so several can run and be prompted side by side.
 */
export const SessionPane: Component<SessionPaneProps> = (props) => {
  const sessionID = () => props.session.id
  const client = () => createClient(props.serverUrl)
  const [draft, setDraft] = createSignal("")
  const [attachments, setAttachments] = createSignal<Attachment[]>([])
  const [busy, setBusy] = createSignal(false)
  const [liveText, setLiveText] = createSignal("")
  const [liveReasoning, setLiveReasoning] = createSignal("")
  const [streamedChars, setStreamedChars] = createSignal(0)
  const [chosenModel, setModelRef] = createSignal(props.session.model)
  const modelRef = () => chosenModel() ?? props.defaultModel

  const [messages, { refetch: refetchMessages }] = createResource(
    () => ({ url: props.serverUrl, sessionID: sessionID() }),
    async (source) => {
      const result = await createClient(source.url).message.list({ sessionID: source.sessionID, order: "asc" })
      return { sessionID: source.sessionID, data: result.data }
    },
  )
  const [permissions, { refetch: refetchPermissions }] = createResource(
    () => ({ url: props.serverUrl, sessionID: sessionID() }),
    (source) => createClient(source.url).session.permission.list({ sessionID: source.sessionID }),
  )
  const [questions, { refetch: refetchQuestions }] = createResource(
    () => ({ url: props.serverUrl, sessionID: sessionID() }),
    (source) => createClient(source.url).session.question.list({ sessionID: source.sessionID }),
  )
  const list = () => {
    const value = messages()
    return value && value.sessionID === sessionID() ? value.data : undefined
  }

  let refetchTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleRefetch = () => {
    if (refetchTimer) return
    refetchTimer = setTimeout(() => {
      refetchTimer = undefined
      void refetchMessages()
    }, 300)
  }
  onCleanup(() => clearTimeout(refetchTimer))

  const unsubscribe = subscribeSessionEvents((event) => {
    if (event.kind === "requests") {
      void refetchPermissions()
      void refetchQuestions()
      return
    }
    if (event.kind === "changed") {
      if (event.sessionID && event.sessionID !== sessionID()) return
      if (event.sessionID) invalidateLegacyHistory(event.sessionID)
      scheduleRefetch()
      return
    }
    if (event.sessionID !== sessionID()) return
    if (event.kind === "turn") {
      batch(() => {
        setLiveText("")
        setLiveReasoning("")
        setStreamedChars(0)
      })
      scheduleRefetch()
      return
    }
    setStreamedChars((value) => value + event.delta.length)
    if (event.field === "reasoning") setLiveReasoning((value) => value + event.delta)
    else setLiveText((value) => value + event.delta)
  })
  onCleanup(unsubscribe)

  // Drop the streamed copy once the fetched transcript has caught up with it.
  createEffect(() => {
    const last = [...(list() ?? [])].reverse().find((message) => message.type === "assistant") as
      | SessionMessageAssistant
      | undefined
    if (!last) return
    const text = last.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    const reasoning = last.content.flatMap((part) => (part.type === "reasoning" ? [part.text] : [])).join("")
    if (liveText() && text.includes(liveText())) setLiveText("")
    if (liveReasoning() && reasoning.includes(liveReasoning())) setLiveReasoning("")
  })

  const generating = () => {
    if (busy() || props.running) return true
    const messages = list() ?? []
    const last = messages[messages.length - 1]
    if (!last) return false
    if (last.type === "user") return true
    if (last.type !== "assistant") return false
    const time = (last as { time?: { completed?: number } }).time
    return time !== undefined && time.completed === undefined
  }

  const currentModel = () => {
    const ref = modelRef()
    return ref ? props.models.find((model) => model.providerID === ref.providerID && model.id === ref.id) : undefined
  }
  const variants = () => currentModel()?.variants ?? []
  /** The model with its effort level only when this project's engine offers that level. */
  const validModel = () => {
    const ref = modelRef()
    if (!ref?.variant || variants().some((variant) => variant.id === ref.variant)) return ref
    return { providerID: ref.providerID, id: ref.id }
  }
  const lastAssistant = () =>
    [...(list() ?? [])].reverse().find((message) => message.type === "assistant") as SessionMessageAssistant | undefined
  const usage = () => {
    const tokens = lastAssistant()?.tokens
    return {
      used: tokens ? tokens.input + (tokens.cache?.read ?? 0) : props.session.tokens.input,
      limit: currentModel()?.limit?.context ?? 0,
      cost: props.session.cost,
      tokens: tokens ? { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning } : undefined,
    }
  }
  const liveUsage = () => {
    const assistant = lastAssistant()
    const messages = list() ?? []
    if (assistant && messages[messages.length - 1] === assistant && assistant.tokens) {
      return { tokens: assistant.tokens, cost: assistant.cost }
    }
    const chars = streamedChars()
    return chars > 0 ? { tokens: { input: 0, output: Math.ceil(chars / 4), reasoning: 0 }, cost: undefined } : undefined
  }
  const startedAt = () => {
    const messages = list() ?? []
    const last = messages[messages.length - 1]
    return (last as { time?: { created?: number } } | undefined)?.time?.created
  }

  const switchModel = (next: { providerID: string; id: string; variant?: string }) => {
    setModelRef(next)
    void client()
      .session.switchModel({ sessionID: sessionID(), model: next })
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"))
  }

  const send = async () => {
    const text = draft().trim()
    const files = attachments()
    if ((!text && files.length === 0) || busy()) return
    recordPrompt(text)
    setBusy(true)
    try {
      const current = client()
      const body = props.expandPastes(text)
      const fileRefs = files.map(({ uri, name }) => ({ uri, name }))
      if (props.chat && props.chatsDirectory) {
        await current.session.chat({
          sessionID: sessionID(),
          directory: props.chatsDirectory,
          text: body,
          system: CHAT_SYSTEM,
          files: fileRefs,
          ...(validModel() ? { model: validModel()! } : {}),
        })
      } else {
        await current.session.setPermission({
          sessionID: sessionID(),
          permission: permissionMode(props.permissionModeId).rules,
          directory: props.session.location?.directory,
        })
        await current.session.prompt({
          sessionID: sessionID(),
          text: body,
          ...(fileRefs.length > 0 ? { files: fileRefs } : {}),
        })
      }
      batch(() => {
        setDraft("")
        setAttachments([])
        setStreamedChars(0)
      })
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      setBusy(false)
      scheduleRefetch()
    }
  }

  const stop = () => {
    const current = client()
    const request =
      props.chat && props.chatsDirectory
        ? current.session.abort({ sessionID: sessionID(), directory: props.chatsDirectory })
        : current.session.interrupt({ sessionID: sessionID() })
    void request.catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"))
  }

  // Editing a prompt rewinds the session to it, like in the single view, and puts it in this pane's input.
  const editUser = (messageID: string, text: string) => {
    setDraft(text)
    void client()
      .session.revert.stage({ sessionID: sessionID(), messageID, files: true })
      .then(() => refetchMessages())
      .catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"))
  }

  const replyPermission = (request: PermissionV2Request, reply: PermissionReply) =>
    void client()
      .session.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply })
      .then(() => refetchPermissions())
  const replyQuestion = (request: QuestionV2Request, answers: string[][]) =>
    void client()
      .session.question.reply({ sessionID: request.sessionID, requestID: request.id, answers })
      .then(() => refetchQuestions())
  const rejectQuestion = (request: QuestionV2Request) =>
    void client()
      .session.question.reject({ sessionID: request.sessionID, requestID: request.id })
      .then(() => refetchQuestions())

  const project = () =>
    props.chat ? t("Chat") : props.session.location?.directory?.split("/").filter(Boolean).at(-1)

  return (
    <section
      class="fc-pane"
      classList={{ "fc-pane-focused": props.focused }}
      aria-label={props.session.title}
      onPointerDown={() => {
        if (!props.focused) props.onFocus()
      }}
      onFocusIn={() => {
        if (!props.focused) props.onFocus()
      }}
    >
      <header class="fc-pane-header">
        <span
          class="fc-session-dot"
          classList={{ "fc-session-dot-running": generating() }}
          aria-hidden="true"
        />
        <span class="fc-pane-title" title={props.session.title}>
          {props.session.title || t("New session")}
        </span>
        <Show when={project()}>{(name) => <span class="fc-pane-badge">{name()}</span>}</Show>
        <button
          class="fc-nav-arrow fc-pane-close"
          type="button"
          title={t("Close pane")}
          aria-label={t("Close pane")}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={props.onClose}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </header>

      <SessionView
        messages={list()}
        loading={messages.loading && !list()}
        busy={generating()}
        usage={liveUsage()}
        startedAt={startedAt()}
        modelName={props.modelName}
        liveText={liveText()}
        liveReasoning={liveReasoning()}
        showTools={props.showTools}
        chat={props.chat}
        onEditUser={editUser}
      />

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

      <Composer
        mode={props.chat ? "chat" : "code"}
        inactive={!props.focused}
        value={draft()}
        sending={busy()}
        generating={generating()}
        onStop={stop}
        models={props.models}
        modelKey={modelRef() ? `${modelRef()!.providerID}/${modelRef()!.id}` : undefined}
        favorites={props.favorites}
        onModelChange={(providerID, id) => switchModel({ providerID, id })}
        modelLabel={currentModel()?.name ?? t("Default model")}
        variants={variants()}
        variantKey={validModel()?.variant}
        usage={usage()}
        attachments={attachments()}
        commands={[]}
        projects={props.projects}
        targetDirectory={props.session.location?.directory}
        agents={props.agents}
        agent={props.agent}
        permissionMode={props.permissionModeId}
        history={props.history}
        onInput={setDraft}
        onSend={() => void send()}
        onCommandPick={() => undefined}
        onOpenModelPicker={props.onOpenModelPicker}
        onVariantChange={(value) => {
          const ref = modelRef()
          if (ref) switchModel({ providerID: ref.providerID, id: ref.id, variant: value || undefined })
        }}
        onAttach={(files) => void props.readFiles(files).then((items) => setAttachments((list) => [...list, ...items]))}
        onRemoveAttachment={(uri) => setAttachments((list) => list.filter((item) => item.uri !== uri))}
        searchFiles={props.searchFiles}
        onPasteText={props.collapsePaste}
        onStash={() => undefined}
        onTargetChange={() => undefined}
        onOpenFolder={() => undefined}
        onAgentChange={props.onAgentChange}
        onPermissionModeChange={props.onPermissionModeChange}
      />
    </section>
  )
}
