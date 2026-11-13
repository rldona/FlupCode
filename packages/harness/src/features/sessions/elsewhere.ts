import { createEffect, createSignal, onCleanup, untrack } from "solid-js"
import { createClient, resolveHarnessServerUrl } from "../../client"
import { desktopRemote, remote, remoteBaseUrl, type LinkStatus } from "../../remote"
import { STORAGE_KEYS, readStorage, writeStorage } from "../../storage"
import { isSuggestionSession } from "../../reply-suggestion"
import type { SessionInfo } from "../../engine-types"
import { t } from "../../i18n"
import { toast } from "../../toast"
import { engineFetch, harnessBrowserToken } from "../../transport"

/**
 * The sessions of the engines this window is not driving (ADR-0029).
 *
 * The window talks to one engine at a time: its own, or the computer it drives. The desktop app
 * still lists every paired computer's sessions, and its own while it drives another, so a session
 * can be opened wherever it lives. Each of those engines is listed through its own address and kept
 * current by its own event stream. The last list seen from each is kept, so a computer that is off
 * still shows its sessions, as unavailable.
 *
 * One repository has a different folder on each computer (`/Users/…/opencode-ui-power` here,
 * `/home/…/FlupCode` there). Each computer names the repository of its folders (`owner/name`, from
 * git), and another computer's session is listed under the folder of the driven engine that holds the
 * same repository, so a project shows once. Without a repository to go by, the folder's name decides.
 */

const LOCAL_ENGINE = "local"

export type SessionComputer = { engine: string; name: string; status: LinkStatus }

type Engine = { id: string; url: string }

/** What each list keeps between launches: enough to draw a row and group it, nothing more. */
type Cached = Pick<SessionInfo, "id" | "title" | "parentID" | "location" | "time"> & Partial<SessionInfo>

// Here rather than in `STORAGE_KEYS`: only the desktop app keeps it, and this module is loaded there
// alone; the startup bundle has no room to spare (ADR-0029).
const REPOSITORIES_KEY = "flupcode.computerRepositories"
const PAGE = 80
const MOST = 400
/** Events that change what a row shows, or whether there is one. */
const LIST_EVENTS = /^session\.(created|updated|deleted|moved|metadata\.updated|execution\.)/

export type Elsewhere = ReturnType<typeof createElsewhere>

export function createElsewhere(input: {
  /** The engine the window drives' own list, once it has loaded: it is cached for when the window drives another. */
  currentSessions: () => SessionInfo[] | undefined
  localUrl: () => string
}) {
  /** The engine the window drives: this machine's, or the host id of the computer it drives. */
  const current = () => remote.activeHost()?.hostId ?? LOCAL_ENGINE
  const [lists, setLists] = createSignal<Record<string, Cached[]>>(
    readStorage<Record<string, Cached[]>>(STORAGE_KEYS.computerSessions, {}),
  )
  const store = (engine: string, sessions: Cached[]) => {
    const next = { ...lists(), [engine]: sessions.slice(0, MOST).map(trim) }
    setLists(next)
    writeStorage(STORAGE_KEYS.computerSessions, next)
  }

  const engines = (): Engine[] => {
    if (!desktopRemote()) return []
    return [
      { id: LOCAL_ENGINE, url: input.localUrl() },
      ...remote.hosts().map((host) => ({ id: host.hostId, url: remoteBaseUrl(host.hostId) })),
    ].filter((engine) => engine.id !== current())
  }

  // The current engine's list is the one the window already loads.
  createEffect(() => {
    const sessions = input.currentSessions()
    if (sessions && desktopRemote()) store(current(), sessions)
  })

  createEffect(() => {
    // A forgotten computer takes its sessions with it.
    const paired = new Set([LOCAL_ENGINE, ...remote.hosts().map((host) => host.hostId)])
    if (Object.keys(lists()).some((engine) => !paired.has(engine)))
      setLists(Object.fromEntries(Object.entries(lists()).filter(([engine]) => paired.has(engine))))
    engines().forEach((engine) =>
      createEffect(() => {
        if (engine.id !== LOCAL_ENGINE && remote.hostStatus(engine.id) !== "online") return
        const controller = new AbortController()
        onCleanup(() => controller.abort())
        void follow(engine, controller.signal, (sessions) => store(engine.id, sessions))
      }),
    )
  })

  // The repository of each engine's folders, null where a folder has none, kept between launches:
  // a checkout rarely changes repository, and a computer that is off still has its sessions placed.
  const [repos, setRepos] = createSignal<Record<string, Record<string, string | null>>>(
    readStorage<Record<string, Record<string, string | null>>>(REPOSITORIES_KEY, {}),
  )
  // Asked once per launch: a computer on an older FlupCode does not answer, and is not asked again.
  const asked = new Set<string>()
  createEffect(() =>
    [current(), ...engines().map((engine) => engine.id)].forEach((engine) =>
      createEffect(() => {
        if (engine !== LOCAL_ENGINE && remote.hostStatus(engine) !== "online") return
        const known = untrack(repos)[engine] ?? {}
        const missing = [...new Set((lists()[engine] ?? []).map((session) => session.location?.directory))].filter(
          (directory): directory is string =>
            !!directory && !(directory in known) && !asked.has(`${engine}\n${directory}`),
        )
        if (missing.length === 0) return
        missing.forEach((directory) => asked.add(`${engine}\n${directory}`))
        void repositories(engine, missing).then((found) => {
          if (!found) return
          const next = { ...repos(), [engine]: { ...repos()[engine], ...found } }
          setRepos(next)
          writeStorage(REPOSITORIES_KEY, next)
        })
      }),
    ),
  )
  const repositories = (engine: string, directories: string[]) => {
    const init = { method: "POST", body: JSON.stringify({ directories }) }
    const token = harnessBrowserToken()
    // This machine's harness directly, even while the window drives another computer; another
    // computer's through its engine address, whose host carries `/harness` to its own harness.
    const answer =
      engine === LOCAL_ENGINE
        ? fetch(`${readStorage(STORAGE_KEYS.harnessServerUrl, resolveHarnessServerUrl())}/harness/git/repositories`, {
            ...init,
            headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
          })
        : engineFetch(`${remoteBaseUrl(engine)}/harness/git/repositories`, {
            ...init,
            headers: { "content-type": "application/json" },
          })
    return answer
      .then((response) => (response.ok ? response.json() : undefined))
      .then((body: { data?: Record<string, string | null> } | undefined) => body?.data)
      .catch(() => undefined)
  }

  const owner = (sessionID: string) => {
    if (!desktopRemote()) return undefined
    return Object.entries(lists()).find(
      ([engine, sessions]) => engine !== current() && sessions.some((session) => session.id === sessionID),
    )?.[0]
  }

  return {
    /** Every other engine's sessions, the reply suggestions' throwaway sessions left out. */
    sessions: (): SessionInfo[] => {
      if (!desktopRemote()) return []
      const driven = input.currentSessions() ?? []
      const here = new Set(driven.map((session) => session.id))
      const ours = [...new Set(driven.map((session) => session.location?.directory).filter((path) => !!path))]
      return Object.entries(lists())
        .filter(([engine]) => engine !== current())
        .flatMap(([engine, sessions]) =>
          (sessions as SessionInfo[]).map((session) => {
            const directory = session.location?.directory
            const listed = directory
              ? listedFolder({ directory, theirs: repos()[engine] ?? {}, ours, mine: repos()[current()] ?? {} })
              : directory
            return listed === directory ? session : { ...session, location: { ...session.location, directory: listed } }
          }),
        )
        .filter((session) => !here.has(session.id) && !isSuggestionSession(session))
    },
    /** The engine another computer's session lives in, or nothing for the one the window drives. */
    owner,
    /**
     * Opens a session wherever it lives: one on another engine first moves the window to that
     * engine, the computer's or this one's. A computer that is off cannot be driven.
     */
    open(sessionID: string, select: (sessionID: string) => void) {
      const engine = owner(sessionID)
      const host = remote.hosts().find((entry) => entry.hostId === engine)
      if (host && remote.hostStatus(host.hostId) === "offline")
        return toast(t("Remote control unavailable: {name} is offline", { name: host.name }), "error")
      if (host) remote.connect(host.hostId)
      else if (engine) remote.disconnect()
      select(sessionID)
    },
    /** The computer a session lives on, when that is not this one; nothing for this computer's own. */
    computer: (sessionID: string): SessionComputer | undefined => {
      if (!desktopRemote()) return undefined
      const engine = owner(sessionID) ?? current()
      if (engine === LOCAL_ENGINE) return undefined
      const host = remote.hosts().find((entry) => entry.hostId === engine)
      return host ? { engine, name: host.name, status: remote.hostStatus(engine) } : undefined
    },
  }
}

