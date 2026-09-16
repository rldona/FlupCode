import { normalizeRoutineSchedule } from "./validation"
import type { RoutineCreateOptions, RoutineInput, RunStatus, TaskInput } from "./types"
import type { SqliteRoutineRepository } from "./repository"
import { RoutineBusyError, RoutineScheduler } from "./scheduler"
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

const taskFrom = (value: unknown): TaskInput | undefined => {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  if (typeof input.name !== "string" || !input.name.trim()) return undefined
  if (typeof input.prompt !== "string" || !input.prompt.trim()) return undefined
  return {
    name: input.name.trim(),
    prompt: input.prompt.trim(),
    agent: typeof input.agent === "string" && input.agent ? input.agent : undefined,
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
    if (path[1] === "health" && request.method === "GET") return json({ healthy: true })
    // Everything the server changes, in order, so a client follows along instead of asking.
    if (path[1] === "events" && request.method === "GET") return eventStream(repository, resumeFrom(request))
    // Runs, whatever asked for them. A routine's own are still under its own path.
    if (path[1] === "runs" && request.method === "GET" && !path[2]) return json({ data: repository.listRuns() })
    if (path[1] === "runs" && request.method === "POST" && !path[2]) {
      const body = (await readJSON(request)) as { tasks?: unknown; directory?: unknown } | undefined
      const tasks = Array.isArray(body?.tasks) ? body.tasks.map(taskFrom).filter((task) => !!task) : []
      if (tasks.length === 0) return error("A run needs at least one task with a name and a prompt", 400)
      const directory = typeof body?.directory === "string" && body.directory ? body.directory : undefined
      return json({ data: await scheduler.runTasks({ tasks, directory }) }, 202)
    }
    if (path[1] === "runs" && request.method === "GET" && path[2] && path[3] === "tasks") {
      return repository.getRun(path[2])
        ? json({ data: repository.listTasks(path[2]) })
        : error("Run not found", 404)
    }
    if (path[1] === "runs" && request.method === "GET" && path[2]) {
      const run = repository.getRun(path[2])
      return run ? json({ data: { ...run, tasks: repository.listTasks(run.id) } }) : error("Run not found", 404)
    }
    // Stopping and forgetting a run, whatever started it. A routine's runs answer here too: the
    // supervisor lists runs, not routines, and has only the run's id to act on.
    if (path[1] === "runs" && request.method === "POST" && path[2] === "stop" && !path[3]) {
      return json({ data: { stopped: await scheduler.stopAll() } })
    }
    if (path[1] === "runs" && request.method === "POST" && path[2] && path[3] === "stop") {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      return json({ data: (await scheduler.stopRun(run.id)) ?? run })
    }
    if (path[1] === "runs" && request.method === "DELETE" && !path[2]) {
      // Clearing the list is clearing what is over. A run still going is not history yet.
      return json({ data: { removed: repository.removeFinishedRuns().length } })
    }
    if (path[1] === "runs" && request.method === "DELETE" && path[2]) {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      // A running run is still being written to, and its lock still held: stop it first, then it
      // can go. Deleting it underneath the runner would leave tasks pointing at nothing.
      if (run.status === "running") return error("Stop the run before deleting it", 409)
      return json({ data: repository.removeRun(run.id) })
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
