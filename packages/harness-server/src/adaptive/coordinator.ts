/**
 * The episode coordinator (FH-002).
 *
 * Two triggers write the same row per episode: the runner and the scheduler call in at their
 * terminal boundaries, and a sweep backstops the ones a restart or a lost hook would miss. All of
 * it is derived from what is already stored — the run, its tasks, the session's tool use — and it
 * never throws into a run: a failure to record is reported and dropped.
 */

import { usedTools } from "../context"
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

export type EpisodeCoordinatorDeps = {
  repository: SqliteRoutineRepository
  config?: Partial<EpisodeBoundaryConfig>
  now?: () => number
  readToolUses?: EpisodeToolUses
  readEpisodeSignals?: EpisodeSignalReader
  readEpisodeEvents?: EpisodeEventReader
  evidence?: EpisodeEvidenceStore
  onError?: (cause: unknown) => void
  sweepLimit?: number
}

export type EpisodeCoordinator = {
  captureRun(runID: string): SessionEpisode | undefined
  captureSession(input: { sessionID: string; runID?: string; directory?: string }): SessionEpisode | undefined
  sweep(): number
  start(): void
  stop(): void
}

/** How many evidence refs an episode keeps: enough to trace it, not a second index. */
const EVIDENCE_REF_LIMIT = 50

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

  /**
   * The evidence the run's sessions left, relative to the run's directory.
   *
   * The raw signals and events come back beside the reading so the slices FH-006 keeps are the very
   * ones the failures were derived from, without reading the files a second time.
   */
  const evidenceFor = (sessionIDs: string[], directory: string) => {
    const signals = sessionIDs.flatMap((sessionID) => readEpisodeSignals(sessionID).calls)
    const events = sessionIDs.flatMap((sessionID) => readEpisodeEvents(sessionID).events)
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

  const writeSession = (input: {
    sessionID: string
    runID?: string
    directory?: string
  }): SessionEpisode | undefined => {
    // A session that belongs to a run is the run's episode, never an episode of its own.
    if (input.runID) return captureRun(input.runID)
    const id = sessionEpisodeID(input.sessionID)
    const previous = repository.getEpisode(id)
    const toolCalls = toolCallCount([input.sessionID], readToolUses)
    if (!checkpointWanted(previous, toolCalls, false, config.cadenceCalls)) return previous
    const evidence = evidenceFor([input.sessionID], input.directory ?? "local")
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
        objective: "Session run",
        toolCalls,
        files: evidence.files,
        commands: evidence.commands,
        failures: evidence.failures,
        verifications: [],
        outcome: reading.outcome,
        // No run anchors it, so the capture instant is the only start that can be stated.
        startedAt: now(),
        evidenceRefs: mergeRefs([`session:${input.sessionID}`], reading.evidenceRefs),
      },
      now(),
    )
    recordEvidence(episode.id, evidenceCandidates(evidence.signals, evidence.events))
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

  const start = () => {
    if (timer) return
    sweep()
    timer = setInterval(() => {
      sweep()
    }, config.sweepMs)
    timer.unref()
  }

  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  return { captureRun, captureSession, sweep, start, stop }
}