/** Lists an engine, then lists it again whenever its stream says a session changed. */
async function follow(engine: Engine, signal: AbortSignal, update: (sessions: Cached[]) => void) {
  const client = createClient(engine.url)
  let timer: ReturnType<typeof setTimeout> | undefined
  const reload = () =>
    list(client)
      .then((sessions) => signal.aborted || update(sessions))
      .catch(() => undefined)
  signal.addEventListener("abort", () => clearTimeout(timer))
  while (!signal.aborted) {
    await reload()
    try {
      for await (const event of client.event.subscribe({ signal })) {
        if (!LIST_EVENTS.test(event.type ?? "")) continue
        clearTimeout(timer)
        timer = setTimeout(() => void reload(), 500)
      }
    } catch {
      // The stream dropped: list again once it is back, since what it missed is gone.
    }
    if (!signal.aborted) await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

async function list(client: ReturnType<typeof createClient>) {
  const sessions: SessionInfo[] = []
  let cursor: string | undefined
  while (sessions.length < MOST) {
    const response = await client.session.list({ limit: PAGE, cursor })
    sessions.push(...(response.data ?? []))
    cursor = response.cursor?.next ?? undefined
    if ((response.data?.length ?? 0) < PAGE || !cursor) break
  }
  return sessions
}

function trim(session: Cached): Cached {
  return {
    id: session.id,
    title: session.title,
    parentID: session.parentID,
    location: session.location,
    time: session.time,
    // Chat or Code: which tab lists it (chat.ts).
    ...(session.agent ? { agent: session.agent } : {}),
  }
}

/**
 * Where another engine's folder is listed: the driven engine's folder of the same repository, then
 * one of the same name, then its own path. Two folders of one name are one project, unless each
 * names a different repository.
 */
export function listedFolder(input: {
  directory: string
  /** The repository of each of the other engine's folders. */
  theirs: Record<string, string | null>
  /** The driven engine's folders. */
  ours: string[]
  /** The repository of each of the driven engine's folders. */
  mine: Record<string, string | null>
}) {
  if (input.ours.includes(input.directory)) return input.directory
  const repository = input.theirs[input.directory]
  const name = folderName(input.directory)
  return (
    (repository && input.ours.find((candidate) => input.mine[candidate] === repository)) ||
    input.ours.find(
      (candidate) =>
        folderName(candidate) === name &&
        !(repository && input.mine[candidate] && input.mine[candidate] !== repository),
    ) ||
    input.directory
  )
}

function folderName(directory: string) {
  return directory
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1)
    ?.toLowerCase()
}
