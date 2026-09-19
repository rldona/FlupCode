import { normalizeRoutineSchedule } from "./validation"
import type {
  ArtifactInput,
  ArtifactKind,
  RoutineCreateOptions,
  RoutineInput,
  RunPolicy,
  RunStatus,
  TaskCondition,
  TaskInput,
} from "./types"
import type { SqliteRoutineRepository } from "./repository"
import { InvalidModelError, MissingInputsError, UnknownWorkflowError, RoutineBusyError, RoutineScheduler, CheckpointNotFoundError } from "./scheduler"
import { UnknownTaskError } from "./workflow"
import { externalActivity } from "./runner"
import { eventStream, resumeFrom } from "./stream"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, status: number) => json({ error: message }, status)

const inputFrom = (value: unknown): RoutineInput | undefined => {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  if (typeof input.name !== "string" || !input.name.trim()) return undefined
  if (typeof input.prompt !== "string" || !input.prompt.trim()) return undefined
  return {
    name: input.name.trim(),
    description: typeof input.description === "string" ? input.description.trim() : "",
    prompt: input.prompt.trim(),
    schedule: normalizeRoutineSchedule(input.schedule),
    projectDirectory: typeof input.projectDirectory === "string" && input.projectDirectory ? input.projectDirectory : undefined,
    agent: typeof input.agent === "string" && input.agent ? input.agent : undefined,
    model:
      input.model && typeof input.model === "object" && "providerID" in input.model && "id" in input.model &&
      typeof input.model.providerID === "string" && typeof input.model.id === "string"
        ? {
            providerID: input.model.providerID,
            id: input.model.id,
            variant: "variant" in input.model && typeof input.model.variant === "string" ? input.model.variant : undefined,
          }
        : undefined,
  }
}

/** A model and an optional variant, or nothing. Used by a manual retry to change model (H-12). */
const modelFrom = (value: unknown): TaskInput["model"] => {
  if (!value || typeof value !== "object") return undefined
  const model = value as Record<string, unknown>
  if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
  return {
    providerID: model.providerID,
    id: model.id,
    ...(typeof model.variant === "string" ? { variant: model.variant } : {}),
  }
}

const taskFrom = (value: unknown): TaskInput | undefined => {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  if (typeof input.name !== "string" || !input.name.trim()) return undefined
  const kind = input.kind === "verify" ? "verify" : input.kind === "external" ? "external" : "agent"
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : ""
  const command = typeof input.command === "string" ? input.command.trim() : ""
  // A verify task has nothing to say to a model, and an external one runs a command instead. A
  // prompt or a command requirement for either would only make callers invent one.
  if (kind === "agent" && !prompt) return undefined
  if (kind === "external" && !command) return undefined
  const model = modelFrom(input.model)
  return {
    name: input.name.trim(),
    prompt,
    kind,
    ...(kind === "external" && command ? { command } : {}),
    agent: typeof input.agent === "string" && input.agent ? input.agent : undefined,
    ...(model ? { model } : {}),
    ...(kind === "verify" ? { retries: retriesFrom(input.retries) } : {}),
    // The graph (H-28), when a caller builds one by hand rather than from a workflow file.
    ...(Array.isArray(input.dependsOn)
      ? { dependsOn: input.dependsOn.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) }
      : {}),
    ...(conditionFrom(input.when) ? { when: conditionFrom(input.when) } : {}),
    ...(typeof input.foreach === "string" && input.foreach.trim() ? { foreach: input.foreach.trim() } : {}),
  }
}

/** A `when` as it arrives over HTTP: a task name and the outcomes that let this one run (H-28). */
const conditionFrom = (value: unknown): TaskCondition | undefined => {
  if (!value || typeof value !== "object") return undefined
  const condition = value as { task?: unknown; is?: unknown }
  if (typeof condition.task !== "string" || !condition.task.trim()) return undefined
  const is = (Array.isArray(condition.is) ? condition.is : [condition.is]).filter(
    (entry): entry is TaskCondition["is"][number] =>
      entry === "success" || entry === "failed" || entry === "stopped" || entry === "skipped",
  )
  return is.length > 0 ? { task: condition.task.trim(), is } : undefined
}

/**
 * How a run spends (H-30), as it arrives from a caller.
 *
 * Everything is optional and anything unreadable is dropped rather than guessed at: a policy that
 * half-parsed into a budget nobody asked for would stop runs for the wrong reason.
 */
const policyFrom = (value: unknown): RunPolicy | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const input = value as { models?: unknown; fallback?: unknown; budget?: unknown }
  const models: Record<string, string> = {}
  if (input.models && typeof input.models === "object" && !Array.isArray(input.models)) {
    for (const [role, model] of Object.entries(input.models as Record<string, unknown>)) {
      if (typeof model === "string" && model.trim()) models[role] = model.trim()
    }
  }
  const rawBudget = input.budget && typeof input.budget === "object" && !Array.isArray(input.budget)
    ? (input.budget as { tokens?: unknown; cost?: unknown })
    : undefined
  const budget = rawBudget
    ? {
        ...(typeof rawBudget.tokens === "number" && rawBudget.tokens > 0 ? { tokens: Math.floor(rawBudget.tokens) } : {}),
        ...(typeof rawBudget.cost === "number" && rawBudget.cost > 0 ? { cost: rawBudget.cost } : {}),
      }
    : undefined
  const policy: RunPolicy = {
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(typeof input.fallback === "string" && input.fallback.trim() ? { fallback: input.fallback.trim() } : {}),
    ...(budget && Object.keys(budget).length > 0 ? { budget } : {}),
  }
  return Object.keys(policy).length > 0 ? policy : undefined
}

/**
 * How many attempts a failed check may ask for, at most.
 *
 * Every retry is a model turn and another round of the project's commands, so a number typed by
 * mistake — or by something generating this call — must not be able to spend an afternoon.
 */
export const MAX_RETRIES = 5

const retriesFrom = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return Math.min(MAX_RETRIES, Math.floor(value))
}

const KINDS: ArtifactKind[] = ["plan", "report", "verdict", "diff", "log", "file", "handoff", "screenshot"]

