import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createResource } from "../../resource"
import type { DiffMode } from "../../components/ChangesPanel"
import type { ContextTokens } from "../../components/ContextPanel"
import { createClient, createHarnessClient } from "../../client"
import { INSTRUCTION_NOTES, INSTRUCTION_SYSTEM } from "../../chat"
import type { Artifact, ProjectMemory } from "../../types"
import { t } from "../../i18n"
import { toast } from "../../toast"
import type { AppStores } from "../../app-context"

export function createWorkspace(app: AppStores) {
  /** What the runs left behind (H-14), for the project this session is working in. */
  const [artifactList, setArtifactList] = createSignal<Artifact[]>([])
  // The last artifacts read that failed, so the panel says whether the list is the server's or the
  // last one it managed to read, instead of borrowing the routines connection's state.
  const [artifactsFailure, setArtifactsFailure] = createSignal<Error>()
  const artifactsAvailable = () => !!app.connection.harnessServerUrl() && !artifactsFailure()
  // Where the next page of documents starts (RP-03); absent once the last page is read.
  const [artifactsNext, setArtifactsNext] = createSignal<number>()
  const refreshArtifacts = async () => {
    const directory = app.sessions.modelLocation()
    try {
      const page = await createHarnessClient(app.connection.harnessServerUrl()).artifacts.page(
        directory ? { directory } : {},
      )
      // A server that answers without a list keeps the last one instead of clearing it: the list is
      // rendered and searched as an array, and `undefined` there took the whole app down.
      if (page.data) setArtifactList(page.data)
      setArtifactsNext(page.next)
      setArtifactsFailure(undefined)
    } catch (cause) {
      setArtifactsFailure(cause instanceof Error ? cause : new Error(String(cause)))
    }
  }
  const loadMoreArtifacts = async () => {
    const offset = artifactsNext()
    if (offset === undefined) return
    const directory = app.sessions.modelLocation()
    const page = await createHarnessClient(app.connection.harnessServerUrl())
      .artifacts.page({ ...(directory ? { directory } : {}), offset })
      .catch((cause) => {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
        return undefined
      })
    if (!page?.data) return
    const known = new Set(artifactList().map((artifact) => artifact.id))
    setArtifactList([...artifactList(), ...page.data.filter((artifact) => !known.has(artifact.id))])
    setArtifactsNext(page.next)
  }
  // A document kept or changed while the app is open shows without reopening the screen (RP-03).
  // Several in a row (a turn writing a few) are read once.
  let artifactsRefresh: ReturnType<typeof setTimeout> | undefined
  const artifactsChanged = () => {
    clearTimeout(artifactsRefresh)
    artifactsRefresh = setTimeout(() => void refreshArtifacts(), 300)
  }
  onCleanup(() => clearTimeout(artifactsRefresh))
  createEffect(() => {
    app.connection.harnessServerUrl()
    app.sessions.modelLocation()
    void refreshArtifacts()
  })

  // The project's notes (H-37), handed to every turn so they do not have to be repeated.
  const [projectNotes, setProjectNotes] = createSignal<ProjectMemory[]>([])

  createEffect(() => {
    const url = app.connection.harnessServerUrl()
    const directory = app.sessions.vcsDirectory()
    if (!url || !directory || !app.runs.routinesServerAvailable() || !app.connection.supports("memory")) {
      setProjectNotes([])
      return
    }
    void createHarnessClient(url)
      .memory.list(directory)
      .then(setProjectNotes)
      .catch(() => setProjectNotes([]))
  })

  const projectMemoryText = () => {
    const notes = projectNotes()
    return notes.length > 0 ? `Project memory:\n${notes.map((note) => `- ${note.text}`).join("\n")}` : ""
  }
  /**
   * The instructions a turn runs under (H-37): the mode's own system prompt, if it has one, and the
   * project's notes. Named apart, so the engine only hears about the one that changed.
   */
  const instructionsFor = (system?: string) => ({
    [INSTRUCTION_SYSTEM]: system,
    [INSTRUCTION_NOTES]: projectMemoryText() || undefined,
  })
  const addProjectNote = (text: string) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return
    void createHarnessClient(app.connection.harnessServerUrl())
      .memory.add({ directory, text })
      .then((note) => setProjectNotes((list) => [...list, note]))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  const removeProjectNote = (id: string) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .memory.remove(id)
      .then(() => setProjectNotes((list) => list.filter((note) => note.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const removeArtifact = (id: string) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .artifacts.remove(id)
      .then(() => setArtifactList(artifactList().filter((artifact) => artifact.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // The file tree and viewer (H-19): the engine lists and finds, the harness server reads the text.
  const listFiles = (path?: string) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return Promise.resolve([])
    // A failed listing rejects so the files screen can say so and offer a retry, instead of
    // showing an empty folder.
    return createClient(app.connection.serverUrl()).file.list({ directory, ...(path ? { path } : {}) })
  }
  const searchFileEntries = async (query: string) =>
    (await createClient(app.connection.serverUrl()).file.find({ query, limit: 40 })).data
  const readFileText = (path: string) =>
    createHarnessClient(app.connection.harnessServerUrl()).files.read({
      directory: app.sessions.vcsDirectory() ?? "",
      path,
    })
  const updateArtifact = (id: string, input: { pinned?: boolean; expiresAt?: number | null }) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .artifacts.update(id, input)
      // Pinned first, so the row moves to where the list says it should be instead of waiting for
      // the next refresh to look right.
      .then((updated) =>
        setArtifactList(
          artifactList()
            .map((artifact) => (artifact.id === id ? updated : artifact))
            .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.createdAt - a.createdAt),
        ),
      )
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const vcsKey = () => {
    const directory = app.sessions.vcsDirectory()
    return app.connection.ready() && directory ? `${app.connection.serverUrl()}::${directory}` : undefined
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
  // The diff viewer's own read (H-06). It is kept apart from the status above on purpose: the status
  // is two numbers in the composer and is refetched all through a turn, while a patch is only worth
  // asking for while somebody has the screen open — which is what the key checks first.
  //
  // A string key, for the reason written against `blockedSource` in the sessions store: an object
  // source is a new object on every reactive read, and this one would refetch a whole diff each time.
  const [diffMode, setDiffMode] = createSignal<DiffMode>("git")
  const changesKey = () => {
    const directory = app.sessions.vcsDirectory()
    if (!app.router.changesOpen() || !app.connection.ready() || !directory) return undefined
    return `${app.connection.serverUrl()}\n${directory}\n${diffMode()}`
  }
  const [changes, { refetch: refetchChanges }] = createResource(changesKey, (key) => {
    const [url = "", directory = "", mode = "git"] = key.split("\n")
    return createClient(url).vcs.diff(directory, { mode: mode as DiffMode })
  })
  const openChanges = () => {
    app.router.showScreen("changes")
    void refetchChanges()
  }

  // What the model was given (H-17). The instruction files come from the harness server, which can
  // read the disk; the rest is the engine's own answer about this folder.
  const contextKey = () => {
    const directory = app.sessions.vcsDirectory()
    if (!app.router.contextOpen() || !directory || !app.runs.routinesServerAvailable()) return undefined
    return `${app.connection.harnessServerUrl()}\n${directory}`
  }
  const [contextReport] = createResource(contextKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).context.get({ directory })
  })
  const readInstruction = (path: string) =>
    createHarnessClient(app.connection.harnessServerUrl())
      .context.file({ directory: app.sessions.vcsDirectory() ?? "", path })
      .then((answer) => {
        if (!answer) throw new Error(t("Could not read that file"))
        return answer.content
      })
  // The system prompt the engine assembled, which is the one part of the context no engine endpoint
  // reports. FlupCode's engine plugin records it per request, so it belongs to a session rather than
  // a folder, and is read for the open one.
  const [capturedPrompts] = createResource(
    () => {
      const sessionID = app.sessions.selected()
      return app.router.contextOpen() && sessionID && app.runs.routinesServerAvailable()
        ? { url: app.connection.harnessServerUrl(), sessionID }
        : undefined
    },
    (source) => createHarnessClient(source.url).context.systemPrompt({ sessionID: source.sessionID }),
  )
  // What tools this session ran. It is the only thing there is to say about an MCP server's tools:
  // the engine reports no list of what one offers, only the calls that go through it.
  const [toolUses] = createResource(
    () => {
      const sessionID = app.sessions.selected()
      return app.router.contextOpen() && sessionID && app.runs.routinesServerAvailable()
        ? { url: app.connection.harnessServerUrl(), sessionID }
        : undefined
    },
    (source) => createHarnessClient(source.url).context.toolUses({ sessionID: source.sessionID }),
  )
  /**
   * What this session's window actually holds.
   *
   * The engine reports these five and no more, so five is what is shown. Inventing a
   * "system prompt" slice out of the difference would be a number nobody measured.
   */
  const contextTokens = (): ContextTokens | undefined => {
    const tokens = app.sessions.selectedSession()?.tokens
    if (!tokens) return undefined
    return {
      input: tokens.input ?? 0,
      output: tokens.output ?? 0,
      reasoning: tokens.reasoning ?? 0,
      cacheRead: tokens.cache?.read ?? 0,
      cacheWrite: tokens.cache?.write ?? 0,
    }
  }
  /** How many times this session has been compacted, counted from its own transcript. */
  const compactions = () => {
    const held = app.sessions.messages()
    const list = Array.isArray(held) ? held : (held?.data ?? [])
    return list.filter((message) => {
      const entry = message as { summary?: boolean; info?: { summary?: boolean } }
      return entry.summary === true || entry.info?.summary === true
    }).length
  }

  // Findings (H-32). Read alongside the diff, since that is where they are shown.
  const [findingsTick, setFindingsTick] = createSignal(0)
  const findingsKey = () => {
    const directory = app.sessions.vcsDirectory()
    if (!app.router.changesOpen() || !directory || !app.runs.routinesServerAvailable()) return undefined
    return `${app.connection.harnessServerUrl()}\n${directory}\n${findingsTick()}`
  }
  const [findings] = createResource(findingsKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).findings.list({ directory })
  })
  const resolveFinding = (id: string, resolved: boolean) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .findings.resolve(id, resolved)
      .then(() => setFindingsTick((tick) => tick + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // Checkpoints (H-15). Listed only while the screen is open, and re-read whenever one is taken or
  // a restore lands, because a restore records one of its own.
  const [checkpointTick, setCheckpointTick] = createSignal(0)
  const [checkpointBusy, setCheckpointBusy] = createSignal(false)
  const checkpointKey = () => {
    const directory = app.sessions.vcsDirectory()
    if (!app.router.changesOpen() || !directory || !app.runs.routinesServerAvailable()) return undefined
    return `${app.connection.harnessServerUrl()}\n${directory}\n${checkpointTick()}`
  }
  const [checkpoints] = createResource(checkpointKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).checkpoints.list(directory)
  })
  const checkpointPlan = (id: string) =>
    createHarnessClient(app.connection.harnessServerUrl())
      .checkpoints.plan(id)
      .then((plan) => {
        if (!plan) throw new Error(t("Could not work out what would change"))
        return plan
      })
  const restoreCheckpoint = (id: string) => {
    setCheckpointBusy(true)
    void createHarnessClient(app.connection.harnessServerUrl())
      .checkpoints.restore(id)
      .then((done) => {
        const plan = done?.plan
        setCheckpointTick((tick) => tick + 1)
        void refetchChanges()
        void refetchVcsStatus()
        toast(t("Checkpoint restored"), "success", {
          description: t("Restored: {written} rewritten, {removed} deleted", {
            written: plan?.write.length ?? 0,
            removed: plan?.remove.length ?? 0,
          }),
        })
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setCheckpointBusy(false))
  }
  const takeCheckpoint = (title: string) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return
    setCheckpointBusy(true)
    void createHarnessClient(app.connection.harnessServerUrl())
      .checkpoints.take({ directory, title })
      .then(() => setCheckpointTick((tick) => tick + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setCheckpointBusy(false))
  }
  const removeCheckpoint = (id: string) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .checkpoints.remove(id)
      .then(() => setCheckpointTick((tick) => tick + 1))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const artifacts = () => {
    const files = new Set<string>()
    for (const message of app.sessions.activeMessages() ?? []) {
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

  // Project-relative paths in the order the session touched them, most recent last. The files
  // changed panel uses it to expand the stack the agent edited last.
  const changedFiles = createMemo(() => {
    const directory = app.sessions.selectedSession()?.location?.directory
    const order: string[] = []
    const push = (file: string) => {
      const path = directory && file.startsWith(`${directory}/`) ? file.slice(directory.length + 1) : file
      const index = order.indexOf(path)
      if (index >= 0) order.splice(index, 1)
      order.push(path)
    }
    for (const message of app.sessions.activeMessages() ?? []) {
      if (message.type !== "assistant") continue
      for (const file of message.snapshot?.files ?? []) push(file)
      for (const part of message.content) {
        if (part.type !== "tool" || part.state.status === "pending") continue
        const input = part.state.input as { filePath?: unknown; path?: unknown }
        const path =
          typeof input.filePath === "string" ? input.filePath : typeof input.path === "string" ? input.path : undefined
        if (path && (part.name === "write" || part.name === "edit" || part.name === "patch")) push(path)
      }
    }
    return order
  })

  // Where the branch stands on GitHub (H-20), for the chip above the composer.
  //
  // Polled rather than streamed, because GitHub is the one telling us and nobody here is listening
  // to it: every 20 seconds while checks are still running, every two minutes once they have
  // settled. `branchTick` is bumped by the timer and by anything that changes the branch, so a
  // commit or a new branch is reflected without waiting for the next poll.
  const [branchTick, setBranchTick] = createSignal(0)
  const branchKey = () => {
    const directory = app.sessions.vcsDirectory()
    if (!app.connection.ready() || !directory || !app.runs.routinesServerAvailable()) return undefined
    return `${app.connection.harnessServerUrl()}\n${directory}\n${branchTick()}`
  }
  const [branchState] = createResource(branchKey, (key) => {
    const [url = "", directory = ""] = key.split("\n")
    return createHarnessClient(url).git.state(directory)
  })
  createEffect(() => {
    if (!branchKey()) return
    const running = (branchState()?.pullRequest?.checks.running ?? 0) > 0
    const timer = setTimeout(() => setBranchTick((tick) => tick + 1), running ? 20_000 : 120_000)
    onCleanup(() => clearTimeout(timer))
  })
  const [openingPullRequest, setOpeningPullRequest] = createSignal(false)
  const openPullRequest = (title: string) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return
    setOpeningPullRequest(true)
    void createHarnessClient(app.connection.harnessServerUrl())
      .git.openPullRequest({ directory, title })
      .then(() => {
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setOpeningPullRequest(false))
  }

  // Git (H-20). Committing was a prompt: `"Commit the current changes with a clear message."` went
  // to the model, which then ran the commands itself. A whole turn, paid for in tokens, to run two
  // commands the server can run for nothing — and with no say in what went into the commit.
  const [committing, setCommitting] = createSignal(false)
  const commitPicked = (input: { message: string; paths: string[]; hunks?: Record<string, number[]> }) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return
    setCommitting(true)
    void createHarnessClient(app.connection.harnessServerUrl())
      .git.commit({ directory, ...input })
      .then(() => {
        void refetchChanges()
        void refetchVcsStatus()
        void refetchVcsInfo()
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
      .finally(() => setCommitting(false))
  }
  /** Throws a change away, or the named hunks of it (H-20). */
  const discardChanges = (input: { path: string; hunks?: number[] }) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return
    void createHarnessClient(app.connection.harnessServerUrl())
      .git.discard({ directory, ...input })
      .then(() => {
        void refetchChanges()
        void refetchVcsStatus()
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  /** A commit message written from the picked change, by a throwaway engine session (H-20). */
  const generateCommitMessage = (input: { paths: string[]; hunks?: Record<string, number[]> }) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return Promise.resolve(undefined)
    return createHarnessClient(app.connection.harnessServerUrl())
      .git.message({ directory, ...input })
      .then((answer) => answer.message)
      .catch((cause) => {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
        return undefined
      })
  }
  const startBranch = (name: string) => {
    const directory = app.sessions.vcsDirectory()
    if (!directory) return
    void createHarnessClient(app.connection.harnessServerUrl())
      .git.branch({ directory, name })
      .then(() => {
        void refetchVcsInfo()
        void refetchChanges()
        setBranchTick((tick) => tick + 1)
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * The repo bar's commit button.
   *
   * It used to write a prompt and send it, so pressing it cost a model turn to run `git add` and
   * `git commit`. It now opens the diff, where the commit is made by the server — which is also the
   * only place a reader can see what they are about to commit before they commit it.
   */
  const commitChanges = () => openChanges()
  return {
    addProjectNote,
    artifactList,
    artifacts,
    artifactsAvailable,
    artifactsChanged,
    artifactsNext,
    branchState,
    capturedPrompts,
    changedFiles,
    changes,
    checkpointBusy,
    checkpointPlan,
    checkpoints,
    commitChanges,
    commitPicked,
    committing,
    compactions,
    contextReport,
    contextTokens,
    diffMode,
    discardChanges,
    findings,
    generateCommitMessage,
    instructionsFor,
    listFiles,
    loadMoreArtifacts,
    openChanges,
    openPullRequest,
    openingPullRequest,
    projectNotes,
    readFileText,
    readInstruction,
    refetchChanges,
    refetchVcsInfo,
    refetchVcsStatus,
    removeArtifact,
    removeCheckpoint,
    removeProjectNote,
    resolveFinding,
    restoreCheckpoint,
    searchFileEntries,
    setDiffMode,
    startBranch,
    takeCheckpoint,
    toolUses,
    updateArtifact,
    vcsInfo,
    vcsStatus,
    vcsTotals,
  }
}

export type WorkspaceStore = ReturnType<typeof createWorkspace>
