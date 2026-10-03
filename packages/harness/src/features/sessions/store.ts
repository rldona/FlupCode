import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { createResource } from "../../resource"
import { createReconciledList } from "../../reconciled"
import { downloadFile, sessionJson, sessionMarkdown, type ExportMessage, type ExportOptions } from "../../export"
import type {
  PermissionV2Request,
  QuestionV2Request,
  SessionMessageAssistant,
  SessionMessageInfo,
} from "../../engine-types"
import { adaptiveSurfaces, createClient, createHarnessClient, isSessionGone } from "../../client"
import { STORAGE_KEYS, readStorage, writeStorage } from "../../storage"
import { sessionAttention, worstAttention } from "../../attention"
import { activityDays } from "../../metrics"
import { periodStart } from "../../cost"
import { isSuggestionSession } from "../../reply-suggestion"
import { sessionChatClass, type AppView, type ChatClass } from "../../chat"
import { messageID } from "../../ids"
import { sessionTitle } from "../../session-title"
import { pendingPrompts } from "../../pending-prompts"
import { questionSessions as findQuestionSessions, type PendingRequest } from "../../pending-questions"
import { runOutcome, type RunOutcome } from "../../run-outcome"
import type { SessionInfo } from "../../engine-types"
import type { ProjectItem, Run, SessionPrefs } from "../../types"
import { t } from "../../i18n"
import { clearToast, toast } from "../../toast"
import { NO_FOLDER_GROUP, sessionGroupKey } from "../../components/Sidebar"
import type { PermissionReply } from "../../components/PermissionDock"
import { guardrailFor, type GuardrailReading } from "../../components/GuardrailBanner"
import { desktopRemote, remote, touchDevice } from "../../remote"
import type { RemoteSessionItem } from "../../components/RemoteHome"
import { closePane, keepExisting, openInSplit, showInFocusedPane } from "../../split"
import { closeTab, cycleTab, keepTabs, openTab, tabAfterClose } from "../../tabs"
import type { AppStores } from "../../app-context"

type Client = ReturnType<typeof createClient>

