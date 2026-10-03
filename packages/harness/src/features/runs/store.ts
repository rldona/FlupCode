import { createEffect, createMemo, createSignal, onCleanup, untrack } from "solid-js"
import { createResource } from "../../resource"
import { searchForCompare } from "../../screen"
import type { NearBudgetAnswer, TaskActivity, TaskTools, TouchedFiles, Unattended } from "../../types"
import { createClient, createHarnessClient, HarnessError } from "../../client"
import { STORAGE_KEYS, readStorage, writeStorage } from "../../storage"
import { runAttention, worstAttention } from "../../attention"
import type {
  ActionProfileSummary,
  Artifact,
  Routine,
  RoutineInput,
  RoutineRun,
  Run,
  SessionPrefs,
  Task,
  Workflow,
  StashedPrompt,
} from "../../types"
import { t } from "../../i18n"
import { toast } from "../../toast"
import type { RunCheckpointActions } from "../../components/RunCheckpoints"
import type { RunRequests } from "../../components/RunsPanel"
import { metPerson } from "../../run-state"
import { pairingEpoch } from "../../pairing"
import type { WorkflowLaunch } from "../../components/WorkflowLaunchDialog"
import type { BestOfNLaunch } from "../../components/BestOfNDialog"
import { runSnapshot } from "../../compare"
import { remote } from "../../remote"
import { normalizeRoutine, normalizeRoutines } from "../../routine-normalize"
import { budgetNotice } from "../../components/BudgetMeter"
import type { AppStores } from "../../app-context"

