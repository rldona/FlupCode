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