const artifactFrom = (value: unknown): ArtifactInput | undefined => {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  const kind = KINDS.find((known) => known === input.kind)
  const title = typeof input.title === "string" ? input.title.trim() : ""
  if (!kind || !title) return undefined
  const content = typeof input.content === "string" ? input.content : undefined
  const path = typeof input.path === "string" && input.path ? input.path : undefined
  // One or the other: an artifact that is neither its text nor a file is a title and nothing else.
  if (content === undefined && !path) return undefined
  const text = (name: string) => (typeof input[name] === "string" && input[name] ? (input[name] as string) : undefined)
  return {
    kind,
    title,
    // Anything arriving through the API was kept by a person, whatever produced it.
    producer: "user",
    ...(content !== undefined ? { content } : {}),
    ...(path ? { path } : {}),
    ...(text("mime") ? { mime: text("mime")! } : {}),
    ...(text("directory") ? { directory: text("directory")! } : {}),
    ...(text("runID") ? { runID: text("runID")! } : {}),
    ...(text("taskID") ? { taskID: text("taskID")! } : {}),
    ...(text("sessionID") ? { sessionID: text("sessionID")! } : {}),
  }
}

const createOptionsFrom = (value: unknown): RoutineCreateOptions => {
  if (!value || typeof value !== "object") return {}
  const input = value as Record<string, unknown>
  const runs = Array.isArray(input.runs)
    ? input.runs.flatMap((value) => {
        if (!value || typeof value !== "object") return []
        const run = value as Record<string, unknown>
        const status = run.status
        if (
          typeof run.id !== "string" ||
          typeof run.startedAt !== "number" ||
          (status !== "running" && status !== "success" && status !== "failed" && status !== "stopped")
        ) {
          return []
        }
        const importedStatus = status === "running" ? "failed" : status
        return [
          {
            id: run.id,
            sessionID: typeof run.sessionID === "string" ? run.sessionID : undefined,
            status: importedStatus as RunStatus,
            startedAt: run.startedAt,
            finishedAt: typeof run.finishedAt === "number" ? run.finishedAt : undefined,
            error:
              typeof run.error === "string"
                ? run.error
                : status === "running"
                  ? "Imported from a browser run that was no longer active"
                  : undefined,
          },
        ]
      })
    : undefined
  return {
    id: typeof input.id === "string" ? input.id : undefined,
    enabled: typeof input.enabled === "boolean" ? input.enabled : undefined,
    createdAt: typeof input.createdAt === "number" ? input.createdAt : undefined,
    lastRunAt: typeof input.lastRunAt === "number" ? input.lastRunAt : undefined,
    runs,
  }
}