export function createRuns(app: AppStores) {
  const [routineBusy, setRoutineBusy] = createSignal(false)
  const [routineBusyID, setRoutineBusyID] = createSignal<string>()
  const [routineRunID, setRoutineRunID] = createSignal<string>()
  /** A routine the sidebar asked the screen to open on, cleared once it has. */
  const [routineFocus, setRoutineFocus] = createSignal<string>()
  const [routines, setRoutines] = createSignal<Routine[]>(
    normalizeRoutines(readStorage<unknown>(STORAGE_KEYS.routines, [])),
  )
  /** How many runs the supervisor shows. Enough to see what is happening, not a history. */
  const RUNS_SHOWN = 20
  const [runs, setRuns] = createSignal<Run[]>([])
  const [routinesServerAvailable, setRoutinesServerAvailable] = createSignal(false)
  const [routinesServerLoading, setRoutinesServerLoading] = createSignal(false)
  /**
   * The harness answered but refused this page its loopback token (`403 invalid_token`). It is not
   * down, and saying "not reachable" sent people looking for a server that was running (TI-14).
   */
  const [harnessRefusal, setHarnessRefusal] = createSignal<HarnessError>()
  /** The web actions the server knows (WA-7), for the routine editor's action preset. */
  const [actionProfiles, setActionProfiles] = createSignal<ActionProfileSummary[]>([])
  createEffect(() => writeStorage(STORAGE_KEYS.routines, routines()))
  /**
   * The processes this project has written down (H-21).
   *
   * Keyed by the folder as well as the server: a repository's own workflows win over the shared
   * ones, so the list is different depending on where the session is working.
   */
  const [workflows, { refetch: refetchWorkflows }] = createResource(
    () =>
      app.connection.harnessServerUrl()
        ? `${app.connection.harnessServerUrl()}\n${app.sessions.modelLocation() ?? ""}`
        : undefined,
    async (key) => {
      const [url = "", directory = ""] = key.split("\n")
      // The failure is kept, not swallowed: the screen says whether the list is the server's or the
      // last one it managed to read.
      return createHarnessClient(url).workflows.list(directory || undefined)
    },
  )
  // What the workflows screen may act on: files it can write, and the status the notice reads.
  const workflowsAvailable = () => !!app.connection.harnessServerUrl() && !workflows.failure()
  const workflowNamed = (name: string) => (workflows() ?? []).find((workflow) => workflow.name === name)
  /** Where the runs screen opens next: a run, and the task whose detail it shows (RP-03). */
  const [runFocus, setRunFocus] = createSignal<{ runID: string; taskID?: string }>()
  // What the running tasks are doing, and what the finished ones changed (H-12).
  //
  // Two different clocks on purpose. Activity changes by the second and is polled while the screen
  // is open and something is running; the files a task touched are settled the moment it ends, so
  // they are read once per run and again when the run's shape changes.
  const [doingTick, setDoingTick] = createSignal(0)
  const goingRuns = () =>
    runs()
      .filter((run) => run.status === "running")
      .map((run) => run.id)
  const activityKey = () => {
    if (!app.router.runsOpen() || !routinesServerAvailable() || goingRuns().length === 0) return undefined
    return `${app.connection.harnessServerUrl()}\n${goingRuns().join(",")}\n${doingTick()}`
  }
  const [taskActivity] = createResource(activityKey, async (key) => {
    const [url = "", ids = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const lists = await Promise.all(ids.split(",").map((id) => client.runs.activity(id).catch(() => undefined)))
    const byTask: Record<string, TaskActivity> = {}
    for (const list of lists) for (const entry of list ?? []) byTask[entry.taskID] = entry
    return byTask
  })
  createEffect(() => {
    if (!activityKey()) return
    // Read once the request has landed, so the clock is between answers rather than on top of them.
    taskActivity()
    const timer = setTimeout(() => setDoingTick((tick) => tick + 1), 3000)
    onCleanup(() => clearTimeout(timer))
  })

  // What a run held for a request is waiting on (RP-05): its running tasks' pending permissions and
  // forms, asked of the engine per task session, with the transcript the permission dock previews
  // from. Polled while the Runs screen shows a held run: a second request in the same turn does not
  // change the run, so nothing else would say it arrived.
  const [requestTick, setRequestTick] = createSignal(0)
  const heldRuns = () => runs().filter((run) => run.status === "awaiting" && run.paused === "request")
  const runRequestsKey = () => {
    if (!app.router.runsOpen() || !app.connection.ready() || heldRuns().length === 0) return undefined
    const sessions = heldRuns().flatMap((run) =>
      (run.tasks ?? []).flatMap((task) =>
        task.status === "running" && task.sessionID ? [`${run.id}:${task.sessionID}`] : [],
      ),
    )
    return sessions.length > 0 ? `${app.connection.serverUrl()}\n${sessions.join(",")}\n${requestTick()}` : undefined
  }
  const [runRequests, { refetch: refetchRunRequests }] = createResource(runRequestsKey, async (key) => {
    const [url = "", list = ""] = key.split("\n")
    const engine = createClient(url)
    const entries = await Promise.all(
      list.split(",").map(async (entry) => {
        const [runID = "", sessionID = ""] = entry.split(":")
        const [permissions, questions] = await Promise.all([
          engine.session.permission.list({ sessionID }).then(
            (result) => result.data ?? [],
            () => [],
          ),
          engine.session.question.list({ sessionID }).then(
            (result) => result.data ?? [],
            () => [],
          ),
        ])
        // Only a permission previews from the transcript; a form carries its own question.
        const messages =
          permissions.length > 0
            ? await engine.message.list({ sessionID }).then(
                (result) => result.data ?? [],
                () => [],
              )
            : []
        return { runID, permissions, questions, messages }
      }),
    )
    return entries.reduce<Record<string, RunRequests>>((byRun, entry) => {
      const held = byRun[entry.runID] ?? { permissions: [], questions: [], messages: [] }
      byRun[entry.runID] = {
        permissions: [...held.permissions, ...entry.permissions],
        questions: [...held.questions, ...entry.questions],
        messages: [...held.messages, ...entry.messages],
      }
      return byRun
    }, {})
  })
  createEffect(() => {
    if (!runRequestsKey()) return
    runRequests()
    const timer = setTimeout(() => setRequestTick((tick) => tick + 1), 3000)
    onCleanup(() => clearTimeout(timer))
  })
  // The project default of each run that met a task needing a person, so its card can say what the
  // next one does and change it.
  const [projectUnattended, { mutate: setProjectUnattendedCache }] = createResource(
    () => {
      if (!app.connection.supports("unattended")) return undefined
      const directories = [
        ...new Set(runs().flatMap((run) => (run.directory && metPerson(run) ? [run.directory] : []))),
      ]
      return directories.length > 0 ? `${app.connection.harnessServerUrl()}\n${directories.join("\n")}` : undefined
    },
    async (key) => {
      const [url = "", ...directories] = key.split("\n")
      const client = createHarnessClient(url)
      const modes = await Promise.all(
        directories.map((directory) =>
          client.runs.unattended(directory).then(
            (answer) => [directory, answer.unattended] as const,
            () => undefined,
          ),
        ),
      )
      return Object.fromEntries(modes.flatMap((entry) => (entry ? [entry] : [])))
    },
  )
  const changeProjectUnattended = (directory: string, unattended: Unattended) =>
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.setUnattended(directory, unattended)
      .then(() => setProjectUnattendedCache((current) => ({ ...current, [directory]: unattended })))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))

  // The runs on screen, as a key that changes only when one of them changes shape or status. Shared
  // by the three per-run reads below, so they refetch together and only when there is a reason to.
  const runsDetailKey = () => {
    if (!app.router.runsOpen() || !routinesServerAvailable()) return undefined
    // A task that finishes is a reason too: it changed files and the ledger has its bill (UL-06).
    const shape = runs()
      .map((run) => {
        const finished = (run.tasks ?? []).filter((task) => task.status !== "queued" && task.status !== "running")
        return `${run.id}:${run.tasks?.length ?? 0}:${run.status}:${finished.length}`
      })
      .join("|")
    return shape ? `${app.connection.harnessServerUrl()}\n${shape}` : undefined
  }
  const runIDsOf = (key: string) =>
    key
      .split("\n")[1]
      ?.split("|")
      .map((entry) => entry.split(":")[0]!)
      .filter(Boolean) ?? []

  const [touched] = createResource(runsDetailKey, async (key) => {
    const [url = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const lists = await Promise.all(runIDsOf(key).map((id) => client.runs.files(id).catch(() => undefined)))
    const byTask: Record<string, TouchedFiles> = {}
    for (const list of lists) for (const entry of list ?? []) if (entry.taskID) byTask[entry.taskID] = entry
    return byTask
  })
  const [taskTools] = createResource(runsDetailKey, async (key) => {
    const [url = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const lists = await Promise.all(runIDsOf(key).map((id) => client.runs.tools(id).catch(() => undefined)))
    const byTask: Record<string, TaskTools> = {}
    for (const list of lists) for (const entry of list ?? []) byTask[entry.taskID] = entry
    return byTask
  })
  // What each run spent, from the usage ledger (UL-06): the card's figure is the Cost screen's.
  const [runUsage, { refetch: refetchRunUsage }] = createResource(runsDetailKey, async (key) => {
    const [url = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const ids = runIDsOf(key)
    const reports = await Promise.all(ids.map((id) => client.runUsage(id).catch(() => undefined)))
    return Object.fromEntries(reports.flatMap((report) => (report ? [[report.runID, report]] : [])))
  })
  const [runArtifacts] = createResource(runsDetailKey, async (key) => {
    const [url = ""] = key.split("\n")
    const client = createHarnessClient(url)
    const ids = runIDsOf(key)
    const lists = await Promise.all(ids.map((id) => client.artifacts.list({ runID: id }).catch(() => undefined)))
    const byRun: Record<string, Artifact[]> = {}
    ids.forEach((id, index) => {
      const list = lists[index]
      if (list) byRun[id] = list
    })
    return byRun
  })

  /*
   * One attention scale for sessions, runs and routines (UX-02), computed here once and drawn by
   * `AttentionMark` wherever any of them is listed.
   *
   * "Finished unseen" for runs is when it finished after the reader last had runs in front of them
   * — the Runs or the Routines screen — on this device. Unlike a session, a run says when it
   * finished, so one that ended overnight while the app was closed still counts. The first time
   * there is no mark yet, and only what finishes from then on is new.
   */
  const [runsSeenAt, setRunsSeenAt] = createSignal(readStorage<number>(STORAGE_KEYS.runsSeenAt, Date.now()))
  createEffect(() => writeStorage(STORAGE_KEYS.runsSeenAt, runsSeenAt()))
  createEffect(() => {
    if (!app.router.runsOpen() && !app.router.routinesOpen()) return
    // Read so that a run finishing while the screen is open is seen as it lands.
    runs()
    setRunsSeenAt(Date.now())
  })
  const runAttentionOf = (run: Run | RoutineRun) =>
    runAttention(
      run,
      { approval: app.sessions.approvalSessions(), answer: app.sessions.questionSessions() },
      (run.finishedAt ?? 0) <= runsSeenAt(),
    )
  const runsAttention = createMemo(() => Object.fromEntries(runs().map((run) => [run.id, runAttentionOf(run)])))
  // A routine is as urgent as the most urgent of its runs. The run list has the tasks (and so the
  // sessions a task waits in); a routine's own copy of a run is used only when the list lacks it.
  const routinesAttention = createMemo(() =>
    Object.fromEntries(
      routines().map((routine) => [
        routine.id,
        // A routine failing run after run is a failure on the scale until a run does not fail (RP-07),
        // seen or not: it is what the routine is, not one outcome the reader may have looked at.
        worstAttention([
          routine.failing && "failed",
          ...routine.runs.map((run) => runsAttention()[run.id] ?? runAttentionOf(run)),
        ]),
      ]),
    ),
  )
  const routineProjects = createMemo(() => {
    const directory = app.sessions.targetDirectory()
    if (!directory || app.sessions.projects().some((project) => project.directory === directory))
      return app.sessions.projects()
    return [
      {
        id: directory,
        directory,
        name: directory.split("/").filter(Boolean).at(-1) || directory,
      },
      ...app.sessions.projects(),
    ]
  })

  // What needs the reader, for the phone's home (H-12, UX-02): runs going, and the ones that ended
  // since its Runs view was last open. Everything else is in that view (HE-02).
  const remoteRuns = createMemo(() =>
    app.settings.mobileRemote() ? runs().filter((run) => runsAttention()[run.id] !== undefined) : [],
  )

  const setRoutineState = (next: Routine[]) => {
    setRoutines(next)
    const active = next
      .flatMap((routine) => routine.runs.map((run) => ({ routine, run })))
      .find(({ run }) => run.status === "running")
    setRoutineBusy(!!active)
    setRoutineBusyID(active?.routine.id)
    setRoutineRunID(active?.run.id)
  }

  const refreshRoutines = async () => {
    if (routinesServerLoading()) return
    setRoutinesServerLoading(true)
    try {
      const current = createHarnessClient(app.connection.harnessServerUrl())
      // The action catalogue is only there when a browser runtime was built; without it the
      // editor simply offers no actions. A missing catalogue is not the server being down.
      const catalog = await current.actions.list().catch(() => undefined)
      setActionProfiles(catalog?.profiles ?? [])
      const remote = normalizeRoutines(await current.routines.list())
      const migrated = readStorage(STORAGE_KEYS.routinesMigration, false)
      if (!migrated && remote.length === 0 && routines().length > 0) {
        const created = await Promise.all(
          routines().map((routine) => current.routines.create(routine).then((saved) => saved.data)),
        )
        writeStorage(STORAGE_KEYS.routinesMigration, true)
        setRoutineState(normalizeRoutines(created))
      } else {
        writeStorage(STORAGE_KEYS.routinesMigration, true)
        setRoutineState(remote)
      }
      setRoutinesServerAvailable(true)
      setHarnessRefusal(undefined)
    } catch (cause) {
      setRoutinesServerAvailable(false)
      setHarnessRefusal(cause instanceof HarnessError && cause.code === "invalid_token" ? cause : undefined)
    } finally {
      setRoutinesServerLoading(false)
    }
  }

  /**
   * One change from the server, applied where it lands.
   *
   * A routine event carries the whole routine, and a run event the whole run, so none of this costs
   * a request: the list is read once when a connection opens, and after that the stream says what
   * moved. It replaces a five-second poll that asked for everything whether or not anything had
   * changed.
   */
  const applyHarnessEvent = (event: {
    type?: string
    routine?: unknown
    routineID?: unknown
    run?: unknown
    runID?: unknown
    task?: unknown
    prefs?: unknown
    prompt?: unknown
    promptID?: unknown
    name?: unknown
    lastRunAt?: unknown
    nextRunAt?: unknown
    failedInARow?: unknown
    failing?: unknown
  }) => {
    // What a reader keeps about a session, and their stash (H-18). The whole thing travels in the
    // event, so a pin on the phone is a pin on the desk without either asking again.
    if (event.type === "session.changed") {
      const prefs = event.prefs as SessionPrefs | undefined
      if (prefs?.sessionID) app.sessions.applyPrefs(prefs)
      return
    }
    if (event.type === "stash.added") {
      const prompt = event.prompt as StashedPrompt | undefined
      if (prompt?.id && !app.composer.stashes().some((entry) => entry.id === prompt.id))
        app.composer.setStashes((list) => [prompt, ...list])
      return
    }
    if (event.type === "artifact.created" || event.type === "artifact.changed") {
      app.workspace.artifactsChanged()
      return
    }
    if (event.type === "stash.removed" && typeof event.promptID === "string") {
      const removed = event.promptID
      app.composer.setStashes((list) => list.filter((entry) => entry.id !== removed))
      return
    }
    // The agent opened a browser window for this session: reveal the live view, once. A closed
    // session never opens it, and someone who closed the panel keeps it closed until the next
    // session opens one. Scheduled runs key their browser by task, never by session, so they
    // stay out of the way on their own.
    if (event.type === "browser.status") {
      const status = event as { sessionID?: unknown; closed?: unknown }
      if (typeof status.sessionID !== "string" || status.closed === true) return
      if (status.sessionID !== app.sessions.selected()) return
      const current = app.settings.panels()
      if (current.includes("agent-browser")) return
      const next = [...current, "agent-browser"]
      app.settings.setPanels(next)
      writeStorage(STORAGE_KEYS.workspacePanels, next)
      return
    }
    if (event.type === "routine.changed") {
      const routine = normalizeRoutine(event.routine)
      if (!routine) return
      const current = routines()
      return setRoutineState(
        current.some((entry) => entry.id === routine.id)
          ? current.map((entry) => (entry.id === routine.id ? routine : entry))
          : [routine, ...current],
      )
    }
    // When it fires next and how it has been failing, after one of its runs started or ended (RP-07).
    if (event.type === "routine.status" && typeof event.routineID === "string") {
      return setRoutineState(
        routines().map((routine) =>
          routine.id === event.routineID
            ? {
                ...routine,
                lastRunAt: typeof event.lastRunAt === "number" ? event.lastRunAt : routine.lastRunAt,
                nextRunAt: typeof event.nextRunAt === "number" ? event.nextRunAt : undefined,
                failedInARow: typeof event.failedInARow === "number" ? event.failedInARow : 0,
                failing: event.failing === true,
              }
            : routine,
        ),
      )
    }
    // The notice a routine raises once per streak of failures (RP-07); the phone gets it as a push.
    if (event.type === "routine.failing" && typeof event.name === "string") {
      return toast(
        t("{name} failed {count} times in a row", { name: event.name, count: Number(event.failedInARow) }),
        "error",
      )
    }
    // A budget's warning or its stop (UL-08), said once by the server; the card's meter is read again.
    if (event.type === "budget.reached" && typeof event.name === "string") {
      void refetchRunUsage()
      return toast(budgetNotice(event), (event as Record<string, unknown>).level === "hard" ? "error" : "info")
    }
    if (event.type === "routine.removed" && typeof event.routineID === "string") {
      const removed = event.routineID
      return setRoutineState(routines().filter((entry) => entry.id !== removed))
    }
    if (event.type === "run.started" || event.type === "run.changed") {
      const run = event.run as Run | undefined
      if (run?.id) {
        const current = runs()
        setRuns(
          current.some((entry) => entry.id === run.id)
            ? // Keep the tasks already loaded: a run event carries the run, not its tasks.
              current.map((entry) => (entry.id === run.id ? { ...run, tasks: entry.tasks } : entry))
            : [run, ...current],
        )
      }
    }
    if (event.type === "run.removed" && typeof event.runID === "string") {
      const removed = event.runID
      setRuns(runs().filter((run) => run.id !== removed))
      return setRoutineState(
        routines().map((routine) => ({ ...routine, runs: routine.runs.filter((run) => run.id !== removed) })),
      )
    }
    if (event.type === "task.changed") {
      const task = event.task as Task | undefined
      if (!task?.id) return
      return setRuns(
        runs().map((run) => {
          if (run.id !== task.runID) return run
          const tasks = run.tasks ?? []
          return {
            ...run,
            tasks: tasks.some((entry) => entry.id === task.id)
              ? tasks.map((entry) => (entry.id === task.id ? task : entry))
              : [...tasks, task].sort((a, b) => a.position - b.position),
          }
        }),
      )
    }
    if (event.type !== "run.started" && event.type !== "run.changed") return
    const run = event.run as RoutineRun | undefined
    const routineID = run?.source?.type === "routine" ? run.source.routineID : undefined
    if (!run?.id || !routineID) return
    setRoutineState(
      routines().map((routine) => {
        if (routine.id !== routineID) return routine
        const known = routine.runs.some((entry) => entry.id === run.id)
        return {
          ...routine,
          runs: known ? routine.runs.map((entry) => (entry.id === run.id ? run : entry)) : [run, ...routine.runs],
        }
      }),
    )
  }

  /**
   * The runs the server knows about, with the tasks each is made of.
   *
   * Read once when a connection opens; after that the stream says what moved. Tasks are asked for
   * per run because the list leaves them out.
   */
  const refreshRuns = async () => {
    try {
      const current = createHarnessClient(app.connection.harnessServerUrl())
      const list = (await current.runs.list()) ?? []
      const withTasks = await Promise.all(
        list
          .slice(0, RUNS_SHOWN)
          .map(async (run) => ({ ...run, tasks: await current.runs.tasks(run.id).catch(() => []) })),
      )
      setRuns(withTasks)
      // Over remote control the run list is what says whether the harness answers (HE-02).
      if (remote.activeHost()) setRoutinesServerAvailable(true)
    } catch {
      // The connection that failed is about to be reported by the loop below.
      if (remote.activeHost()) setRoutinesServerAvailable(false)
    }
  }

  // A phone's harness is reached through the computer (HE-02): the address stays the same, so the
  // tunnel coming up is what has to start the reading again, not the next step of the back-off.
  const tunnelUp = createMemo(() => remote.status() === "connected")
  createEffect(() => {
    const url = app.connection.harnessServerUrl()
    // Pairing or losing it reconnects with the token this tab now holds.
    pairingEpoch()
    tunnelUp()
    const controller = new AbortController()
    onCleanup(() => controller.abort())
    // Untracked: everything below reads and writes the routine state, and the first stretch of it
    // runs synchronously inside this effect. Tracked, the first refresh made the effect depend on
    // what it had just written, so every update tore the connection down and opened another —
    // measured at 17,000 connections in twenty seconds. Only the server's address belongs here.
    untrack(() => {
      void (async () => {
        for (let attempt = 0; !controller.signal.aborted; attempt++) {
          // Every connection starts by reading the list once. That is what makes the first paint and
          // every reconnection agree with the server, and it is the only request a quiet server gets.
          // A phone reaches the harness with the remote scope (HE-02): runs, not routines.
          if (!remote.activeHost()) await refreshRoutines()
          await refreshRuns()
          try {
            for await (const event of createHarnessClient(url).events({ signal: controller.signal })) {
              attempt = 0
              applyHarnessEvent(event as Parameters<typeof applyHarnessEvent>[0])
            }
          } catch {
            if (controller.signal.aborted) return
          }
          if (controller.signal.aborted) return
          // The stream ending is not the server being unreachable: the next `refreshRoutines` above
          // asks over a plain request and is what decides that. Marking it here made every harness
          // screen say "not reachable" whenever the event stream dropped, while requests still worked.
          await new Promise((resolve) => setTimeout(resolve, Math.min(10_000, 500 * 2 ** attempt)))
        }
      })()
    })
  })

  const addRoutine = (input: RoutineInput) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .routines.create(input)
      .then(({ data: routine, warnings }) => {
        // The stream may have brought it already (`routine.changed`), so it is not added twice.
        setRoutineState([routine, ...routines().filter((entry) => entry.id !== routine.id)])
        showRoutineWarnings(warnings)
        toast(t("Routine created"), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const updateRoutine = (id: string, input: RoutineInput) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .routines.update(id, input)
      .then(({ data: routine, warnings }) => {
        setRoutineState(routines().map((entry) => (entry.id === id ? routine : entry)))
        showRoutineWarnings(warnings)
        toast(t("Routine saved"), "success")
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /** What the server said beside a saved routine, without pretending it failed (WA-7). */
  const showRoutineWarnings = (warnings: string[]) => {
    for (const warning of warnings) toast(warning, "info")
  }

  const toggleRoutine = (id: string) => {
    const routine = routines().find((entry) => entry.id === id)
    if (!routine) return
    void createHarnessClient(app.connection.harnessServerUrl())
      .routines.setEnabled(id, !routine.enabled)
      .then((next) => setRoutineState(routines().map((entry) => (entry.id === id ? next : entry))))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const removeRoutine = (id: string) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .routines.remove(id)
      .then(() => setRoutineState(routines().filter((entry) => entry.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const stopRun = (id: string) =>
    createHarnessClient(app.connection.harnessServerUrl())
      .runs.stop(id)
      .then(() => undefined)
      .catch((cause) => {
        toast(cause instanceof Error ? cause.message : String(cause), "error")
        throw cause
      })

  const removeRun = (id: string) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.remove(id)
      // The event says so too, but not to a reader whose stream is down: the list moves either way.
      .then(() => setRuns(runs().filter((run) => run.id !== id)))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const stopAllRuns = () => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.stopAll()
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Start a workflow from the composer.
   *
   * Everything typed after the name fills its first input, which is what `/feature add search` means.
   * A workflow that asks for more than one cannot be said on a single line, so it opens the launcher
   * instead of refusing — or, worse, starting with the rest of them empty (H-28).
   */
  const [launching, setLaunching] = createSignal<{ workflow: Workflow; args?: string }>()
  const runWorkflow = (name: string, launch: Partial<WorkflowLaunch>) =>
    createHarnessClient(app.connection.harnessServerUrl())
      .workflows.run(name, {
        ...(launch.inputs ? { inputs: launch.inputs } : {}),
        directory: app.sessions.modelLocation(),
        ...(launch.packs && launch.packs.length > 0 ? { packs: launch.packs } : {}),
        ...(launch.worktrees ? { worktrees: true } : {}),
        ...(launch.policy ? { policy: launch.policy } : {}),
        ...(launch.until ? { until: launch.until } : {}),
      })
      // Straight to the supervisor: a run nobody can see is the thing this replaces.
      .then(() => app.router.showScreen("runs"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const startWorkflow = (workflow: Workflow, args: string) => {
    if (workflow.inputs.length > 1) {
      app.composer.setPrompt("")
      setLaunching({ workflow, args })
      return
    }
    const first = workflow.inputs[0]
    if (first && !args.trim()) {
      toast(t("{name} needs {input}", { name: workflow.name, input: first }), "info")
      return
    }
    app.composer.setPrompt("")
    void runWorkflow(workflow.name, first ? { inputs: { [first]: args.trim() } } : {})
  }
  const launchBestOfN = (launch: BestOfNLaunch) => {
    app.router.setBestOfNOpen(false)
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.bestOfN({
        prompt: launch.prompt,
        models: launch.models,
        directory: app.sessions.modelLocation(),
        ...(launch.worktrees ? { worktrees: true } : {}),
      })
      .then((created) => {
        const [left, right] = created
        if (!left || !right) {
          app.router.showScreen("runs")
          return
        }
        app.router.setCompareArgs({ left: left.id, right: right.id })
        app.router.showScreen("compare", searchForCompare([left.id, right.id]))
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // The workflow editor (H-28): the file as written, saved back, and removed. Each one refreshes the
  // list, because a save can rename a workflow and a delete removes a row.
  const readWorkflowFile = (name: string) =>
    createHarnessClient(app.connection.harnessServerUrl()).workflows.get(name, app.sessions.modelLocation())
  const saveWorkflowFile = (
    name: string,
    input: { source: string; directory?: string; scope?: "project" | "global" },
  ) =>
    createHarnessClient(app.connection.harnessServerUrl())
      .workflows.save(name, input)
      .then((saved) => {
        void refetchWorkflows()
        return saved
      })
  const deleteWorkflowFile = (name: string) =>
    createHarnessClient(app.connection.harnessServerUrl())
      .workflows.remove(name, app.sessions.modelLocation())
      .then((removed) => {
        void refetchWorkflows()
        return removed
      })

  /** Everything the comparison needs about one run (H-33): itself, its tasks, and what they changed. */
  const compareSnapshot = async (id: string) => {
    const client = createHarnessClient(app.connection.harnessServerUrl())
    const [run, tasks, files] = await Promise.all([client.runs.get(id), client.runs.tasks(id), client.runs.files(id)])
    return runSnapshot(run, tasks, files)
  }

  const approveRun = (id: string, answer?: NearBudgetAnswer) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.approve(id, answer)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  // Each task of a worktree run wrote on its own branch (H-29); merging and cleaning up are the two
  // things a reader does with them once the run is over.
  const mergeWorktrees = (id: string) =>
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.mergeWorktrees(id)
      .then((result) => toast(t("Merged {n} worktrees", { n: result.merged.length }), "success"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  const cleanupWorktrees = (id: string) =>
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.cleanupWorktrees(id)
      .then((result) => toast(t("Removed {n} worktrees", { n: result.removed.length }), "success"))
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))

  /**
   * Do a task again (H-12). The server adds it as a new task of the same run, so the stream carries
   * it back like any other and nothing here has to guess where it goes.
   */
  const retryTask = (taskID: string, model?: { providerID: string; id: string; variant?: string }) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.retry(taskID, model ? { model } : {})
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Take a queued task off its run (HF-4). The stream carries the stopped row back like any
   * other change, so nothing here has to guess where it goes.
   */
  const cancelTask = (taskID: string) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.cancelTask(taskID)
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  /**
   * Pick up a run that failed, was stopped or lost its process (HF-5, RP-04), from a task or from
   * where it broke. Succeeded tasks stay as they are; the folder is put back first.
   */
  const resumeRun = (id: string, fromTask?: string) => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.resume(id, fromTask ? { fromTask } : {})
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  const resumePlan = (id: string, fromTask?: string) =>
    createHarnessClient(app.connection.harnessServerUrl()).runs.resumePlan(id, fromTask)

  /**
   * A run's checkpoints (CL-3): restoring one takes the folder and the task's conversation back
   * together, and forking from one starts a new run there, which is brought into view.
   */
  const runCheckpoints: RunCheckpointActions = {
    list: (runID) => createHarnessClient(app.connection.harnessServerUrl()).checkpoints.ofRun(runID),
    plan: (id) => createHarnessClient(app.connection.harnessServerUrl()).checkpoints.plan(id),
    restore: (id) =>
      createHarnessClient(app.connection.harnessServerUrl())
        .checkpoints.restore(id)
        .then((done) =>
          toast(t("Checkpoint restored"), "success", {
            description: t("Restored: {written} rewritten, {removed} deleted", {
              written: done?.plan.files.write.length ?? 0,
              removed: done?.plan.files.remove.length ?? 0,
            }),
          }),
        )
        .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error")),
    forkPlan: (id) => createHarnessClient(app.connection.harnessServerUrl()).checkpoints.forkPlan(id),
    fork: (id) =>
      createHarnessClient(app.connection.harnessServerUrl())
        .checkpoints.fork(id)
        .then((run) => {
          toast(t("Run forked"), "success")
          if (run) setRunFocus({ runID: run.id })
        })
        .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error")),
  }

  /**
   * Steer a running task by sending a message to its own session. The legacy runner absorbs a prompt
   * sent while a turn is going, so this is a steer and not a second turn (H-01, H-12).
   */
  const steerTask = (taskID: string, text: string) => {
    const run = runs().find((entry) => (entry.tasks ?? []).some((task) => task.id === taskID))
    const task = run?.tasks?.find((entry) => entry.id === taskID)
    if (!task?.sessionID) return
    void createClient(app.connection.serverUrl())
      .session.send({ sessionID: task.sessionID, ...(run?.directory ? { directory: run.directory } : {}), text })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const clearRuns = () => {
    void createHarnessClient(app.connection.harnessServerUrl())
      .runs.clear()
      .then(() => {
        setRuns(runs().filter((run) => run.status === "running"))
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const runRoutine = (id: string) => {
    if (routineBusy()) return
    void createHarnessClient(app.connection.harnessServerUrl())
      .routines.run(id)
      .then((run) => {
        setRoutineBusy(true)
        setRoutineBusyID(id)
        setRoutineRunID(run.id)
        void refreshRoutines()
      })
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }

  const stopRoutine = () => {
    const routineID = routineBusyID()
    const runID = routineRunID()
    if (!routineID || !runID) return
    void createHarnessClient(app.connection.harnessServerUrl())
      .routines.stop(routineID, runID)
      .then(() => void refreshRoutines())
      .catch((cause) => toast(cause instanceof Error ? cause.message : String(cause), "error"))
  }
  return {
    actionProfiles,
    addRoutine,
    approveRun,
    cancelTask,
    changeProjectUnattended,
    cleanupWorktrees,
    clearRuns,
    compareSnapshot,
    deleteWorkflowFile,
    harnessRefusal,
    launchBestOfN,
    launching,
    mergeWorktrees,
    projectUnattended,
    readWorkflowFile,
    refetchRunRequests,
    refreshRoutines,
    remoteRuns,
    removeRoutine,
    removeRun,
    resumePlan,
    resumeRun,
    runCheckpoints,
    retryTask,
    routineBusy,
    routineBusyID,
    routineFocus,
    routineProjects,
    routines,
    routinesAttention,
    routinesServerAvailable,
    routinesServerLoading,
    runArtifacts,
    runAttentionOf,
    runFocus,
    runRequests,
    runRoutine,
    runUsage,
    runWorkflow,
    runs,
    runsAttention,
    saveWorkflowFile,
    setLaunching,
    setRoutineFocus,
    setRunFocus,
    startWorkflow,
    steerTask,
    stopAllRuns,
    stopRoutine,
    stopRun,
    taskActivity,
    taskTools,
    toggleRoutine,
    touched,
    updateRoutine,
    workflowNamed,
    workflows,
    workflowsAvailable,
  }
}

export type RunsStore = ReturnType<typeof createRuns>
