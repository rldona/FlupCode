/**
 * The episode coordinator (FH-002).
 *
 * Two triggers write the same row per episode: the runner and the scheduler call in at their
 * terminal boundaries, and a sweep backstops the ones a restart or a lost hook would miss. All of
 * it is derived from what is already stored — the run, its tasks, the session's tool use — and it
 * never throws into a run: a failure to record is reported and dropped.
 *
 * Interactive sessions (AH-B03) have no terminal boundary of their own, so a second sweep closes
 * them on inactivity: the tool-uses plugin rewrites a session's file on every call, so the file's
 * age is how long the session has been quiet. Past `idleMs` its episode closes; work after that is a
 * new objective and a new episode. A session a run owns, or a subagent's child, is never one.
 */

import { existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { toolUsesDirectory, usedTools } from "../context"
import type { ToolUses } from "../context"
import type { SqliteRoutineRepository } from "../repository"
import type { Run, SessionEpisode, Task } from "../types"
import {
  DEFAULT_EPISODE_BOUNDARY_CONFIG,
  isTerminalRunStatus,
  runEpisodeID,
  sessionEpisodeID,
  shouldCheckpoint,
} from "./episode"
import type { EpisodeBoundaryConfig, EpisodeFailure, EpisodeVerification } from "./episode"
import { EVIDENCE_EPISODE_SLICE_LIMIT, EVIDENCE_OVERFLOW_CONTENT, evidenceCandidates } from "./evidence"
import type { EvidenceCandidate, EvidenceInput, EvidenceLink, EvidenceSlice } from "./evidence"
import { episodeEvents, failuresFromEvents } from "./events"
import type { EpisodeEvents } from "./events"
import { deriveOutcome } from "./outcome"
import { episodeEvidence, episodeSignals } from "./signals"
import type { EpisodeSignals } from "./signals"

/** How a session's tool use is read; injectable so a test touches no filesystem. */
export type EpisodeToolUses = (sessionID: string) => ToolUses

/** How a session's captured evidence is read; injectable so a test touches no filesystem. */
export type EpisodeSignalReader = (sessionID: string) => EpisodeSignals

/** How a session's engine events are read; injectable so a test touches no filesystem. */
export type EpisodeEventReader = (sessionID: string) => EpisodeEvents

/**
 * Where an episode's evidence goes (FH-006); injectable so a test never touches the real store.
 *
 * The members mirror the repository's own method names, so the repository is this store without an
 * adapter.
 */
export type EpisodeEvidenceStore = {
  putEvidence(input: EvidenceInput, now: number): EvidenceSlice | undefined
  setEpisodeEvidence(episodeID: string, links: EvidenceLink[], now: number): void
}

/** When a session last did something: the instant its tool-uses file was last written. */
export type SessionActivity = { sessionID: string; at: number }

/** How the sessions with recorded activity are listed; injectable so a test touches no filesystem. */
export type EpisodeSessionLister = () => SessionActivity[]

/** What the engine says about a session: where it ran, what it is called, whose child it is. */
export type SessionIdentity = { directory?: string; title?: string; parentID?: string; createdAt?: number }

/**
 * How a session is described; `undefined` means the engine does not know it, a rejection that it
 * could not be asked.
 */
export type EpisodeSessionDescriber = (sessionID: string) => Promise<SessionIdentity | undefined>

export type EpisodeCoordinatorDeps = {
  repository: SqliteRoutineRepository
  config?: Partial<EpisodeBoundaryConfig>
  now?: () => number
  readToolUses?: EpisodeToolUses
  readEpisodeSignals?: EpisodeSignalReader
  readEpisodeEvents?: EpisodeEventReader
  evidence?: EpisodeEvidenceStore
  onError?: (cause: unknown) => void
  /**
   * Called when an episode reaches a terminal state (FH-017).
   *
   * It is synchronous and its failure is swallowed, so the shadow trigger can never break the close
   * of an episode: the callback schedules work and returns.
   */
  onEpisodeClosed?: (episode: SessionEpisode) => void
  sweepLimit?: number
  /**
   * Whether interactive sessions are observed right now (AH-B03): the caller composes the adaptive
   * kill switch with `episode.interactive`. Read on every sweep and before every write, so either
   * switch applies without a restart. Absent means off: nothing is listed, described or written.
   */
  interactive?: () => boolean
  listSessionActivity?: EpisodeSessionLister
  /** Absent means no engine to ask: the episode is filed under `local` with a generic objective. */
  describeSession?: EpisodeSessionDescriber
}

export type EpisodeCoordinator = {
  captureRun(runID: string): SessionEpisode | undefined
  captureSession(input: { sessionID: string; runID?: string; directory?: string }): SessionEpisode | undefined
  sweep(): number
  /** Close the interactive sessions that went quiet; answers how many episodes it closed. */
  sweepSessions(): Promise<number>
  start(): void
  stop(): void
}

/** How many evidence refs an episode keeps: enough to trace it, not a second index. */
const EVIDENCE_REF_LIMIT = 50

/** How many sessions the sweep remembers having set aside before it starts over. */
const IGNORED_SESSION_LIMIT = 10_000

/**
 * Every session the tool-uses plugin has a file for, with the instant it was last written.
 *
 * The plugin writes the file when a call starts and when it ends, so its mtime is the session's last
 * activity. A name that is not an engine-shaped id is not a session and is skipped.
 */
export function sessionActivity(): SessionActivity[] {
  const directory = toolUsesDirectory()
  if (!existsSync(directory)) return []
  return readdirSync(directory).flatMap((name) => {
    const match = /^([A-Za-z0-9_-]+)\.json$/.exec(name)
    if (!match) return []
    const stat = statSync(join(directory, name), { throwIfNoEntry: false })
    return stat ? [{ sessionID: match[1]!, at: Math.floor(stat.mtimeMs) }] : []
  })
}

/** The sessions a run touched: its own thread, then each task's. */
const sessionIDsFor = (run: Run, tasks: Task[]): string[] =>
  [...new Set([run.sessionID, ...tasks.map((task) => task.sessionID)].filter((id): id is string => !!id))]

/** The session an episode is filed under: the run's, else the first task's, else the run itself. */
const primarySessionID = (run: Run, tasks: Task[]): string =>
  run.sessionID ?? tasks.find((task) => task.sessionID)?.sessionID ?? run.id

/** What the run's sessions spent, summed over every session it owns. */
const toolCallCount = (sessions: string[], readToolUses: EpisodeToolUses): number =>
  sessions.reduce((total, sessionID) => {
    const uses = readToolUses(sessionID)
    return total + Object.values(uses.tools).reduce((sum, entry) => sum + entry.count, 0)
  }, 0)

/** The tasks that did not succeed, as the failures the episode carries. */
const failuresFor = (tasks: Task[]): EpisodeFailure[] =>
  tasks
    .filter((task) => task.status === "failed" || task.status === "stopped")
    .map((task) => ({ summary: task.error ?? `Task failed: ${task.name}` }))

/** What the tasks already said, plus what the sessions' captured evidence found, without repeating it. */
const mergeFailures = (fromTasks: EpisodeFailure[], fromEvidence: EpisodeFailure[]): EpisodeFailure[] => {
  const seen = new Set<string>()
  return [...fromTasks, ...fromEvidence].filter((failure) => {
    const key = `${failure.file ?? ""}:${failure.line ?? 0}:${failure.summary}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Every check that produced a verdict and how it ended; a skipped check ran nothing to report. */
const verificationsFor = (tasks: Task[]): EpisodeVerification[] =>
  tasks
    .filter((task) => task.kind === "verify" && (task.status === "success" || task.status === "failed"))
    .map((task) => ({ step: task.name, ok: task.status === "success" }))

/** What the tasks were asked to do, or what asked for the run when nothing ran. */
const objectiveFor = (run: Run, tasks: Task[]): string => {
  const names = tasks.map((task) => task.name).join(" → ")
  if (names) return names.slice(0, 200)
  return run.source.type === "routine" ? "Routine run" : "Manual run"
}

/** The refs that let a reader walk back from the episode to what it was made of. */
const evidenceRefsFor = (run: Run, tasks: Task[], sessions: string[], artifactIDs: string[]): string[] =>
  [
    `run:${run.id}`,
    ...tasks.map((task) => `task:${task.id}`),
    ...sessions.map((sessionID) => `session:${sessionID}`),
    ...artifactIDs.map((id) => `artifact:${id}`),
  ].slice(0, EVIDENCE_REF_LIMIT)

/**
 * The run's own anchors first, then what the outcome derived, without repeating and with room kept
 * for both: a long run may fill the limit, but a reading that has evidence to cite is never crowded
 * out by the anchors alone.
 */
const mergeRefs = (base: string[], derived: string[], limit = EVIDENCE_REF_LIMIT): string[] => {
  const baseUnique = [...new Set(base)]
  const derivedUnique = [...new Set(derived)].filter((ref) => !baseUnique.includes(ref))
  const baseRoom = Math.max(0, limit - derivedUnique.length)
  return [...baseUnique.slice(0, baseRoom), ...derivedUnique].slice(0, limit)
}

/** Whether the previous capture is close enough to leave alone; `terminal` always writes. */
const checkpointWanted = (
  previous: SessionEpisode | undefined,
  toolCalls: number,
  terminal: boolean,
  cadenceCalls: number,
): boolean =>
  shouldCheckpoint({
    previous: previous ? { toolCalls: previous.toolCalls } : undefined,
    toolCalls,
    terminal,
    cadenceCalls,
  })

export function createEpisodeCoordinator(deps: EpisodeCoordinatorDeps): EpisodeCoordinator {
  const repository = deps.repository
  const config: EpisodeBoundaryConfig = { ...DEFAULT_EPISODE_BOUNDARY_CONFIG, ...deps.config }
  const now = deps.now ?? Date.now
  const readToolUses = deps.readToolUses ?? usedTools
  const readEpisodeSignals = deps.readEpisodeSignals ?? episodeSignals
  const readEpisodeEvents = deps.readEpisodeEvents ?? episodeEvents
  const store = deps.evidence ?? repository
  const onError = deps.onError ?? (() => {})
  const sweepLimit = deps.sweepLimit ?? 50
  const interactive = () => deps.interactive?.() ?? false
  const listSessionActivity = deps.listSessionActivity ?? sessionActivity
  const describeSession: EpisodeSessionDescriber = deps.describeSession ?? (async () => ({}))

  /**
   * The evidence the run's sessions left, relative to the run's directory.
   *
   * The raw signals and events come back beside the reading so the slices FH-006 keeps are the very
   * ones the failures were derived from, without reading the files a second time. With `since`, only
   * what happened after it counts: an interactive session's later episode does not repeat the
   * earlier one's evidence, and a signal with no start cannot be placed after anything.
   */
  const evidenceFor = (sessionIDs: string[], directory: string, since?: number) => {
    const signals = sessionIDs
      .flatMap((sessionID) => readEpisodeSignals(sessionID).calls)
      .filter((signal) => since === undefined || (signal.start !== undefined && signal.start > since))
    const events = sessionIDs
      .flatMap((sessionID) => readEpisodeEvents(sessionID).events)
      .filter((event) => since === undefined || event.at > since)
    const evidence = episodeEvidence(signals, directory)
    const fromEvents = failuresFromEvents(events)
    return { ...evidence, failures: mergeFailures(evidence.failures, fromEvents), signals, events }
  }

  /**
   * Keep the slices an episode offered, after the episode itself is stored (FH-006).
   *
   * The cap is stated: past the limit the episode gets an explicit overflow marker instead of
   * silently dropping the rest. A store that fails loses evidence, never the episode.
   */
  const recordEvidence = (episodeID: string, candidates: EvidenceCandidate[]): void => {
    try {
      const at = now()
      const links: EvidenceLink[] = candidates
        .slice(0, EVIDENCE_EPISODE_SLICE_LIMIT)
        .flatMap((candidate, position) => {
          const slice = store.putEvidence(candidate, at)
          if (!slice) return []
          return [
            {
              hash: slice.hash,
              kind: candidate.kind,
              ...(candidate.source ? { source: candidate.source } : {}),
              position,
            },
          ]
        })
      if (candidates.length > EVIDENCE_EPISODE_SLICE_LIMIT) {
        const overflow = store.putEvidence({ content: EVIDENCE_OVERFLOW_CONTENT }, at)
        if (overflow) links.push({ hash: overflow.hash, kind: "overflow", position: EVIDENCE_EPISODE_SLICE_LIMIT })
      }
      store.setEpisodeEvidence(episodeID, links, at)
    } catch (cause) {
      onError(cause)
    }
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let sweeping = false
  let sweepingSessions = false
  // Sessions the sweep set aside (a subagent's child, one the engine does not know), by the activity
  // they were judged at: new activity judges them again, the same activity is not asked twice.
  const ignored = new Map<string, number>()

  /**
   * The shadow trigger, wrapped so no failure in it can reach the caller that closed the episode.
   *
   * Only an episode with an `endedAt` is closed: the shadow and the learning sweeps read `endedAt` as
   * "closed", so a close without one would be acted on once and then never recognised again.
   */
  const notifyClosed = (episode: SessionEpisode): void => {
    if (episode.endedAt === undefined) return
    try {
      deps.onEpisodeClosed?.(episode)
    } catch (cause) {
      onError(cause)
    }
  }

  const writeRun = (runID: string): SessionEpisode | undefined => {
    const run = repository.getRun(runID)
    if (!run) return undefined
    const tasks = repository.listTasks(runID)
    const sessions = sessionIDsFor(run, tasks)
    const terminal = isTerminalRunStatus(run.status)
    const toolCalls = toolCallCount(sessions, readToolUses)
    const id = runEpisodeID(runID)
    const previous = repository.getEpisode(id)
    if (!checkpointWanted(previous, toolCalls, terminal, config.cadenceCalls)) return previous
    const evidence = evidenceFor(sessions, run.directory ?? "local")
    const verifications = verificationsFor(tasks)
    const failures = mergeFailures(failuresFor(tasks), evidence.failures)
    const reading = deriveOutcome({
      runStatus: run.status,
      verifications,
      failures,
      files: evidence.files,
      commands: evidence.commands,
    })
    const episode = repository.createEpisode(
      {
        id,
        sessionID: primarySessionID(run, tasks),
        projectID: run.directory ?? "local",
        runID,
        objective: objectiveFor(run, tasks),
        toolCalls,
        files: evidence.files,
        commands: evidence.commands,
        failures,
        verifications,
        outcome: reading.outcome,
        startedAt: run.startedAt,
        ...(terminal && run.finishedAt !== undefined ? { endedAt: run.finishedAt } : {}),
        evidenceRefs: mergeRefs(
          evidenceRefsFor(
            run,
            tasks,
            sessions,
            repository.listArtifacts({ runID }).map((artifact) => artifact.id),
          ),
          reading.evidenceRefs,
        ),
      },
      now(),
    )
    recordEvidence(episode.id, evidenceCandidates(evidence.signals, evidence.events))
    if (terminal) notifyClosed(episode)
    return episode
  }

  const captureRun = (runID: string): SessionEpisode | undefined => {
    try {
      return writeRun(runID)
    } catch (cause) {
      onError(cause)
      return undefined
    }
  }

  /** A session's closed interactive episodes, the latest close first. */
  const closedEpisodes = (sessionID: string): SessionEpisode[] =>
    repository
      .listEpisodes({ sessionID })
      .filter((episode) => episode.runID === undefined && episode.endedAt !== undefined)
      .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))

  /**
   * A live checkpoint of an interactive session's open episode. It is never a close: the session
   * sweep closes it once the session goes quiet.
   */
  const writeSession = (input: {
    sessionID: string
    runID?: string
    directory?: string
  }): SessionEpisode | undefined => {
    // A session that belongs to a run is the run's episode, never an episode of its own.
    if (input.runID) return captureRun(input.runID)
    const closed = closedEpisodes(input.sessionID)
    const id = sessionEpisodeID(input.sessionID, closed.length + 1)
    const previous = repository.getEpisode(id)
    const toolCalls = Math.max(
      0,
      toolCallCount([input.sessionID], readToolUses) - closed.reduce((sum, episode) => sum + episode.toolCalls, 0),
    )
    if (!checkpointWanted(previous, toolCalls, false, config.cadenceCalls)) return previous
    const evidence = evidenceFor([input.sessionID], input.directory ?? "local", closed[0]?.endedAt)
    const reading = deriveOutcome({
      verifications: [],
      failures: evidence.failures,
      files: evidence.files,
      commands: evidence.commands,
    })
    const episode = repository.createEpisode(
      {
        id,
        sessionID: input.sessionID,
        projectID: input.directory ?? "local",
        objective: previous?.objective ?? "Interactive session",
        toolCalls,
        files: evidence.files,
        commands: evidence.commands,
        failures: evidence.failures,
        verifications: [],
        outcome: reading.outcome,
        // No run anchors it, so the first capture is the only start that can be stated; a later
        // checkpoint keeps it rather than moving the start forward.
        startedAt: previous?.startedAt ?? now(),
        evidenceRefs: mergeRefs([`session:${input.sessionID}`], reading.evidenceRefs),
      },
      now(),
    )
    recordEvidence(episode.id, evidenceCandidates(evidence.signals, evidence.events))
    return episode
  }

  /**
   * Close the episode an interactive session ran since its previous close (AH-B03).
   *
   * Its window is everything after the previous episode's `endedAt`: the calls, the signals and the
   * events in it, and the tool calls the earlier episodes did not count. It ends at the session's
   * last activity, so a retried close writes the same row.
   */
  const closeSession = (
    entry: SessionActivity & { closed: SessionEpisode[] },
    identity: SessionIdentity,
  ): SessionEpisode => {
    const since = entry.closed[0]?.endedAt
    const uses = readToolUses(entry.sessionID)
    const directory = identity.directory ?? "local"
    const evidence = evidenceFor([entry.sessionID], directory, since)
    const reading = deriveOutcome({
      verifications: [],
      failures: evidence.failures,
      files: evidence.files,
      commands: evidence.commands,
    })
    const firstCall = Math.min(
      ...uses.calls.flatMap((call) =>
        call.start !== undefined && (since === undefined || call.start > since) ? [call.start] : [],
      ),
    )
    // The first call in the window, else the session's own creation for its first episode.
    const startedAt = Number.isFinite(firstCall) ? firstCall : since === undefined ? identity.createdAt : undefined
    const episode = repository.createEpisode(
      {
        id: sessionEpisodeID(entry.sessionID, entry.closed.length + 1),
        sessionID: entry.sessionID,
        projectID: directory,
        objective: identity.title?.trim().slice(0, 200) || "Interactive session",
        toolCalls: Math.max(
          0,
          toolCallCount([entry.sessionID], () => uses) -
            entry.closed.reduce((sum, episode) => sum + episode.toolCalls, 0),
        ),
        files: evidence.files,
        commands: evidence.commands,
        failures: evidence.failures,
        verifications: [],
        outcome: reading.outcome,
        startedAt: Math.min(startedAt ?? entry.at, entry.at),
        endedAt: entry.at,
        evidenceRefs: mergeRefs([`session:${entry.sessionID}`], reading.evidenceRefs),
      },
      now(),
    )
    recordEvidence(episode.id, evidenceCandidates(evidence.signals, evidence.events))
    notifyClosed(episode)
    return episode
  }

  const captureSession = (input: {
    sessionID: string
    runID?: string
    directory?: string
  }): SessionEpisode | undefined => {
    try {
      return writeSession(input)
    } catch (cause) {
      onError(cause)
      return undefined
    }
  }

  const sweep = (): number => {
    if (sweeping) return 0
    sweeping = true
    try {
      const since = now() - config.backfillMs
      return repository
        .listRunsWithoutTerminalEpisode({ since, limit: sweepLimit })
        .reduce((count, run) => count + (captureRun(run.id) ? 1 : 0), 0)
    } catch (cause) {
      onError(cause)
      return 0
    } finally {
      sweeping = false
    }
  }

  /**
   * Close the interactive sessions that went quiet (AH-B03).
   *
   * A session is due once it has been idle for `idleMs`, was active inside the backfill window, no
   * run owns it, and no closed episode already covers its last activity. At most `sessionLimit` are
   * closed per sweep, newest first; the engine is asked about each only then. One the engine does not
   * know, or a subagent's child (its work is its parent's), is set aside until it is active again.
   * An engine that cannot be asked ends the sweep, and the next one tries again.
   */
  const sweepSessions = async (): Promise<number> => {
    if (sweepingSessions || !interactive()) return 0
    sweepingSessions = true
    try {
      const at = now()
      const recent = listSessionActivity().filter(
        (entry) =>
          entry.at <= at - config.idleMs &&
          entry.at >= at - config.backfillMs &&
          ignored.get(entry.sessionID) !== entry.at,
      )
      const owned = repository.sessionsOwnedByRuns(recent.map((entry) => entry.sessionID))
      const due = recent
        .filter((entry) => !owned.has(entry.sessionID))
        .toSorted((a, b) => b.at - a.at)
        .map((entry) => ({ ...entry, closed: closedEpisodes(entry.sessionID) }))
        .filter((entry) => entry.closed[0]?.endedAt === undefined || entry.closed[0].endedAt < entry.at)
        .slice(0, config.sessionLimit)
      if (ignored.size > IGNORED_SESSION_LIMIT) ignored.clear()
      let closed = 0
      for (const entry of due) {
        const identity = await describeSession(entry.sessionID)
        // Checked again after the wait: a kill switch thrown mid-sweep stops the next write.
        if (!interactive()) break
        if (!identity || identity.parentID) {
          ignored.set(entry.sessionID, entry.at)
          continue
        }
        closeSession(entry, identity)
        closed++
      }
      return closed
    } catch (cause) {
      onError(cause)
      return 0
    } finally {
      sweepingSessions = false
    }
  }

  const start = () => {
    if (timer) return
    sweep()
    void sweepSessions()
    timer = setInterval(() => {
      sweep()
      void sweepSessions()
    }, config.sweepMs)
    timer.unref()
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  return { captureRun, captureSession, sweep, sweepSessions, start, stop }
}