export function createSessions(app: AppStores) {
  const [selected, setSelected] = createSignal<string | undefined>(
    // Phones controlling a computer always start on the sessions home, not the last open session.
    touchDevice && !desktopRemote() && remote.activeHost()
      ? undefined
      : readStorage<string>(STORAGE_KEYS.selectedSession, "") || undefined,
  )
  const [busy, setBusy] = createSignal(false)
  // A fold this app asked for is in flight. The engine's own folds are read from the transcript,
  // but this app answers the request directly, so the transcript does not show it yet.
  // Sessions the engine is folding right now, from its `session.compaction.*` events: an automatic
  // compaction starts on its own, between steps of a turn.
  const [folding, setFolding] = createSignal<ReadonlySet<string>>(new Set())
  const fold = (sessionID: string, active: boolean) =>
    setFolding((current) => {
      if (current.has(sessionID) === active) return current
      const next = new Set(current)
      if (active) next.add(sessionID)
      if (!active) next.delete(sessionID)
      return next
    })
  const [streamedChars, setStreamedChars] = createSignal(0)
  const [error, setError] = createSignal<string>()
  const [mobileComposing, setMobileComposing] = createSignal(false)
  // Run state from the event stream; it takes precedence over the last activity snapshot.
  const [runState, setRunState] = createSignal<Record<string, boolean>>({})
  // Why a session is stalled while the engine retries a failed provider call, kept per session so
  // the status line can say "Usage limit exceeded" instead of thinking on forever.
  const [retryState, setRetryState] = createSignal<Record<string, { message: string; attempt: number }>>({})
  // How a 2.x execution ended when that is worth telling (V2-40): a failure the transcript may not
  // carry (one before any answer), or a stop the reader did not ask for. Cleared when the next starts.
  const [runOutcomes, setRunOutcomes] = createSignal<Record<string, RunOutcome>>({})
  /**
   * "Finished unseen" for sessions (UX-02): the ones this window saw finish a turn while they were
   * not on screen, until the reader opens them. The engine keeps no read state, so a session that
   * finished while the app was closed is not marked: guessing it from `time.updated`, which a rename
   * moves too, would claim something nobody checked (P4). Kept on this device across reloads.
   */
  const [unseenSessions, setUnseenSessions] = createSignal<string[]>(
    readStorage<string[]>(STORAGE_KEYS.unseenSessions, []),
  )
  createEffect(() => writeStorage(STORAGE_KEYS.unseenSessions, unseenSessions()))
  const sessionInView = (sessionID: string) =>
    selected() === sessionID && !app.router.screen() && document.visibilityState === "visible"
  const [activityTick, setActivityTick] = createSignal(0)
  // Whether the engine's event stream is carrying this session's run right now. The health check
  // is a separate question: it can answer while the stream is a dead socket nobody noticed.
  const [streamState, setStreamState] = createSignal<"connecting" | "live" | "reconnecting">("connecting")
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * The folder every session was last seen in. The session list is one page and a session opened from
   * the palette, from a routine or in another window may not be on it: without a folder there is no
   * status map to poll and no stream to follow, so a run that lost its `session.idle` stayed working
   * forever and the composer stayed on Stop until a reload. Remembering the folder is what keeps that
   * session pollable, so it is fed from every source that learns one and never dropped.
   */
  const sessionDirectories = new Map<string, string>()
  const rememberDirectory = (sessionID: string | undefined, directory: string | undefined) => {
    if (sessionID && directory) sessionDirectories.set(sessionID, directory)
  }
  const setRunning = (sessionID: string, running: boolean) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.delete(sessionID)
    const wasRunning = runState()[sessionID] === true
    setRunState((state) => (state[sessionID] === running ? state : { ...state, [sessionID]: running }))
    if (!wasRunning || running) return
    // A turn ending is the moment the transcript is worth reconciling against the engine, and the only one.
    app.events.turnEnded(sessionID)
    // Only a listed session: a reply suggestion's throwaway turn is nothing the reader could open.
    const listed = sessionList()?.some((session) => session.id === sessionID)
    if (listed && !sessionInView(sessionID))
      setUnseenSessions((ids) => (ids.includes(sessionID) ? ids : [...ids, sessionID]))
  }
  // A session's inbox, read again whenever it moves: the prompts waiting there are the engine's.
  const readInbox = (sessionID: string) =>
    createClient(app.connection.serverUrl())
      .session.inbox.list({ sessionID })
      .then((prompts) => pendingPrompts.adopt(sessionID, prompts))
      .catch(() => undefined)
  // A new message starts a new run: until its first event arrives, the transcript decides.
  const forgetRun = (sessionID: string) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.delete(sessionID)
    setRunState(({ [sessionID]: _, ...rest }) => rest)
    setRetryState(({ [sessionID]: _dropped, ...rest }) => rest)
    setRunOutcomes(({ [sessionID]: _outcome, ...rest }) => rest)
  }
  // A v2 run is many steps, and the next one only starts once the model streams again, so a step's end
  // says nothing about the run; nor does anything arrive when a run is stopped between steps. While a
  // run goes on, ask the engine whether it still lists the session as active. A legacy turn — every
  // Code and Chat turn — never appears there, only in its folder's status map, so both are asked: a
  // lost `session.idle` otherwise leaves the status line spinning over a turn that already ended.
  const watchRun = (sessionID: string, delay: number, knownDirectory?: string) => {
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.set(
      sessionID,
      setTimeout(async () => {
        const engine = createClient(app.connection.serverUrl())
        // The folder the run was found in outranks the list: a session the list does not carry — one
        // opened from the palette, or a routine/worktree run outside the page — has no directory to
        // look up, and without it this poll has no status map to ask and never clears the run.
        const directory = knownDirectory ?? sessionDirectory(sessionID)
        const [active, status] = await Promise.all([
          engine.session.active().catch(() => undefined),
          directory ? engine.session.status({ directory }).catch(() => undefined) : undefined,
        ])
        if (!idleTimers.has(sessionID)) return
        // A poll nobody answered says nothing. Clearing the run on a missing answer would end the
        // status line because the engine was briefly unreachable, which is the very thing this poll
        // exists to prevent, so keep the run and ask again.
        if (active === undefined && status === undefined) return watchRun(sessionID, 2000, knownDirectory)
        if (active?.has(sessionID) !== true && status?.has(sessionID) !== true) return setRunning(sessionID, false)
        setRunState((state) => (state[sessionID] ? state : { ...state, [sessionID]: true }))
        watchRun(sessionID, 2000, knownDirectory)
      }, delay),
    )
  }
  const trackActivity = (
    type: string,
    data:
      | {
          sessionID?: string
          status?: { type?: string; message?: string; attempt?: number }
          error?: { message?: string }
          reason?: string
        }
      | undefined,
  ) => {
    const sessionID = data?.sessionID
    if (!sessionID) return
    const outcome = runOutcome(type, data)
    if (type === "session.execution.started" || outcome)
      setRunOutcomes(({ [sessionID]: _previous, ...rest }) => (outcome ? { ...rest, [sessionID]: outcome } : rest))
    if (type === "session.execution.started") {
      setRunState((state) => (state[sessionID] ? state : { ...state, [sessionID]: true }))
      return watchRun(sessionID, 2000)
    }
    // 2.x says when a whole execution is over, every step and queued prompt included.
    if (type.startsWith("session.execution.")) return setRunning(sessionID, false)
    // `session.status` reports busy, retry and idle, which already spans every step.
    const status = data?.status?.type
    if (status === "busy" || status === "retry") {
      setRunning(sessionID, true)
      // The turn's end arrives as `session.idle`; when that is lost, this poll notices.
      const directory = sessionDirectory(sessionID)
      if (directory) watchRun(sessionID, 2000, directory)
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
  const [history, setHistory] = createSignal<string[]>([])
  const [historyIndex, setHistoryIndex] = createSignal(-1)
  const [noFolderSessions, setNoFolderSessions] = createSignal<string[]>(
    readStorage<string[]>(STORAGE_KEYS.noFolderSessions, []),
  )
  const [targetDirectory, setTargetDirectory] = createSignal<string>()
  // Every session is loaded in one go, walking the engine's cursor to the end. There used to be a
  // "Load more" button that fetched one page at a time, but rebuilding the list when it was pressed
  // dropped the reader's selected session. `SESSION_PAGE` is now only the batch size per request.
  const SESSION_PAGE = 80
  const [sessions, { refetch: refetchSessions }] = createResource(
    () => (app.connection.ready() ? app.connection.serverUrl() : undefined),
    async (url) => {
      const client = createClient(url)
      const data: SessionInfo[] = []
      let cursor: string | undefined
      for (;;) {
        const response = await client.session.list({ limit: SESSION_PAGE, cursor })
        data.push(...(response.data ?? []))
        cursor = response.cursor?.next ?? undefined
        // A short page is the end of the list: asking again would only get less.
        if ((response.data?.length ?? 0) < SESSION_PAGE || !cursor) break
      }
      return { data }
    },
  )
  // Server-side session search (H-18), for the palette: it reaches sessions the page above never
  // loaded. The title is what the engine matches; the palette still searches folders too.
  const searchSessions = (query: string) =>
    createClient(app.connection.serverUrl())
      .session.list({ search: query, limit: 50 })
      .then((response) => response.data ?? [])
      .then((found) => {
        // The palette reaches sessions the loaded page never had. Their folder is learnt here or
        // nowhere: opening one from here is how a session ends up selected but unlisted.
        found.forEach((session) => rememberDirectory(session.id, session.location?.directory))
        return found
      })
      .catch(() => [] as SessionInfo[])
  // Reply suggestions run in throwaway child sessions that are never shown.
  const sessionList = () => sessions()?.data?.filter((session) => !isSuggestionSession(session))
  // Every page of the list is a chance to learn where a session lives, and the next page may drop it.
  createEffect(() =>
    (sessionList() ?? []).forEach((session) => rememberDirectory(session.id, session.location?.directory)),
  )
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
  type ClassifiedSession = { agent?: string; location?: { directory?: string } }
  // A chat-class session is one of the two conversations in the chat tab: a plain chat, which lives
  // in the engine's state folder, or a Cowork chat, which runs in the project under its reserved
  // agent. Everything else is a code session. See chat.ts and ADR-0013.
  const chatClass = (session: ClassifiedSession | undefined): ChatClass | undefined =>
    session ? sessionChatClass(session, app.connection.chatsDirectory()) : undefined
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
  const composerChatClass = (): ChatClass | undefined => (chatView() ? (selectedChatClass() ?? chatMode()) : undefined)
  const plainChatView = () => chatView() && composerChatClass() === "chat"
  // The Code chrome Cowork earns: repo bar, workspace panels, details panel.
  const codeChrome = () => !plainChatView()
  const changeChatClass = (next: ChatClass) => {
    setChatMode(next)
    writeStorage(STORAGE_KEYS.chatMode, next)
    if (!selected() || selectedChatClass() === next) return
    // Leaving a conversation of the other class goes to this class's home, keeping the draft.
    const sessionID = selected()
    if (sessionID && !messagesLoading() && (activeMessages() ?? []).length === 0) {
      void createClient(app.connection.serverUrl())
        .session.remove({ sessionID })
        .then(() => refetchSessions())
        .catch(() => undefined)
    }
    setSelected(undefined)
    setMobileComposing(false)
  }
  // Sessions the engine forked for a subagent live in the details panel, under the parent they
  // belong to; as rows in this column they read as projects of their own.
  const viewSessions = () => sessionList()?.filter((session) => isChatLike(session) === chatView() && !session.parentID)
  const changeView = (next: AppView) => {
    app.router.leaveScreen()
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
    if (!app.connection.chatsDirectory()) return
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
    if (!session || !app.connection.chatsDirectory()) return
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
    if (!next || next === untrack(app.composer.agent)) return
    app.composer.setAgent(next)
  })
  const modelLocation = () => targetDirectory() ?? selectedSession()?.location?.directory
  /** The message the transcript scrolls to once the session it belongs to is open (RP-03). */
  const [revealMessage, setRevealMessage] = createSignal<string>()

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

  createEffect(() => {
    const url = app.connection.harnessServerUrl()
    if (!app.runs.routinesServerAvailable() || !url) return
    if (app.connection.supports("session-prefs")) {
      void createHarnessClient(url)
        .sessionPrefs.list()
        .then((list) => {
          const map: Record<string, SessionPrefs> = {}
          for (const prefs of list) map[prefs.sessionID] = prefs
          setSessionPrefs(map)
        })
        .catch(() => undefined)
    }
    if (app.connection.supports("stash")) {
      void createHarnessClient(url)
        .stash.list()
        .then(app.composer.setStashes)
        .catch(() => undefined)
    }
    if (app.connection.supports("packs")) {
      const directory = vcsDirectory()
      void createHarnessClient(url)
        .packs.list(directory ?? undefined)
        .then(app.composer.setPacks)
        .catch(() => undefined)
    }
  })
  // The reload counter is part of the key so a reload asks for both lists again; the fetcher reads
  // the URL off the same key.
  const vcsDirectory = () => targetDirectory() ?? selectedSession()?.location?.directory

  // A string, not an object. The session list is refetched all through a turn and hands back fresh
  // objects every time, so a source built out of `selectedSession()` changed identity on each one
  // and both lists were asked again. Measured against a running turn: 93 requests for permissions
  // and questions in thirty seconds, for events nobody had raised.
  const blockedSource = () => {
    const sessionID = selected()
    if (!app.connection.ready() || !sessionID) return undefined
    return `${app.connection.serverUrl()}\n${sessionID}`
  }
  const blockedTarget = (key: string) => {
    const [url = "", sessionID = ""] = key.split("\n")
    return { url, sessionID }
  }
  const [permissions, { refetch: refetchPermissions }] = createResource(blockedSource, async (key) => {
    const source = blockedTarget(key)
    return {
      data: await createClient(source.url)
        .session.permission.list({ sessionID: source.sessionID })
        .then(
          (result) => result.data ?? [],
          () => [],
        ),
    }
  })
  const [questions, { refetch: refetchQuestions }] = createResource(blockedSource, async (key) => {
    const source = blockedTarget(key)
    return {
      data: await createClient(source.url)
        .session.question.list({ sessionID: source.sessionID })
        .then(
          (result) => result.data ?? [],
          () => [],
        ),
    }
  })
  // Every session's pending permissions and questions, not just the open one's. An agent waiting on
  // either is silent and looks idle, so without this the reader has no way to know another session
  // is stuck. 2.x lists its questions apart from its permissions (as forms), so both are asked.
  const [blocked, { refetch: refetchBlocked }] = createResource(
    () => (app.connection.ready() ? app.connection.serverUrl() : undefined),
    async (url) => {
      const engine = createClient(url)
      const [data, questions] = await Promise.all([
        engine.permission.pending().then(
          (result) => result.data ?? [],
          () => [],
        ),
        engine.question.pending().then(
          (result) => result.data ?? [],
          () => [],
        ),
      ])
      return { data, questions }
    },
  )
  const blockedSessions = () => [...new Set((blocked()?.data ?? []).map((request) => request.sessionID))]
  const blockedElsewhere = () => blockedSessions().filter((id) => id !== selected())
  /** Sessions with a question to answer, told apart from plain blocked ones (QH-1). */
  const questionSessions = () =>
    findQuestionSessions((blocked()?.questions ?? []).filter((request) => !request.browser) as PendingRequest[])
  // A browser approval (BU-01) reaches the app as a form, but it asks for leave, not for an answer.
  const approvalSessions = () => [
    ...new Set([
      ...blockedSessions(),
      ...(blocked()?.questions ?? []).filter((request) => request.browser).map((request) => request.sessionID),
    ]),
  ]
  // Opening a session is seeing it; so is coming back to the window it is open in.
  const seeOpenSession = () => {
    const id = selected()
    if (!id || !sessionInView(id)) return
    setUnseenSessions((ids) => (ids.includes(id) ? ids.filter((entry) => entry !== id) : ids))
  }
  createEffect(seeOpenSession)
  document.addEventListener("visibilitychange", seeOpenSession)
  onCleanup(() => document.removeEventListener("visibilitychange", seeOpenSession))
  const sessionAttentionOf = (sessionID: string) =>
    sessionAttention({
      approval: approvalSessions().includes(sessionID),
      answer: questionSessions().includes(sessionID),
      running: runState()[sessionID] === true,
      failed: runOutcomes()[sessionID]?.kind === "failed",
      unseen: unseenSessions().includes(sessionID),
    })
  const sessionsAttention = createMemo(() =>
    Object.fromEntries(
      (sessionList() ?? []).flatMap((session) => {
        const level = sessionAttentionOf(session.id)
        return level ? [[session.id, level] as const] : []
      }),
    ),
  )

  const [messages, { refetch: refetchMessages }] = createResource(
    () => {
      const sessionID = selected()
      return app.connection.ready() && sessionID ? { url: app.connection.serverUrl(), sessionID } : undefined
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
  // The live guardrail advisory (FH-062, ADR-0023; AH-E03). There is no guardrail event, so the
  // read-only `status` route is polled, but only while the open session is generating and the tab is
  // visible: an idle session or a hidden tab costs nothing. Every reading is stamped with the session
  // it was asked for, and one that lands after the session changed is dropped, so a warning never
  // shows in another session. The dismissal is per `decisionID` and in memory only; a new loop — a
  // new id — arms it again, and switching sessions forgets it.
  const [guardrailReading, setGuardrailReading] = createSignal<GuardrailReading>()
  const [guardrailDismissed, setGuardrailDismissed] = createSignal<string>()
  const [pageVisible, setPageVisible] = createSignal(document.visibilityState === "visible")
  const onVisibilityChange = () => setPageVisible(document.visibilityState === "visible")
  document.addEventListener("visibilitychange", onVisibilityChange)
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibilityChange))
  const liveGuardrail = () => guardrailFor(guardrailReading(), selected(), guardrailDismissed())
  createEffect(() => {
    selected()
    setGuardrailReading(undefined)
    setGuardrailDismissed(undefined)
  })
  createEffect(() => {
    const url = app.connection.harnessServerUrl()
    const sessionID = selected()
    if (!url || !sessionID || !adaptiveSurfaces(app.connection.harnessCapabilities()).guardrails) return
    // A finished turn has no live loop left to warn about.
    if (!generating()) {
      setGuardrailReading(undefined)
      return
    }
    if (!pageVisible()) return
    const state = { live: true }
    const read = () =>
      createHarnessClient(url)
        .adaptive.guardrails.status(sessionID)
        .then((status) => {
          if (!state.live || untrack(selected) !== sessionID) return
          setGuardrailReading(status ? { sessionID, status } : undefined)
        })
        .catch(() => undefined)
    void read()
    const timer = setInterval(read, 5000)
    onCleanup(() => {
      state.live = false
      clearInterval(timer)
    })
  })
  /**
   * Whether the session is being folded right now, as the engine said: a manual compaction or one it
   * started on its own. Without it the status line reads like any other answer.
   */
  const compacting = () => folding().has(selected() ?? "")

  const liveUsage = () => {
    const list = activeMessages() ?? []
    const last = list[list.length - 1]
    if (last?.type === "assistant") {
      const assistant = last as SessionMessageAssistant
      if (assistant.tokens) return { tokens: assistant.tokens }
    }
    const chars = streamedChars()
    if (chars <= 0) return undefined
    return { tokens: { input: 0, output: Math.ceil(chars / 4), reasoning: 0 } }
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
      return app.connection.ready() && sessionID ? { url: app.connection.serverUrl(), sessionID } : undefined
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

  // Subagents the reader removed from the details panel, per session. The children belong to the
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

  // Prompts shown before the engine projects their message, reconciled by id once it does. The ones
  // sent while a turn was already running offer "Send now".
  const pendingForSession = () =>
    pendingPrompts.forSession(selected(), activeMessages() ?? [], app.connection.serverUrl())

  // Once a real message replaces its optimistic prompt, forget it so the list cannot grow.
  createEffect(() => pendingPrompts.reconcile(new Set((activeMessages() ?? []).map((message) => message.id))))
  // What the open session's inbox holds on 2.x (V2-41): queued prompts outlive a reload there.
  createEffect(() => {
    const sessionID = selected()
    if (!sessionID || !app.connection.ready()) return
    void readInbox(sessionID)
  })

  createEffect(() => {
    selected()
    setStreamedChars(0)
  })

  createEffect(() => {
    writeStorage(STORAGE_KEYS.selectedSession, selected() ?? "")
  })

  createEffect(() => {
    writeStorage(STORAGE_KEYS.noFolderSessions, noFolderSessions())
  })

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

  const [remoteActivity] = createResource(
    () =>
      app.settings.mobileRemote() && app.connection.ready()
        ? JSON.stringify({
            url: app.connection.serverUrl(),
            directories: projects().map((project) => project.directory),
            tick: activityTick(),
          })
        : undefined,
    async (key) => {
      const input = JSON.parse(key) as { url: string; directories: string[] }
      const engine = createClient(input.url)
      // OpenCode 2 reports the running sessions of every folder at once; what waits and the branch
      // are still asked per folder.
      const [busy, lists] = await Promise.all([
        engine.session.active().catch(() => new Set<string>()),
        Promise.all(
          input.directories.map(async (directory) => {
            const [pending, vcs] = await Promise.all([
              engine.permission.pending({ location: { directory } }).then(
                (result) => result.data,
                () => [],
              ),
              engine.vcs.get(directory).catch(() => undefined),
            ])
            return { directory, waiting: pending.map((request) => request.sessionID), branch: vcs?.branch }
          }),
        ),
      ])
      return {
        busy,
        waiting: new Set(lists.flatMap((list) => list.waiting)),
        branches: Object.fromEntries(lists.map((list) => [list.directory, list.branch])),
      }
    },
  )

  const remoteSessions = createMemo((): RemoteSessionItem[] => {
    if (!app.settings.mobileRemote()) return []
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
          // The desk's scale (UX-02), with what the phone's own per-folder poll adds.
          attention: worstAttention([
            activity?.waiting.has(session.id) && "approval",
            sessionAttentionOf(session.id),
            running && "running",
          ]),
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
    app.composer.setPrompt("")
  }
  const onPopState = () => {
    if (app.settings.mobileRemote() && mobileScreen() === "session") leaveMobileSession()
  }
  window.addEventListener("popstate", onPopState)
  onCleanup(() => window.removeEventListener("popstate", onPopState))

  // The home card (UL-09). What the period spent, in tokens and money and by model, is the usage
  // ledger's, read the way the Cost screen reads it, so the two agree; the sessions, days and streak
  // are the engine's own stats. Read while the home is on screen, and again when a session starts or
  // a turn ends. `range` is a number of days, or all of them.
  const [range, setRange] = createSignal<number>()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  // A string, so a list that changed without adding a session or ending a turn reads nothing again.
  const homeKey = () => {
    if (!app.connection.ready() || selected() || app.settings.mobileRemote() || chatView()) return undefined
    return `${sessionList()?.length ?? 0}:${activeSessions().length}`
  }
  const periodFrom = (days: number) => (days ? periodStart(days, Date.now()) : undefined)
  const [homeUsage] = createResource(
    () => {
      const key = homeKey()
      if (!key || !app.runs.routinesServerAvailable()) return undefined
      return [app.connection.harnessServerUrl(), range() ?? 0, key].join("\n")
    },
    (key) => {
      const [harness = "", days = "0"] = key.split("\n")
      return createHarnessClient(harness).usageSummary({ groupBy: "model", from: periodFrom(Number(days)) })
    },
  )
  const [homeStats] = createResource(
    () => homeKey() && [app.connection.serverUrl(), range() ?? 0, homeKey()].join("\n"),
    (key) => {
      const [engine = "", days = "0"] = key.split("\n")
      return createClient(engine).session.stats({ from: periodFrom(Number(days)), timezone })
    },
  )
  // The heatmap is always the last year, whatever the period.
  const [yearStats] = createResource(
    () => homeKey() && [app.connection.serverUrl(), homeKey()].join("\n"),
    (key) => createClient(key.split("\n")[0] ?? "").session.stats({ from: periodStart(365, Date.now()), timezone }),
  )
  const activity = createMemo(() => activityDays(yearStats()?.activity ?? [], 365, Date.now()))

  const canGoBack = () => historyIndex() > 0
  const canGoForward = () => historyIndex() >= 0 && historyIndex() < history().length - 1

  const selectSession = (id: string) => {
    app.router.leaveScreen()
    if (app.settings.narrow()) app.settings.setCollapsed(true)
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
  const splitActive = () => splitPanes().length >= 2 && !app.settings.mobileRemote() && !app.settings.narrow()
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
    void createHarnessClient(app.connection.harnessServerUrl())
      .sessionPrefs.update(id, { pinned })
      .then(applyPrefs)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const setTags = (id: string, tags: string[]) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .sessionPrefs.update(id, { tags })
      .then(applyPrefs)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const editTags = (id: string) => {
    const session = sessionList()?.find((entry) => entry.id === id)
    app.router.setTagsTarget({
      id,
      title: session ? sessionTitle(session) : t("Session"),
      tags: prefsFor(id)?.tags ?? [],
    })
  }

  const toggleProject = (id: string) => {
    // Negate the effective state, not just the stored one: a group holding the selected session
    // reads as open without stored state, and toggling from the stored default would keep it open.
    const stored = expanded()[id]
    const selected = selectedSession()
    const effective = stored ?? (selected ? sessionGroupKey(selected, noFolderSessions()) === id : false)
    const next = { ...expanded(), [id]: !effective }
    setExpanded(next)
    writeStorage(STORAGE_KEYS.expandedProjects, next)
  }

  const refresh = () => {
    void refetchSessions()
  }

  const copyPath = (path: string) => {
    void navigator.clipboard?.writeText(path)
    toast(t("Path copied"), "success")
  }

  const run = async (action: (current: Client) => Promise<string | undefined>, successMessage?: string) => {
    setBusy(true)
    setError(undefined)
    try {
      const id = await action(app.connection.client())
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
    app.router.leaveScreen()
    const sessionID = selected()
    if (sessionID && !messagesLoading() && (activeMessages() ?? []).length === 0) {
      void createClient(app.connection.serverUrl())
        .session.remove({ sessionID })
        .then(() => refetchSessions())
        .catch(() => undefined)
    }
    setTargetDirectory(directory)
    setSelected(undefined)
    app.composer.setPrompt("")
    app.composer.setAttachments([])
  }

  const sessionDirectory = (sessionID: string) =>
    sessionList()?.find((session) => session.id === sessionID)?.location?.directory ?? sessionDirectories.get(sessionID)

  const replyPermission = (request: PermissionV2Request, reply: PermissionReply, message?: string) =>
    run(async (current) => {
      await current.session.permission.reply({ sessionID: request.sessionID, requestID: request.id, reply, message })
      void refetchPermissions()
      void refetchBlocked()
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
    void run(async (current) => {
      await current.session.abort({ sessionID, directory: sessionDirectory(sessionID) })
      return undefined
    })
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
    const model = app.composer.selectedModel() ?? selectedSession()?.model
    if (!model) {
      toast(t("Choose a model"), "info")
      return
    }
    void run(async (current) => {
      const sessionID =
        selected() ?? (await current.session.create({ model: { providerID: model.providerID, id: model.id } })).id
      fold(sessionID, true)
      try {
        await current.session.compact({
          sessionID,
          directory: selectedSession()?.location?.directory,
          providerID: model.providerID,
          modelID: model.id,
        })
      } finally {
        fold(sessionID, false)
      }
      void refetchMessages()
      return sessionID
    }, t("Session compacted"))
  }

  const renameSession = (id?: string) => {
    const sessionID = id ?? selected()
    if (!sessionID) return
    const currentTitle = sessionTitle(sessionList()?.find((session) => session.id === sessionID))
    app.router.setRenameTarget({ id: sessionID, title: currentTitle })
  }

  const commitRename = (title: string) => {
    const target = app.router.renameTarget()
    if (!target) return
    app.router.setRenameTarget(undefined)
    void run(async (current) => {
      await current.session.rename({ sessionID: target.id, title })
      return undefined
    })
  }

  // Archiving is the engine's own `time.archived` (H-18): the session stays, it just leaves the
  // list. Bringing it back is the same call with zero.
  const deleteProject = (groupId: string) => {
    const sessions = (sessionList() ?? []).filter((session) => sessionGroupKey(session, noFolderSessions()) === groupId)
    if (sessions.length === 0) return
    const name = groupId === NO_FOLDER_GROUP ? t("No folder") : (groupId.split("/").filter(Boolean).at(-1) ?? groupId)
    app.router.setConfirmTarget({
      title: t("Delete this project and its sessions?"),
      message: t("{n} sessions will be removed. This cannot be undone.", { n: sessions.length }),
      onConfirm: () => {
        app.router.setConfirmTarget(undefined)
        void (async () => {
          setBusy(true)
          try {
            const current = createClient(app.connection.serverUrl())
            for (const session of sessions) await current.session.remove({ sessionID: session.id })
            if (sessions.some((session) => session.id === selected())) setSelected(undefined)
            void refetchSessions()
            toast(t("Project deleted"), "success", {
              description: t("{name} and its sessions were removed", { name }),
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
    app.router.setConfirmTarget({
      title: t("Delete this session?"),
      message: t("It will be removed from the engine and cannot be restored."),
      onConfirm: () => {
        app.router.setConfirmTarget(undefined)
        void (async () => {
          setBusy(true)
          try {
            await createClient(app.connection.serverUrl()).session.remove({ sessionID })
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

  const editMessage = (messageID: string, text: string) => {
    const sessionID = selected()
    if (!sessionID) return
    app.composer.setPrompt(text)
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
    app.router.setExportOpen(false)
    toast(t("Transcript exported"), "success")
  }
  // The harness's own share (H-35): it keeps the conversation and serves it at a link, so sharing
  // does not depend on the engine's remote host.
  const runShare = (options: ExportOptions) => {
    const sessionID = selected()
    if (!sessionID) return
    const title = sessionTitle(selectedSession()) || sessionID
    const markdown = sessionMarkdown(title, (activeMessages() ?? []) as ExportMessage[], options)
    void createHarnessClient(app.connection.harnessServerUrl())
      .shares.create({ title, markdown })
      .then(async (share) => {
        const url = `${app.connection.harnessServerUrl().replace(/\/$/, "")}${share.url}`
        await navigator.clipboard?.writeText(url).catch(() => undefined)
        toast(t("Share link copied"), "success")
        app.router.setExportOpen(false)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  return {
    activeMessages,
    activeSessions,
    activity,
    applyPrefs,
    approvalSessions,
    blockedElsewhere,
    blockedSessions,
    busy,
    canGoBack,
    canGoForward,
    changeChatClass,
    changeComposerTarget,
    changeTargetDirectory,
    changeView,
    chatClass,
    chatView,
    children,
    clearSubagents,
    closeSessionTab,
    closeSplitPane,
    codeChrome,
    commitRename,
    commitRevert,
    compactSession,
    compacting,
    composerChatClass,
    copyPath,
    cycleSessionTab,
    deleteProject,
    deleteSession,
    editMessage,
    editTags,
    error,
    expanded,
    fold,
    forgetRun,
    forkSession,
    generating,
    generationStartedAt,
    goBack,
    goForward,
    leaveMobileSession,
    lineage,
    liveGuardrail,
    liveUsage,
    messages,
    messagesLoading,
    homeStats,
    homeUsage,
    mobileComposing,
    mobileScreen,
    modelLocation,
    moveSession,
    newSession,
    noFolderSessions,
    openMobileSession,
    openSplit,
    pendingForSession,
    permissionData,
    pinnedSessions,
    plainChatView,
    projects,
    questionData,
    questionSessions,
    range,
    readInbox,
    redo,
    refetchBlocked,
    refetchMessages,
    refetchPermissions,
    refetchQuestions,
    refetchSessions,
    refresh,
    rejectQuestion,
    rememberDirectory,
    remoteSessions,
    renameSession,
    replyPermission,
    replyQuestion,
    retryState,
    revealMessage,
    run,
    runExport,
    runOutcomes,
    runShare,
    runState,
    searchSessions,
    selectSession,
    selected,
    selectedSession,
    sessionDirectories,
    sessionDirectory,
    sessionList,
    sessionTabList,
    sessionTabs,
    sessionTags,
    sessions,
    sessionsAttention,
    setActivityTick,
    setError,
    setGuardrailDismissed,
    setMessageData,
    setNoFolderSessions,
    setRange,
    setRevealMessage,
    setRunning,
    setStreamState,
    setStreamedChars,
    setTags,
    setTargetDirectory,
    splitActive,
    splitPanes,
    startMobileSession,
    stopSession,
    streamState,
    subagents,
    targetDirectory,
    togglePin,
    toggleProject,
    trackActivity,
    undo,
    vcsDirectory,
    view,
    viewActivity,
    viewSessions,
    visibleSubagents,
    watchRun,
  }
}

export type SessionsStore = ReturnType<typeof createSessions>
