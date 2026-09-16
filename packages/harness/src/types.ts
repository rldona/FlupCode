export type Attachment = {
  uri: string
  name: string
}

export type CommandOption = {
  name: string
  description?: string
  /** Shown but not runnable yet. */
  disabled?: boolean
}

/** What a run left behind, as the app reads it. Mirrors `harness-server`'s own type (H-14). */
export type ArtifactKind = "plan" | "report" | "verdict" | "diff" | "log" | "file" | "handoff"

export type Artifact = {
  id: string
  kind: ArtifactKind
  title: string
  producer: "agent" | "user" | "harness"
  mime: string
  createdAt: number
  content?: string
  path?: string
  directory?: string
  runID?: string
  taskID?: string
  sessionID?: string
  bytes?: number
  truncated?: boolean
  hash?: string
}

/** A process written down, as the app reads it. Mirrors `harness-server`'s own type (H-21). */
export type Workflow = {
  name: string
  description: string
  /** The names it asks for. The launcher fills the first one with whatever was typed after it. */
  inputs: string[]
  tasks: Array<{ id: string; kind?: TaskKind; agent?: string; gate?: "human" }>
}

export type McpConfig = { type: "local"; command: string[] } | { type: "remote"; url: string }

export type StashedPrompt = {
  id: string
  text: string
  createdAt: number
}

export type RoutineSchedule =
  | { type: "manual"; timezone?: string }
  | { type: "hourly"; timezone?: string }
  | { type: "daily"; time: string; timezone?: string }
  | { type: "weekdays"; time: string; timezone?: string }
  | { type: "weekly"; day: number; time: string; timezone?: string }
  | { type: "interval"; intervalMinutes: number; timezone?: string }

/** What asked for a run: a routine on its schedule, or a person pressing the button. */
export type RunSource = { type: "routine"; routineID: string } | { type: "manual" }

/** `awaiting` is a run stopped on purpose at a human gate, waiting to be let through (H-21). */
export type RunStatus = "running" | "awaiting" | "success" | "failed" | "stopped"

/** One execution the harness server owns, as the app reads it. Mirrors `harness-server`'s own type. */
export type Run = {
  id: string
  source: RunSource
  sessionID?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  error?: string
  /** Present when the run was asked for by id; the list leaves them out. */
  tasks?: Task[]
}

export type TaskStatus = "queued" | "running" | "success" | "failed" | "stopped"

/** What a task does: a turn of the engine, or the project's own checks (H-22). */
export type TaskKind = "agent" | "verify"

export type Task = {
  id: string
  runID: string
  position: number
  name: string
  prompt: string
  kind?: TaskKind
  /** Which attempt this is, from 1. A retry after a failed check is a new task (H-22). */
  attempt?: number
  /** The task this one attempts again. */
  retryOf?: string
  /** `human` holds the run here until somebody reads what it did and lets it through. */
  gate?: "human"
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  sessionID?: string
  status: TaskStatus
  startedAt?: number
  finishedAt?: number
  error?: string
  output?: string
  tokens?: number
  cost?: number
}

export type RoutineRun = {
  id: string
  source?: RunSource
  sessionID?: string
  status: "running" | "success" | "failed" | "stopped"
  startedAt: number
  finishedAt?: number
  error?: string
}

export type RoutineInput = {
  name: string
  description: string
  prompt: string
  schedule: RoutineSchedule
  projectDirectory?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}

export type Routine = {
  id: string
  name: string
  description: string
  prompt: string
  schedule: RoutineSchedule
  projectDirectory?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  runs: RoutineRun[]
}

export type ProjectItem = {
  id: string
  directory: string
  name: string
}
