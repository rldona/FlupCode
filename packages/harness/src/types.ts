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
  /** Kept in front of the rest, and never swept (H-14). */
  pinned?: boolean
  /** When it may be forgotten. Absent means never. */
  expiresAt?: number
}

/** A process written down, as the app reads it. Mirrors `harness-server`'s own type (H-21). */
export type Workflow = {
  name: string
  description: string
  /** The names it asks for. The launcher fills the first one with whatever was typed after it. */
  inputs: string[]
  tasks: Array<{ id: string; kind?: TaskKind; agent?: string; gate?: "human" }>
}

/**
 * How an MCP server is configured (H-25), widened to what the engine actually reads.
 *
 * Until now the form could only say a command or a URL, so the keys that make a server usable —
 * environment, working directory, headers, timeout, whether it starts at all — were only reachable
 * by hand-editing the config.
 */
export type McpLocalConfig = {
  type: "local"
  command: string[]
  cwd?: string
  environment?: Record<string, string>
  enabled?: boolean
  /** Milliseconds; the engine defaults to 5000. */
  timeout?: number
}

export type McpRemoteConfig = {
  type: "remote"
  url: string
  headers?: Record<string, string>
  enabled?: boolean
  timeout?: number
}

export type McpConfig = McpLocalConfig | McpRemoteConfig

export type StashedPrompt = {
  id: string
  text: string
  createdAt: number
}

/** What a reader keeps about a session that the engine does not (H-18): pins and tags. */
export type SessionPrefs = {
  sessionID: string
  pinned: boolean
  tags: string[]
  updatedAt: number
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
  /** Where the work happens. Sent by the server; used to open its checkpoints from the run view. */
  directory?: string
  sessionID?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  error?: string
  /** How long one tool call may run before the task is stopped (H-47). Declared, never invented. */
  toolLimitMs?: number
  /** This run was allowed to reach outside its project. Stated on screen, because it is unusual. */
  outside?: boolean
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

/** What a commit made by the harness server reports back (H-20). */
export type GitCommit = { sha: string; subject: string; branch: string }

/** How the checks on a pull request add up (H-20). */
export type CheckCounts = { total: number; passed: number; failed: number; running: number }

/** A check that did not pass, and enough to go and read why. */
export type FailedCheck = { name: string; workflow?: string; url: string; job?: string }

/** What a failing job printed, with the runner's scaffolding taken off. */
export type CheckLog = { job: string; step?: string; text: string; truncated: boolean }

export type PullRequest = {
  number: number
  title: string
  url: string
  state: "open" | "merged" | "closed"
  draft: boolean
  additions: number
  deletions: number
  checks: CheckCounts
  /** Named, because "2 failed" is where a reader gives up and opens a browser. */
  failures: FailedCheck[]
}

/** Where a folder's branch stands on GitHub. `available` is false when `gh` cannot answer. */
export type BranchState = {
  available: boolean
  branch: string
  repository?: string
  pushed: boolean
  /** The last commit's subject, which is what a new pull request is titled after. */
  subject?: string
  pullRequest?: PullRequest
  problem?: string
}

/** A way back to how a folder looked (H-15). The commit lives in your own repository. */
export type Checkpoint = {
  id: string
  directory: string
  sha: string
  title: string
  /** What the step that produced this point concluded, kept as a readable marker. */
  summary?: string
  runID?: string
  taskID?: string
  createdAt: number
}

/** What restoring would do, named before it does it. */
export type RestorePlan = { write: string[]; remove: string[] }

/** What a slice of the runs spent (H-16). */
export type Spend = { tasks: number; tokens: number; cost: number }

export type UsageReport = {
  totals: Spend & { runs: number; ms: number }
  /** Work done for the second time or later: paid twice, and invisible until it is split out. */
  retries: Spend
  byModel: Array<Spend & { key: string }>
  byAgent: Array<Spend & { key: string }>
  byProject: Array<Spend & { key: string; runs: number }>
  byDay: Array<{ day: string; tokens: number; cost: number }>
  slowest: Array<{ taskID: string; runID: string; name: string; ms: number }>
}

/** What a running task is doing right now (H-12), and for how long. */
export type TaskActivity = { taskID: string; tool?: string; detail?: string; waitingMs: number }

/** What one task of a run changed on disk, worked out from the checkpoints around it. */
export type TouchedFiles = {
  taskID?: string
  checkpointID: string
  title: string
  /** What the step concluded (H-15), kept so the run view can show the point's summary. */
  summary?: string
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>
}

/** A point anchored to a file and usually to a line: a review's (H-32) or a check's (H-22). */
export type Finding = {
  id: string
  directory?: string
  runID?: string
  taskID?: string
  file: string
  line?: number
  severity: "high" | "medium" | "low"
  title: string
  detail?: string
  /** A model's opinion, or a command that exited non-zero. Not the same claim. */
  source?: "review" | "check"
  resolved?: boolean
  createdAt: number
}

/**
 * An agent's file on disk (H-13).
 *
 * `fields` is its frontmatter exactly as it was written, unknown keys and all: the form edits what
 * it understands and puts the rest back untouched.
 */
export type AgentFile = {
  name: string
  path: string
  scope: "global" | "project"
  root: string
  fields: Record<string, unknown>
  prompt: string
  bytes: number
  /** Why this one cannot be saved from here: its frontmatter did not parse. */
  problem?: string
}

/**
 * A command's file on disk (H-25).
 *
 * `name` is what the engine calls it, which is its path under the command folder: a nested file is
 * a nested slash command (`git/release`). `template` is the body the arguments are filled into.
 */
export type CommandFile = {
  name: string
  path: string
  scope: "global" | "project"
  root: string
  fields: Record<string, unknown>
  template: string
  bytes: number
  /** Why this one cannot be saved from here: its frontmatter did not parse. */
  problem?: string
}

/**
 * A skill file on disk (H-27).
 *
 * `loaded` is the whole point: the engine drops a skill without a `name`, and one in a file not
 * called `SKILL.md`, without saying anything at all.
 */
export type SkillFile = {
  name?: string
  path: string
  scope: "global" | "project" | "claude" | "agents"
  root: string
  description?: string
  bytes: number
  loaded: boolean
  reason?: string
  /** The file that already has this name. */
  shadows?: string
}

/** An instruction file a turn in a folder would load (H-17). */
export type InstructionFile = {
  path: string
  scope: "global" | "project"
  bytes: number
  excerpt?: string
}

export type ContextReport = {
  directory: string
  projectDirectory?: string
  instructions: InstructionFile[]
  problem?: string
}

/** One system prompt as the engine handed it to the provider, recorded by FlupCode's engine plugin. */
export type CapturedPrompt = {
  at: number
  providerID?: string
  modelID?: string
  system: string[]
}

/** One completed tool call, with how long it took, as FlupCode's engine plugin recorded it (H-16). */
export type ToolCall = { tool: string; start?: number; ms?: number }

/** The tools a session ran, how often, and how long each call took, from FlupCode's engine plugin. */
export type ToolUses = {
  tools: Record<string, { count: number; last: number }>
  /** Completed calls, newest last. Empty in recordings made before calls were timed. */
  calls: ToolCall[]
}

/** One task's tool calls, for the run's timeline (H-16). */
export type TaskTools = {
  taskID: string
  name: string
  calls: ToolCall[]
}