const readJSON = async (request: Request) => {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

import { CAPABILITIES } from "./capabilities"
import { duration, listWorkflows, readWorkflow, removeWorkflow, saveWorkflow } from "./workflow"
import { AgentError, deleteAgentFile, listAgentFiles, writeAgentFile } from "./agents"
import { SkillError, deleteSkill, readSkill, skillReport, writeSkill } from "./skills"
import { CommandError, deleteCommandFile, listCommandFiles, writeCommandFile } from "./commands"
import { FileError, readProjectFile } from "./files"
import {
  GitError,
  branch as gitBranch,
  commit as gitCommit,
  currentBranch,
  discard as gitDiscard,
  mergeBranch,
  patchForCommit,
} from "./git"
import { branchState, checkLog, createPullRequest } from "./pr"
import { drop, planRestore, restore, take } from "./checkpoint"
import { filesPerTask } from "./touched"
import { registerPlans } from "./plans"
import { summarise } from "./usage"
import { FINDINGS_INSTRUCTION } from "./findings"
import { capturedPrompts, instructionsFor, readInstruction, usedTools } from "./context"

const splitPath = (request: Request) => new URL(request.url).pathname.split("/").filter(Boolean)

export const createHarnessHandler = (repository: SqliteRoutineRepository, scheduler: RoutineScheduler) =>
  async (request: Request) => {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      })
    }

    const path = splitPath(request)
    if (path[0] !== "harness") return error("Not found", 404)
    // Says what this server can answer, so a newer client does not ask an older one for routes it
    // does not have and leave a 404 in the console (H-18).
    if (path[1] === "health" && request.method === "GET") return json({ healthy: true, capabilities: [...CAPABILITIES] })
    // Everything the server changes, in order, so a client follows along instead of asking.
    if (path[1] === "events" && request.method === "GET") return eventStream(repository, resumeFrom(request))
    // Runs, whatever asked for them. A routine's own are still under its own path.
    if (path[1] === "runs" && request.method === "GET" && !path[2]) return json({ data: repository.listRuns() })
    if (path[1] === "runs" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as
        | {
            tasks?: unknown
            directory?: unknown
            toolLimit?: unknown
            outside?: unknown
            shell?: unknown
            packs?: unknown
            worktrees?: unknown
            policy?: unknown
          }
        | undefined
      const tasks = Array.isArray(body?.tasks) ? body.tasks.map(taskFrom).filter((task) => !!task) : []
      if (tasks.length === 0) {
        return error("A run needs at least one task with a name, and a prompt or a command unless it is a verify task", 400)
      }
      const directory = typeof body?.directory === "string" && body.directory ? body.directory : undefined
      // `toolLimit` is written the way a person writes it — "10m" — and read by the same parser the
      // workflow files use, so the two cannot drift (H-47).
      const toolLimitMs = duration(body?.toolLimit)
      // Context packs the run's tasks are given (H-31), by name.
      const packs = Array.isArray(body?.packs) ? body.packs.filter((name): name is string => typeof name === "string") : []
      const policy = policyFrom(body?.policy)
      return json(
        {
          data: await scheduler.runTasks({
            tasks,
            directory,
            ...(toolLimitMs ? { toolLimitMs } : {}),
            ...(body?.outside === true ? { outside: true } : {}),
            ...(body?.shell === false ? { shell: false } : {}),
            ...(packs.length > 0 ? { packs } : {}),
            ...(body?.worktrees === true ? { worktrees: true } : {}),
            ...(policy ? { policy } : {}),
          }),
        },
        202,
      )
    }
    // The same task on N models at once (H-44): one run each, so H-33's comparison can put any two
    // of them side by side. The models arrive as the keys a person types — provider/model.
    if (path[1] === "best-of-n" && request.method === "POST") {
      const body = (await readJSON(request)) as
        | {
            prompt?: unknown
            models?: unknown
            directory?: unknown
            packs?: unknown
            worktrees?: unknown
            policy?: unknown
          }
        | undefined
      const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : ""
      if (!prompt) return error("A best-of-n needs a task to run", 400)
      const models = Array.isArray(body?.models)
        ? body.models
            .filter((model): model is string => typeof model === "string")
            .map((model) => model.trim())
            .filter(Boolean)
        : []
      const unique = [...new Set(models)]
      // One is not a comparison: with a single model there is nothing to put side by side.
      if (unique.length < 2) return error("A best-of-n needs two models at least", 400)
      const directory = typeof body?.directory === "string" && body.directory ? body.directory : undefined
      const packs = Array.isArray(body?.packs) ? body.packs.filter((name): name is string => typeof name === "string") : []
      const policy = policyFrom(body?.policy)
      try {
        return json(
          {
            data: await scheduler.runBestOfN({
              prompt,
              models: unique,
              directory,
              ...(packs.length > 0 ? { packs } : {}),
              ...(body?.worktrees === true ? { worktrees: true } : {}),
              ...(policy ? { policy } : {}),
            }),
          },
          202,
        )
      } catch (cause) {
        if (cause instanceof InvalidModelError) return error(cause.message, 400)
        return error(cause instanceof Error ? cause.message : String(cause), 500)
      }
    }
    if (path[1] === "runs" && request.method === "GET" && path[2] && path[3] === "tasks") {
      return repository.getRun(path[2])
        ? json({ data: repository.listTasks(path[2]) })
        : error("Run not found", 404)
    }
    if (path[1] === "runs" && request.method === "GET" && path[2] && !path[3]) {
      const run = repository.getRun(path[2])
      return run ? json({ data: { ...run, tasks: repository.listTasks(run.id) } }) : error("Run not found", 404)
    }
    // Stopping and forgetting a run, whatever started it. A routine's runs answer here too: the
    // supervisor lists runs, not routines, and has only the run's id to act on.
    // What a run's tasks are doing right now (H-12). Asked for while somebody is looking, never
    // stored: it changes by the second, and on the event log it would drown everything else.
    if (path[1] === "runs" && request.method === "GET" && path[2] && path[3] === "activity") {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      const going = repository.listTasks(run.id).filter((task) => task.status === "running")
      const now = Date.now()
      const activity = (
        await Promise.all(
          going.map(async (task) => {
            // An external worker is a process this server holds, so what it printed is here (H-38).
            const live = externalActivity(task.id)
            if (live) {
              return { taskID: task.id, waitingMs: now - live.since, tool: live.tool, detail: live.tail }
            }
            if (!task.sessionID) return undefined
            const doing = await scheduler.engine.activity(task.sessionID, run.directory).catch(() => undefined)
            return {
              taskID: task.id,
              // Since the task started, when the engine will not say — still better than nothing.
              waitingMs: now - (doing?.since ?? task.startedAt ?? now),
              ...(doing ? { tool: doing.tool, detail: doing.detail } : {}),
            }
          }),
        )
      ).filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      return json({ data: activity })
    }
    // What each task of a run changed on disk (H-12), worked out from the checkpoints H-15 already
    // takes after every task: the difference between one and the last is exactly that task's work.
    if (path[1] === "runs" && request.method === "GET" && path[2] && path[3] === "files") {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      if (!run.directory) return json({ data: [] })
      return json({
        data: await filesPerTask(run.directory, repository.listCheckpoints({ runID: run.id }).reverse()),
      })
    }
    // What each task of a run spent its time on (H-16), from the calls FlupCode's engine plugin
    // timed. Read through the task's session, because that is what the plugin wrote against.
    if (path[1] === "runs" && request.method === "GET" && path[2] && path[3] === "tools") {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      const tasks = repository.listTasks(run.id)
      return json({
        data: tasks.map((task) => ({
          taskID: task.id,
          name: task.name,
          calls: task.sessionID ? usedTools(task.sessionID).calls : [],
        })),
      })
    }
    if (path[1] === "runs" && request.method === "POST" && path[2] === "stop" && !path[3]) {
      return json({ data: { stopped: await scheduler.stopAll() } })
    }
    if (path[1] === "runs" && request.method === "POST" && path[2] && path[3] === "stop") {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      return json({ data: (await scheduler.stopRun(run.id)) ?? run })
    }
    // Merging a run's worktrees into the folder it started from (H-29), one task at a time. Each
    // worktree is on its own branch, so this is a `--no-ff` merge per task, in run order.
    if (path[1] === "runs" && request.method === "POST" && path[2] && path[3] === "worktrees" && path[4] === "merge") {
      const run = repository.getRun(path[2])
      if (!run?.directory) return error("That run has no folder to merge into", 404)
      const tasks = repository
        .listTasks(run.id)
        .filter((task) => task.directory && task.directory !== run.directory)
        .sort((left, right) => left.position - right.position)
      const merged: Array<{ taskID: string; branch: string; sha: string }> = []
      try {
        for (const task of tasks) {
          const branch = await currentBranch(task.directory!)
          if (!branch) continue
          const result = await mergeBranch({
            directory: run.directory,
            branch,
            message: `Merge ${task.name} (worktree)`,
          })
          merged.push({ taskID: task.id, branch, sha: result.sha })
        }
        return json({ data: { merged } })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    // Removing a run's worktrees once they have been merged, or thrown away. The engine owns the
    // branch and the sandbox bookkeeping, so it does the removing.
    if (path[1] === "runs" && request.method === "POST" && path[2] && path[3] === "worktrees" && path[4] === "cleanup") {
      const run = repository.getRun(path[2])
      const tasks = repository
        .listTasks(path[2])
        .filter((task) => task.directory && task.directory !== run?.directory)
      const removed: string[] = []
      for (const task of tasks) {
        const ok = await scheduler.engine
          .removeWorktree({ directory: task.directory!, ...(run?.directory ? { project: run.directory } : {}) })
          .then(
            () => true,
            () => false,
          )
        if (ok) removed.push(task.directory!)
      }
      return json({ data: { removed } })
    }
    // Letting a run through the gate it stopped at (H-21). Refusing it is stopping it, which already
    // has an endpoint — there is no third answer to "carry on?".
    if (path[1] === "runs" && request.method === "POST" && path[2] && path[3] === "approve") {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      if (run.status !== "awaiting") return error("This run is not waiting at a gate", 409)
      const resumed = scheduler.approve(run.id)
      return resumed ? json({ data: resumed }) : error("This run is not waiting at a gate", 409)
    }
    // Picking up a run that ended with work still queued (HF-5).
    if (path[1] === "runs" && request.method === "POST" && path[2] && path[3] === "resume") {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      try {
        const resumed = scheduler.resume(run.id)
        return resumed ? json({ data: resumed }, 202) : error("Run not found", 404)
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : String(cause), 409)
      }
    }
    // Doing a task again (H-12), as a new task of the same run, optionally on another model.
    if (path[1] === "tasks" && request.method === "POST" && path[2] && path[3] === "retry") {
      if (!repository.getTask(path[2])) return error("Task not found", 404)
      const body = (await readJSON(request)) as { model?: unknown } | undefined
      try {
        const created = scheduler.retryTask(path[2], { model: modelFrom(body?.model) })
        return created ? json({ data: created }, 202) : error("Task not found", 404)
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : String(cause), 409)
      }
    }
    // Taking a queued task off the run (HF-4). Running work is stopped with the run, not alone.
    if (path[1] === "tasks" && request.method === "POST" && path[2] && path[3] === "cancel") {
      if (!repository.getTask(path[2])) return error("Task not found", 404)
      try {
        const cancelled = scheduler.cancelTask(path[2])
        return cancelled ? json({ data: cancelled }) : error("Task not found", 404)
      } catch (cause) {
        return error(cause instanceof Error ? cause.message : String(cause), 409)
      }
    }
    if (path[1] === "runs" && request.method === "DELETE" && !path[2]) {
      // Clearing the list is clearing what is over. A run still going is not history yet.
      return json({ data: { removed: repository.removeFinishedRuns().length } })
    }
    if (path[1] === "runs" && request.method === "DELETE" && path[2] && !path[3]) {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      // A running run is still being written to, and its lock still held: stop it first, then it
      // can go. Deleting it underneath the runner would leave tasks pointing at nothing. One held
      // at a gate is not finished either — it is waiting for an answer.
      if (run.status === "running" || run.status === "awaiting") return error("Stop the run before deleting it", 409)
      return json({ data: repository.removeRun(run.id) })
    }
    // Artifacts (H-14): what runs left behind, and what a person kept.
    if (path[1] === "artifacts" && request.method === "GET" && !path[2]) {
      const query = new URL(request.url).searchParams
      const directory = query.get("directory") ?? undefined
      // Plans the agent wrote live on disk and the harness never produced; index them while
      // somebody is looking at this folder's artifacts, which is when it is worth doing (H-14).
      if (directory) {
        try {
          registerPlans(repository, directory)
        } catch {
          // An unreadable plans folder is not a reason to fail the list.
        }
      }
      return json({
        data: repository.listArtifacts({
          directory,
          runID: query.get("runID") ?? undefined,
          kind: (query.get("kind") as ArtifactKind | null) ?? undefined,
          q: query.get("q") ?? undefined,
        }),
      })
    }
    if (path[1] === "artifacts" && request.method === "POST" && !path[2]) {
      const input = artifactFrom(await readJSON(request))
      if (!input) return error("An artifact needs a kind, a title, and content or a path", 400)
      return json({ data: repository.addArtifact(input) }, 201)
    }
    if (path[1] === "artifacts" && request.method === "GET" && path[2] && !path[3]) {
      const artifact = repository.getArtifact(path[2])
      return artifact ? json({ data: artifact }) : error("Artifact not found", 404)
    }
    // One artifact as Markdown or JSON, for downloading or linking (HF-7).
    if (path[1] === "artifacts" && request.method === "GET" && path[2] && path[3] === "export") {
      const artifact = repository.getArtifact(path[2])
      if (!artifact) return error("Artifact not found", 404)
      const format = new URL(request.url).searchParams.get("format") ?? "md"
      if (format !== "md" && format !== "json") return error("format is md or json", 400)
      if (format === "json") return json({ data: artifact })
      const when = new Date(artifact.createdAt).toISOString()
      const body = [`# ${artifact.title}`, "", `${artifact.kind} · kept ${when}`, "", artifact.content ?? ""].join("\n")
      return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8" } })
    }
    // Keeping one in front, or saying when it may be forgotten (H-14). Both change the same row.
    if (path[1] === "artifacts" && request.method === "PATCH" && path[2] && !path[3]) {
      if (!repository.getArtifact(path[2])) return error("Artifact not found", 404)
      const body = (await readJSON(request)) as { pinned?: unknown; expiresAt?: unknown } | undefined
      if (typeof body?.pinned === "boolean") repository.setArtifactPinned(path[2], body.pinned)
      if (body && "expiresAt" in body) {
        const expiresAt = typeof body.expiresAt === "number" && body.expiresAt > 0 ? body.expiresAt : undefined
        repository.setArtifactRetention(path[2], expiresAt)
      }
      const artifact = repository.getArtifact(path[2])
      return artifact ? json({ data: artifact }) : error("Artifact not found", 404)
    }
    if (path[1] === "artifacts" && request.method === "DELETE" && path[2] && !path[3]) {
      return repository.removeArtifact(path[2]) ? json({ data: true }) : error("Artifact not found", 404)
    }
    // What a reader kept about a session (H-18): pins and tags, which the engine's session list
    // does not carry back, so they live here and travel to every device that reads this server.
    if (path[1] === "session-prefs" && request.method === "GET" && !path[2]) {
      return json({ data: repository.listSessionPrefs() })
    }
    if (path[1] === "session-prefs" && request.method === "PATCH" && path[2] && !path[3]) {
      const body = (await readJSON(request)) as { pinned?: unknown; tags?: unknown } | undefined
      let prefs = repository.getSessionPrefs(path[2])
      if (typeof body?.pinned === "boolean") prefs = repository.setSessionPinned(path[2], body.pinned)
      if (Array.isArray(body?.tags)) {
        const tags = body.tags.filter((tag): tag is string => typeof tag === "string")
        prefs = repository.setSessionTags(path[2], tags)
      }
      return json({ data: prefs ?? { sessionID: path[2], pinned: false, tags: [], updatedAt: Date.now() } })
    }
    // Prompts set aside, so they are there on any device (H-18).
    if (path[1] === "stash" && request.method === "GET" && !path[2]) {
      return json({ data: repository.listStash() })
    }
    if (path[1] === "stash" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as { text?: unknown } | undefined
      const text = typeof body?.text === "string" ? body.text.trim() : ""
      if (!text) return error("A prompt to stash is required", 400)
      return json({ data: repository.addToStash(text) }, 201)
    }
    if (path[1] === "stash" && request.method === "DELETE" && path[2] && !path[3]) {
      return repository.removeFromStash(path[2]) ? json({ data: true }) : error("Stashed prompt not found", 404)
    }
    // Context packs (H-26): named sets of references to pull back into a prompt.
    if (path[1] === "packs" && request.method === "GET" && !path[2]) {
      const directory = new URL(request.url).searchParams.get("directory") ?? undefined
      return json({ data: repository.listPacks(directory) })
    }
    if (path[1] === "packs" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as
        | { name?: unknown; refs?: unknown; directory?: unknown }
        | undefined
      const name = typeof body?.name === "string" ? body.name.trim() : ""
      if (!name) return error("A pack needs a name", 400)
      const refs = Array.isArray(body?.refs) ? body.refs.filter((ref): ref is string => typeof ref === "string") : []
      if (refs.length === 0) return error("A pack needs at least one reference", 400)
      return json(
        {
          data: repository.savePack({
            name,
            refs,
            ...(typeof body?.directory === "string" ? { directory: body.directory } : {}),
          }),
        },
        201,
      )
    }
    if (path[1] === "packs" && request.method === "DELETE" && path[2] && !path[3]) {
      return repository.removePack(path[2]) ? json({ data: true }) : error("Pack not found", 404)
    }
    // A conversation kept here so a link can read it (H-35). Markdown, because that is what the
    // reader made; the link serves it, so the harness is the host and not the engine's remote.
    if (path[1] === "shares" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as { title?: unknown; markdown?: unknown } | undefined
      const markdown = typeof body?.markdown === "string" ? body.markdown : ""
      if (!markdown.trim()) return error("A conversation to share is required", 400)
      const share = repository.saveShare({ title: typeof body?.title === "string" ? body.title : "", markdown })
      return json({ data: { id: share.id, title: share.title, url: `/harness/shares/${share.id}` } }, 201)
    }
    if (path[1] === "shares" && request.method === "GET" && path[2] && !path[3]) {
      const share = repository.getShare(path[2])
      if (!share) return error("Not found", 404)
      return new Response(share.markdown, {
        headers: { "content-type": "text/markdown; charset=utf-8" },
      })
    }
    // A project's notes (H-37), the harness's own and not the engine's per-session memory.
    if (path[1] === "memory" && request.method === "GET" && !path[2]) {
      const directory = new URL(request.url).searchParams.get("directory") ?? ""
      if (!directory) return error("A folder is required", 400)
      return json({ data: repository.listProjectMemory(directory) })
    }
    if (path[1] === "memory" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as { directory?: unknown; text?: unknown } | undefined
      const directory = typeof body?.directory === "string" ? body.directory : ""
      const text = typeof body?.text === "string" ? body.text.trim() : ""
      if (!directory) return error("A folder is required", 400)
      if (!text) return error("A note is required", 400)
      return json({ data: repository.addProjectMemory({ directory, text }) }, 201)
    }
    if (path[1] === "memory" && request.method === "DELETE" && path[2] && !path[3]) {
      return repository.removeProjectMemory(path[2]) ? json({ data: true }) : error("Note not found", 404)
    }
    // What the runs cost (H-16). Only runs: the harness never sees an ordinary chat turn, and
    // adding the engine's session totals on top would count every task twice.
    if (path[1] === "usage" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const days = Number(params.get("days"))
      const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 86_400_000 : undefined
      return json({
        data: summarise(
          repository.usageRows({ directory: params.get("directory") ?? undefined, since }),
        ),
      })
    }

    // What the model was given (H-17): which instruction files a turn in this folder would load.
    // Read from disk by the engine's own rules, because the engine does not report them.
    if (path[1] === "context" && request.method === "GET" && !path[2]) {
      const params = new URL(request.url).searchParams
      const directory = params.get("directory") ?? ""
      if (!directory) return error("A folder is required", 400)
      return json({ data: instructionsFor(directory, params.get("project") ?? undefined) })
    }
    if (path[1] === "context" && path[2] === "file" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const directory = params.get("directory") ?? ""
      const wanted = params.get("path") ?? ""
      if (!directory || !wanted) return error("A folder and a path are required", 400)
      // Only a file this folder would actually load. The path arrives from a browser, and reading
      // whatever it asks for would make this a file server.
      const report = instructionsFor(directory, params.get("project") ?? undefined)
      const content = readInstruction(report, wanted)
      return content === undefined ? error("Not one of this folder's instruction files", 404) : json({ data: { content } })
    }
    // The system prompt the engine assembled, recorded by FlupCode's engine plugin as it went out.
    // The engine has no endpoint for it: it is built at request time and handed straight to the provider.
    if (path[1] === "context" && path[2] === "system-prompt" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const sessionID = params.get("sessionID") ?? ""
      if (!sessionID) return error("A session is required", 400)
      return json({ data: capturedPrompts(sessionID) })
    }
    // The tools that session ran. The engine reports no list of what an MCP server offers, only the
    // calls it makes, which its plugin writes down.
    if (path[1] === "context" && path[2] === "tool-uses" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const sessionID = params.get("sessionID") ?? ""
      if (!sessionID) return error("A session is required", 400)
      return json({ data: usedTools(sessionID) })
    }

    // Agents you can edit (H-13). The engine reports what agents exist; these are the files behind
    // the ones that have one, which is what an editor can actually change.
    if (path[1] === "agents" && request.method === "GET" && !path[2]) {
      const params = new URL(request.url).searchParams
      return json({
        data: listAgentFiles(params.get("directory") ?? undefined, params.get("project") ?? undefined),
      })
    }
    if (path[1] === "agents" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as
        | { name?: unknown; scope?: unknown; fields?: unknown; prompt?: unknown; directory?: unknown; project?: unknown }
        | undefined
      const name = typeof body?.name === "string" ? body.name.trim() : ""
      const scope = body?.scope === "global" ? "global" : "project"
      const fields = body?.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
        ? (body.fields as Record<string, unknown>)
        : {}
      const prompt = typeof body?.prompt === "string" ? body.prompt : ""
      const directory = typeof body?.directory === "string" ? body.directory : undefined
      const project = typeof body?.project === "string" ? body.project : undefined
      try {
        const written = writeAgentFile({ name, scope, fields, prompt }, directory, project)
        return json({ data: { path: written } })
      } catch (cause) {
        if (cause instanceof AgentError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "agents" && request.method === "DELETE" && !path[2]) {
      const params = new URL(request.url).searchParams
      const wanted = params.get("path") ?? ""
      if (!wanted) return error("A path is required", 400)
      try {
        deleteAgentFile(wanted, params.get("directory") ?? undefined, params.get("project") ?? undefined)
        return json({ data: { removed: true } })
      } catch (cause) {
        if (cause instanceof AgentError) return error(cause.message, cause.status)
        throw cause
      }
    }

    // Skills (H-27): what is on disk, and — the point of the screen — what the engine would not load
    // and why. Two of the three ways a skill fails look identical from the outside: nothing happens.
    if (path[1] === "skills" && request.method === "GET" && !path[2]) {
      const params = new URL(request.url).searchParams
      return json({ data: skillReport(params.get("directory") ?? undefined, params.get("project") ?? undefined) })
    }
    if (path[1] === "skills" && path[2] === "file" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const wanted = params.get("path") ?? ""
      if (!wanted) return error("A path is required", 400)
      const content = readSkill(wanted, params.get("directory") ?? undefined, params.get("project") ?? undefined)
      return content === undefined ? error("Not one of this project's skill files", 404) : json({ data: { content } })
    }
    if (path[1] === "skills" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as
        | { name?: unknown; scope?: unknown; description?: unknown; body?: unknown; directory?: unknown; project?: unknown }
        | undefined
      try {
        const written = writeSkill(
          {
            name: typeof body?.name === "string" ? body.name.trim() : "",
            scope: body?.scope === "global" ? "global" : "project",
            description: typeof body?.description === "string" ? body.description : "",
            body: typeof body?.body === "string" ? body.body : "",
          },
          typeof body?.directory === "string" ? body.directory : undefined,
          typeof body?.project === "string" ? body.project : undefined,
        )
        return json({ data: { path: written } })
      } catch (cause) {
        if (cause instanceof SkillError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "skills" && request.method === "DELETE" && !path[2]) {
      const params = new URL(request.url).searchParams
      const wanted = params.get("path") ?? ""
      if (!wanted) return error("A path is required", 400)
      try {
        deleteSkill(wanted, params.get("directory") ?? undefined, params.get("project") ?? undefined)
        return json({ data: { removed: true } })
      } catch (cause) {
        if (cause instanceof SkillError) return error(cause.message, cause.status)
        throw cause
      }
    }

    // Commands you can edit (H-25). Same shape as agents: the files behind the slash commands the
    // engine already lists, so writing one here shows up in the palette without anything else.
    if (path[1] === "commands" && request.method === "GET" && !path[2]) {
      const params = new URL(request.url).searchParams
      return json({
        data: listCommandFiles(params.get("directory") ?? undefined, params.get("project") ?? undefined),
      })
    }
    if (path[1] === "commands" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as
        | {
            name?: unknown
            scope?: unknown
            fields?: unknown
            template?: unknown
            directory?: unknown
            project?: unknown
          }
        | undefined
      const name = typeof body?.name === "string" ? body.name.trim() : ""
      const scope = body?.scope === "global" ? "global" : "project"
      const fields =
        body?.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
          ? (body.fields as Record<string, unknown>)
          : {}
      const template = typeof body?.template === "string" ? body.template : ""
      const directory = typeof body?.directory === "string" ? body.directory : undefined
      const project = typeof body?.project === "string" ? body.project : undefined
      try {
        const written = writeCommandFile({ name, scope, fields, template }, directory, project)
        return json({ data: { path: written } })
      } catch (cause) {
        if (cause instanceof CommandError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "commands" && request.method === "DELETE" && !path[2]) {
      const params = new URL(request.url).searchParams
      const wanted = params.get("path") ?? ""
      if (!wanted) return error("A path is required", 400)
      try {
        deleteCommandFile(wanted, params.get("directory") ?? undefined, params.get("project") ?? undefined)
        return json({ data: { removed: true } })
      } catch (cause) {
        if (cause instanceof CommandError) return error(cause.message, cause.status)
        throw cause
      }
    }

    // Files to look at (H-19). The engine lists and finds; this is the one that reads the text,
    // confined to the folder and capped, because a viewer is not a download.
    if (path[1] === "files" && path[2] === "read" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const directory = params.get("directory") ?? ""
      if (!directory) return error("A folder is required", 400)
      const file = params.get("path") ?? ""
      if (!file) return error("A path is required", 400)
      try {
        return json({ data: readProjectFile({ directory, path: file }) })
      } catch (cause) {
        if (cause instanceof FileError) return error(cause.message, cause.status)
        throw cause
      }
    }

    // Findings (H-32): a review's points, anchored to a file and a line so the diff can carry them.
    if (path[1] === "findings" && request.method === "GET" && !path[2]) {
      const params = new URL(request.url).searchParams
      return json({
        data: repository.listFindings({
          directory: params.get("directory") ?? undefined,
          runID: params.get("runID") ?? undefined,
          ...(params.get("open") === "1" ? { resolved: false } : {}),
        }),
      })
    }
    if (path[1] === "findings" && path[2] && path[3] === "resolved" && request.method === "PATCH") {
      const body = (await readJSON(request)) as { resolved?: unknown } | undefined
      const finding = repository.resolveFinding(path[2], body?.resolved !== false)
      return finding ? json({ data: finding }) : error("Finding not found", 404)
    }

    // Checkpoints (H-15): a way back from what a run did.
    if (path[1] === "checkpoints" && request.method === "GET" && !path[2]) {
      const params = new URL(request.url).searchParams
      return json({
        data: repository.listCheckpoints({
          directory: params.get("directory") ?? undefined,
          runID: params.get("runID") ?? undefined,
        }),
      })
    }
    if (path[1] === "checkpoints" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as { directory?: unknown; title?: unknown } | undefined
      const directory = typeof body?.directory === "string" ? body.directory : ""
      if (!directory) return error("A folder is required", 400)
      try {
        const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim() : "Checkpoint"
        return json({ data: repository.addCheckpoint(await take({ directory, title })) })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    // What restoring would do. Asked for first, and shown, because restoring deletes files.
    if (path[1] === "checkpoints" && path[2] && path[3] === "plan" && request.method === "GET") {
      const checkpoint = repository.getCheckpoint(path[2])
      if (!checkpoint) return error("Checkpoint not found", 404)
      try {
        return json({ data: await planRestore(checkpoint.directory, checkpoint.sha) })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "checkpoints" && path[2] && path[3] === "restore" && request.method === "POST") {
      const checkpoint = repository.getCheckpoint(path[2])
      if (!checkpoint) return error("Checkpoint not found", 404)
      try {
        const done = await restore({
          directory: checkpoint.directory,
          sha: checkpoint.sha,
          safetyTitle: `Before restoring "${checkpoint.title}"`,
        })
        // Recorded like any other, so the way back from a restore is in the same list as the rest.
        return json({ data: { plan: done.plan, safety: repository.addCheckpoint(done.safety) } })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "checkpoints" && path[2] && !path[3] && request.method === "DELETE") {
      const checkpoint = repository.getCheckpoint(path[2])
      if (!checkpoint) return error("Checkpoint not found", 404)
      await drop(checkpoint.directory, checkpoint.id)
      return json({ data: repository.removeCheckpoint(checkpoint.id) })
    }

    // Git (H-20). The server is the only part of FlupCode that can run it: the client is a browser,
    // and the engine's `/vcs` routes read the tree but never write to it.
    if (path[1] === "git" && path[2] === "commit" && request.method === "POST") {
      const body = (await readJSON(request)) as
        | { directory?: unknown; message?: unknown; paths?: unknown; hunks?: unknown }
        | undefined
      const directory = typeof body?.directory === "string" ? body.directory : ""
      if (!directory) return error("A folder is required", 400)
      const message = typeof body?.message === "string" ? body.message : ""
      const paths = Array.isArray(body?.paths) ? body.paths.filter((value): value is string => typeof value === "string") : []
      // Per path, the hunk indices to stage; a path absent is staged whole.
      const hunks: Record<string, number[]> = {}
      if (body?.hunks && typeof body.hunks === "object" && !Array.isArray(body.hunks)) {
        for (const [file, value] of Object.entries(body.hunks as Record<string, unknown>)) {
          if (Array.isArray(value)) hunks[file] = value.filter((index): index is number => typeof index === "number")
        }
      }
      try {
        return json({ data: await gitCommit({ directory, message, paths, hunks }) })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    // Throws away a change, or the named hunks of one (H-20). The other direction from staging: the
    // reader looks at a diff and decides that this part of it should not have happened.
    if (path[1] === "git" && path[2] === "discard" && request.method === "POST") {
      const body = (await readJSON(request)) as { directory?: unknown; path?: unknown; hunks?: unknown } | undefined
      const directory = typeof body?.directory === "string" ? body.directory : ""
      if (!directory) return error("A folder is required", 400)
      const file = typeof body?.path === "string" ? body.path : ""
      if (!file) return error("A path is required", 400)
      const hunks = Array.isArray(body?.hunks)
        ? body.hunks.filter((index): index is number => typeof index === "number")
        : undefined
      try {
        return json({ data: await gitDiscard({ directory, path: file, hunks }) })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    // A commit message for the picked change, written by the engine in a session of its own (H-20).
    if (path[1] === "git" && path[2] === "message" && request.method === "POST") {
      const body = (await readJSON(request)) as
        | { directory?: unknown; paths?: unknown; hunks?: unknown }
        | undefined
      const directory = typeof body?.directory === "string" ? body.directory : ""
      if (!directory) return error("A folder is required", 400)
      const paths = Array.isArray(body?.paths) ? body.paths.filter((value): value is string => typeof value === "string") : []
      if (paths.length === 0) return error("Nothing was selected", 400)
      try {
        const diff = await patchForCommit({ directory, paths })
        if (!diff.trim()) return error("There is nothing to describe", 409)
        // Capped: a commit message is not worth an unbounded prompt, and a huge diff is a prompt the
        // model reads at a price the reader did not ask for.
        const message = await scheduler.engine.commitMessage({
          directory,
          diff: diff.length > 12_000 ? `${diff.slice(0, 12_000)}\n… (truncated)` : diff,
        })
        return message ? json({ data: { message } }) : error("The engine did not answer with a message", 502)
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "git" && path[2] === "branch" && request.method === "POST") {
      const body = (await readJSON(request)) as { directory?: unknown; name?: unknown } | undefined
      const directory = typeof body?.directory === "string" ? body.directory : ""
      if (!directory) return error("A folder is required", 400)
      try {
        return json({ data: await gitBranch({ directory, name: typeof body?.name === "string" ? body.name : "" }) })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    // Where the branch stands on GitHub: pushed or not, and its pull request with every check.
    // One `gh` call behind it, so a client may poll it while the checks are running and stop after.
    if (path[1] === "git" && path[2] === "pr" && !path[3] && request.method === "GET") {
      const directory = new URL(request.url).searchParams.get("directory") ?? ""
      if (!directory) return error("A folder is required", 400)
      return json({ data: await branchState(directory) })
    }
    // Why a check failed. A network call per job, so it is asked for rather than polled with the
    // rest: the chip says how many failed, and this says what they printed.
    if (path[1] === "git" && path[2] === "pr" && path[3] === "log" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const directory = params.get("directory") ?? ""
      const job = params.get("job") ?? ""
      if (!directory) return error("A folder is required", 400)
      try {
        return json({ data: await checkLog(directory, job) })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "git" && path[2] === "pr" && !path[3] && request.method === "POST") {
      const body = (await readJSON(request)) as
        | { directory?: unknown; title?: unknown; body?: unknown; base?: unknown; draft?: unknown }
        | undefined
      const directory = typeof body?.directory === "string" ? body.directory : ""
      if (!directory) return error("A folder is required", 400)
      try {
        return json({
          data: await createPullRequest({
            directory,
            title: typeof body?.title === "string" ? body.title : "",
            body: typeof body?.body === "string" ? body.body : undefined,
            base: typeof body?.base === "string" && body.base ? body.base : undefined,
            draft: body?.draft === true,
          }),
        })
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "git" && path[2] === "branch" && request.method === "GET") {
      const directory = new URL(request.url).searchParams.get("directory") ?? ""
      if (!directory) return error("A folder is required", 400)
      return json({ data: { branch: await currentBranch(directory) } })
    }

    // Workflows (H-21): the processes written down, and starting a run from one.
    if (path[1] === "workflows" && request.method === "GET" && !path[2]) {
      const directory = new URL(request.url).searchParams.get("directory") ?? undefined
      return json({ data: await listWorkflows(directory || undefined) })
    }
    // One workflow, as it is written on disk, for the editor (H-28).
    if (path[1] === "workflows" && request.method === "GET" && path[2]) {
      const directory = new URL(request.url).searchParams.get("directory") ?? undefined
      const found = await readWorkflow(decodeURIComponent(path[2]), directory || undefined)
      return found ? json({ data: found }) : error("Workflow not found", 404)
    }
    if (path[1] === "workflows" && request.method === "PUT" && path[2]) {
      const body = (await readJSON(request)) as
        | { source?: unknown; directory?: unknown; scope?: unknown }
        | undefined
      if (typeof body?.source !== "string") return error("A workflow is written as `source`", 400)
      const result = await saveWorkflow({
        name: decodeURIComponent(path[2]),
        source: body.source,
        directory: typeof body.directory === "string" && body.directory ? body.directory : undefined,
        scope: body.scope === "global" ? "global" : body.scope === "project" ? "project" : undefined,
      })
      return "problem" in result ? error(result.problem, 400) : json({ data: result.saved }, 201)
    }
    if (path[1] === "workflows" && request.method === "DELETE" && path[2]) {
      const directory = new URL(request.url).searchParams.get("directory") ?? undefined
      const removed = await removeWorkflow(decodeURIComponent(path[2]), directory || undefined)
      return removed ? json({ data: true }) : error("Workflow not found", 404)
    }
    if (path[1] === "workflows" && request.method === "POST" && path[2] && path[3] === "runs") {
      const body = (await readJSON(request)) as
        | { inputs?: unknown; directory?: unknown; packs?: unknown; worktrees?: unknown; policy?: unknown; until?: unknown; fromCheckpoint?: unknown }
        | undefined
      const inputs: Record<string, string> = {}
      if (body?.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)) {
        for (const [name, value] of Object.entries(body.inputs as Record<string, unknown>)) {
          if (typeof value === "string") inputs[name] = value
        }
      }
      const directory = typeof body?.directory === "string" && body.directory ? body.directory : undefined
      const packs = Array.isArray(body?.packs) ? body.packs.filter((name): name is string => typeof name === "string") : []
      const policy = policyFrom(body?.policy)
      try {
        const run = await scheduler.runWorkflow({
          name: decodeURIComponent(path[2]),
          inputs,
          directory,
          ...(packs.length > 0 ? { packs } : {}),
          ...(body?.worktrees === true ? { worktrees: true } : {}),
          ...(policy ? { policy } : {}),
          ...(typeof body?.until === "string" && body.until.trim() ? { until: body.until.trim() } : {}),
          ...(typeof body?.fromCheckpoint === "string" && body.fromCheckpoint.trim()
            ? { fromCheckpoint: body.fromCheckpoint.trim() }
            : {}),
        })
        return json({ data: run }, 202)
      } catch (cause) {
        if (cause instanceof UnknownWorkflowError) return error(cause.message, 404)
        if (cause instanceof MissingInputsError) return error(cause.message, 400)
        if (cause instanceof UnknownTaskError) return error(cause.message, 400)
        if (cause instanceof CheckpointNotFoundError) return error(cause.message, 404)
        return error(cause instanceof Error ? cause.message : String(cause), 500)
      }
    }
    if (path[1] !== "routines") return error("Not found", 404)

    const routineID = path[2]
    const action = path[3]
    const runID = path[4]

    if (!routineID && request.method === "GET") return json({ data: repository.list() })
    if (!routineID && request.method === "POST") {
      const body = await readJSON(request)
      const input = inputFrom(body)
      if (!input) return error("Invalid routine", 400)
      return json({ data: repository.create(input, createOptionsFrom(body)) }, 201)
    }
    if (!routineID) return error("Not found", 404)

    const routine = repository.get(routineID)
    if (!routine) return error("Routine not found", 404)

    if (action === "runs" && request.method === "GET") return json({ data: repository.listRuns({ type: "routine", routineID }) })
    if (action === "runs" && request.method === "POST" && !runID) {
      try {
        return json({ data: await scheduler.runNow(routineID) }, 202)
      } catch (cause) {
        if (cause instanceof RoutineBusyError) return error(cause.message, 409)
        return error(cause instanceof Error ? cause.message : String(cause), 500)
      }
    }
    if (action === "runs" && runID && path[5] === "stop" && request.method === "POST") {
      const run = repository.getRun(runID)
      if (!run || run.source.type !== "routine" || run.source.routineID !== routineID) return error("Run not found", 404)
      return json({ data: (await scheduler.stopRun(runID)) ?? repository.getRun(runID) })
    }
    if (action === "enabled" && request.method === "PATCH") {
      const body = await readJSON(request)
      if (!body || typeof body !== "object" || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
        return error("Invalid enabled value", 400)
      }
      repository.setEnabled(routineID, (body as { enabled: boolean }).enabled)
      return json({ data: repository.get(routineID) })
    }
    if (request.method === "PATCH") {
      const input = inputFrom(await readJSON(request))
      if (!input) return error("Invalid routine", 400)
      return json({ data: repository.update(routineID, input) })
    }
    if (request.method === "DELETE") {
      repository.remove(routineID)
      return json({ data: true })
    }
    if (request.method === "GET") return json({ data: routine })
    return error("Not found", 404)
  }
