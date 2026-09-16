export type RoutineSchedule =
  | { type: "manual"; timezone?: string }
  | { type: "hourly"; timezone?: string }
  | { type: "daily"; time: string; timezone?: string }
  | { type: "weekdays"; time: string; timezone?: string }
  | { type: "weekly"; day: number; time: string; timezone?: string }
  | { type: "interval"; intervalMinutes: number; timezone?: string }

export type RoutineInput = {
  name: string
  description: string
  prompt: string
  schedule: RoutineSchedule
  projectDirectory?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
}

export type RoutineRunStatus = "running" | "success" | "failed" | "stopped"

export type RoutineRun = {
  id: string
  routineID: string
  sessionID?: string
  status: RoutineRunStatus
  startedAt: number
  finishedAt?: number
  error?: string
}

export type Routine = RoutineInput & {
  id: string
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  runs: RoutineRun[]
}

export type RoutineCreateOptions = {
  id?: string
  enabled?: boolean
  createdAt?: number
  lastRunAt?: number
  runs?: Array<Omit<RoutineRun, "routineID">>
}

export type RoutineRepository = {
  list(): Routine[]
  get(id: string): Routine | undefined
  create(input: RoutineInput, options?: RoutineCreateOptions): Routine
  update(id: string, input: RoutineInput): Routine | undefined
  remove(id: string): boolean
  setEnabled(id: string, enabled: boolean): void
  listRuns(routineID: string): RoutineRun[]
  acquire(routineID: string, owner: string, now: number, ttl: number): boolean
  renew(routineID: string, owner: string, now: number, ttl: number): void
  release(routineID: string, owner: string): void
  startRun(routineID: string, now: number): RoutineRun | undefined
  attachSession(runID: string, sessionID: string): void
  finishRun(runID: string, status: Exclude<RoutineRunStatus, "running">, error?: string, now?: number): void
  getRun(runID: string): RoutineRun | undefined
  recoverRunning(now: number): void
}
