import { createEffect, createMemo, onCleanup, untrack } from "solid-js"
import { createClient } from "../../client"
import { t } from "../../i18n"
import { applyTranscriptChange } from "../../transcript"
import { pendingPrompts } from "../../pending-prompts"
import { publishSessionEvent } from "../../session-events"
import { createV2Transcript } from "../../engine/v2-events"
import type { AppStores } from "../../app-context"

/**
 * Following the engine (V2-21): its one event stream, applied to the sessions, the transcript and the
 * lists that hang off them, and the resync that covers what a stream cannot replay.
 */
export function createEngineEvents(app: AppStores) {
  const notify = (title: string, body: string) => {
    if (!app.settings.notifications()) return
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
      if (wantSessions) void app.sessions.refetchSessions()
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
    void app.sessions.refetchMessages()
    void app.workspace.refetchVcsInfo()
    void app.workspace.refetchVcsStatus()
  }
  let reconcileWhenIdle = false
  const scheduleTranscriptReconcile = () => {
    // Mid-turn the store is already following along; wait for the end rather than re-reading it all.
    if (app.sessions.runState()[app.sessions.selected() ?? ""] === true) {
      reconcileWhenIdle = true
      return
    }
    reconcileTranscript()
  }
  const turnEnded = (sessionID: string) => {
    // Reconcile on every turn end, not only when a refetch was asked for mid-turn: a run whose
    // folder no stream is following is seen only by the poll, and this is the refetch that turns
    // its finished answer into something the reader can see.
    if (sessionID !== app.sessions.selected()) return
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
    const sessions = untrack(app.sessions.sessionList)
    const [v2Result, ...legacyResults] = await Promise.all([
      engine.session.active().catch(() => undefined),
      ...directories.map((directory) => engine.session.status({ directory }).catch(() => undefined)),
    ])
    const v2 = v2Result ?? new Set<string>()
    const legacy = new Set(legacyResults.flatMap((set) => (set ? [...set] : [])))
    // Each result answers the folder at the same index, so the folder a run was found in is known
    // even when the session list does not carry the session — which is exactly when it is needed.
    const legacyDirectories = new Map<string, string>()
    legacyResults.forEach((set, index) => {
      const directory = directories[index]
      if (!set || !directory) return
      for (const id of set) {
        legacyDirectories.set(id, directory)
        app.sessions.rememberDirectory(id, directory)
      }
    })
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
      Object.entries(app.sessions.runState())
        .filter(([id, isRunning]) => isRunning && known.has(id) && !running.has(id))
        .forEach(([id]) => app.sessions.setRunning(id, false))
    running.forEach((id) => {
      app.sessions.setRunning(id, true)
      // A legacy run in a folder this window cannot name is left to its idle event: without the
      // folder there is no status map to ask, and clearing it on the v2 set alone would be a lie.
      // The folder the run was found in counts, even when the session list does not carry it.
      const directory = legacyDirectories.get(id) ?? app.sessions.sessionDirectory(id)
      if (v2.has(id) || directory) app.sessions.watchRun(id, 2000, directory)
    })
  }

  createEffect(() => {
    if (!app.connection.ready()) return
    const url = app.connection.serverUrl()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    void (async () => {
      for (let attempt = 0; !controller.signal.aborted; attempt++) {
        app.sessions.setStreamState(attempt === 0 ? "connecting" : "reconnecting")
        // Reconnecting means the socket was lost, and an engine that came back under a new process
        // may carry a new configuration: ask the cached lists again. A restart the health poll did
        // not catch still lands here.
        if (attempt > 0) app.connection.setServerReload((count) => count + 1)
        // Neither line can replay what this stream missed (2.x calls its stream volatile by
        // contract, and 1.x has no Last-Event-ID), so every connection resyncs the state the events
        // would have carried. Missing the blocked ones is the worst of it — an agent stuck on a
        // permission with no dock to answer it. Untracked: this effect owns the global stream, and
        // re-running it on every change of the session list or the open session would drop and
        // reopen that stream for no reason.
        const resync = () => {
          void untrack(() => resyncRuns(createClient(url), runDirectories())).catch(() => undefined)
          void app.sessions.refetchPermissions()
          void app.sessions.refetchQuestions()
          void app.sessions.refetchBlocked()
        }
        // A reconnection waits for the new stream's first event (`server.connected` on both lines):
        // asked before the stream was open, whatever happened between the answers and the opening
        // was lost for good.
        let synced = attempt === 0
        if (synced) resync()
        try {
          // A 2.x engine streams the transcript here instead of on each folder's stream (V2-21). What
          // it holds is only good for this connection: after a gap the resync starts over.
          const v2Transcript = createV2Transcript()
          for await (const event of createClient(url).event.subscribe({ signal: controller.signal })) {
            attempt = 0
            app.sessions.setStreamState("live")
            if (!synced) {
              synced = true
              resync()
              scheduleRefetch(true, true)
              publishSessionEvent({ kind: "changed" })
            }
            const type = event.type ?? ""
            const payload = (event as { data?: { sessionID?: string; delta?: string } }).data
            app.sessions.trackActivity(
              type,
              payload as
                | { sessionID?: string; status?: { type?: string; message?: string; attempt?: number } }
                | undefined,
            )
            // A prompt queued, steered or cancelled from anywhere: the open session's inbox is reread.
            if (type.startsWith("session.inbox.") && type !== "session.inbox.delivered" && payload?.sessionID) {
              if (type === "session.inbox.cancelled")
                pendingPrompts.remove((payload as { inboxID?: string }).inboxID ?? "")
              if (payload.sessionID === app.sessions.selected()) void app.sessions.readInbox(payload.sessionID)
            }
            if (payload?.sessionID && type.startsWith("session.compaction."))
              app.sessions.fold(
                payload.sessionID,
                type === "session.compaction.started" || type === "session.compaction.delta",
              )
            if (payload?.sessionID && type.startsWith("session.execution.") && type !== "session.execution.started")
              app.sessions.fold(payload.sessionID, false)
            const v2 = v2Transcript.reduce(event)
            if (v2) {
              if (type === "session.execution.started") {
                publishSessionEvent({ kind: "turn", sessionID: v2.sessionID })
                if (v2.sessionID === app.sessions.selected()) app.sessions.setStreamedChars(0)
              }
              if (v2.apply) {
                const change = { apply: v2.apply, chars: v2.chars, delta: v2.delta }
                publishSessionEvent({ kind: "message", sessionID: v2.sessionID, ...change })
                if (v2.sessionID === app.sessions.selected()) {
                  app.sessions.setStreamedChars((value) => value + v2.chars)
                  applyTranscriptChange(app.sessions.setMessageData, change)
                }
              }
              if (v2.stale) scheduleRefetch(true, false)
              // The end of a turn reconciles against the engine's own copy.
              const ended = type.startsWith("session.execution.") && type !== "session.execution.started"
              if (ended || type === "session.revert.committed") scheduleRefetch(true, true)
              continue
            }
            // The engine rebuilds its catalog from models.dev on its own schedule (and when an
            // integration connects). The list it serves moves with it, so the picker must not keep
            // offering the snapshot taken when the page loaded.
            // 2.x reads a folder's branch in the background and says when it is known.
            if (type === "vcs.branch.updated") {
              void app.workspace.refetchVcsInfo()
              continue
            }
            // An MCP server's status, tools or resources moved: 2.x says so for each (V2-23), 1.x only
            // for tools.
            if (type.startsWith("mcp.")) {
              void app.catalog.refetchMcp()
              if (type === "mcp.resources.changed") void app.catalog.refetchMcpResources()
              continue
            }
            // 2.x splits the same news across models, providers and its models.dev refresh.
            if (
              type === "catalog.updated" ||
              type === "model.updated" ||
              type === "provider.updated" ||
              type === "models-dev.refreshed"
            ) {
              void app.catalog.refetchModels()
              continue
            }
            // 2.x asks its questions as forms (`form.*`).
            const question = type.startsWith("form.")
            if (type.startsWith("permission.") || question) {
              app.sessions.setActivityTick((value) => value + 1)
              publishSessionEvent({ kind: "requests" })
            }
            if (type.startsWith("permission.")) {
              if (type === "permission.asked") notify(t("Permission needed"), "")
              void app.sessions.refetchPermissions()
              void app.sessions.refetchBlocked()
            } else if (question) {
              if (type === "form.created") notify(t("Question asked"), "")
              void app.sessions.refetchQuestions()
              void app.sessions.refetchBlocked()
            } else if (type.startsWith("session.")) {
              scheduleRefetch(false, true)
            }
          }
        } catch {
          if (controller.signal.aborted) return
        }
        if (controller.signal.aborted) return
        // A stream that dropped before saying a word still came back from a gap: resync anyway, or
        // a connection that keeps failing that way would never catch up.
        if (!synced) {
          resync()
          scheduleRefetch(true, true)
          publishSessionEvent({ kind: "changed" })
        }
        app.sessions.setStreamState("reconnecting")
        await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
      }
    })()
  })

  /**
   * Folders whose runs the resync asks about: what is on screen first, then the code project and
   * the chats. Every event, transcript included, arrives on the one global stream (V2-21); 1.x's
   * per-folder streams are gone (TI-12).
   */
  const WATCHED_DIRECTORIES = 2
  const watchedDirectories = () => {
    const list = app.sessions.sessionList()
    const directoryOf = (id: string | undefined) =>
      id
        ? (list?.find((session) => session.id === id)?.location?.directory ?? app.sessions.sessionDirectories.get(id))
        : undefined
    const open = [app.sessions.selected(), ...(app.sessions.splitActive() ? app.sessions.splitPanes() : [])].map(
      directoryOf,
    )
    // What is on screen first: the conversation being read is the one that needs its stream. The
    // folders behind it (the code project, the chats) come after, so a chat in a project the app
    // is not browsing still streams instead of being dropped by the budget below.
    const directories = [...open, app.connection.chatsDirectory(), app.sessions.targetDirectory()].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    return [...new Set(directories)].slice(0, WATCHED_DIRECTORIES)
  }

  /** Every folder a loaded session lives in, plus the folders followed live. */
  const runDirectories = () => [
    ...new Set([
      ...watchedDirectories(),
      ...(app.sessions.sessionList() ?? []).flatMap((session) => session.location?.directory ?? []),
    ]),
  ]
  // A string so a refetched-but-equal list does not re-seed the run state on every turn's refetch.
  const listedDirectories = createMemo(() =>
    [...new Set((app.sessions.sessionList() ?? []).flatMap((session) => session.location?.directory ?? []))]
      .sort()
      .join("\n"),
  )
  // The list arrives after the global stream connects, and a legacy run started in another window
  // has no event here; re-seed once the folders the list knows about are in.
  createEffect(() => {
    const directories = listedDirectories()
    if (!directories || !app.connection.ready()) return
    void resyncRuns(createClient(app.connection.serverUrl()), directories.split("\n")).catch(() => undefined)
  })

  return {
    turnEnded,
  }
}

export type EngineEventsStore = ReturnType<typeof createEngineEvents>
