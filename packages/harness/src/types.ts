export type Attachment = {
  uri: string
  name: string
}

export type CommandOption = {
  name: string
  description?: string
  /** Shown but not runnable yet. */
  disabled?: boolean
  /** Where it comes from, painted as a badge in the `/` menu (SK-2). */
  source?: "builtin" | "command" | "skill" | "workflow"
  /** The heading it is listed under in the `/` menu. */
  group?: string
}

/** What a run left behind, as the app reads it. Mirrors `harness-server`'s own type (H-14). */
export type ArtifactKind =
  | "plan"
  | "report"
  | "verdict"
  | "diff"
  | "log"
  | "file"
  | "handoff"
  | "screenshot"
  /** A document the agent produced and kept (H-14): a page, a report, an image, a PDF. */
  | "document"

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
  /** The message whose turn wrote it (RP-03), when the engine's plugin said so. */
  messageID?: string
  /** The document this row is a version of (RP-03); absent from a server older than that. */
  logicalID?: string
  /** Which version of its document this is, from 1. */
  version?: number
  /** How many versions its document has, on a list. */
  versions?: number
}

/** A process written down, as the app reads it. Mirrors `harness-server`'s own type (H-21). */
/** How a run spends (H-30), as the launcher and the editor hand it over. */
export type RunPolicy = {
  models?: Record<string, string>
  fallback?: string
  /**
   * Stop and ask past these (UL-08): `cost` in USD, `tokens` as input, output and reasoning (no
   * cache). `softPct` warns once at that share of the limit.
   */
  budget?: { tokens?: number; cost?: number; softPct?: number }
  /** What a task does when it needs a person mid-turn (RP-05); absent, the project's default. */
  unattended?: Unattended
}

/** A task that needs a person mid-turn fails (`deny`) or holds its run until answered (`gate`) (RP-05). */
export type Unattended = "deny" | "gate"

export type Workflow = {
  name: string
  description: string
  /** The names it asks for. The launcher fills the first one with whatever was typed after it. */
  inputs: string[]
  /** Defaults so the launcher starts filled in (HF-2). */
  inputDefaults?: Record<string, string>
  /** One-line help per input (HF-2). */
  inputHelp?: Record<string, string>
  tasks: Array<{
    id: string
    kind?: TaskKind
    agent?: string
    /** The command an `external` task runs (H-38), with `{{prompt}}` for its prompt. */
    command?: string
    gate?: "human"
    /** The tasks it waits for (H-28); an empty list means it is a root. */
    dependsOn?: string[]
    /** `true` is the same as an empty `dependsOn`: it does not follow the task above it. */
    parallel?: boolean
    /** Run only if an earlier task ended a certain way (H-28). */
    when?: TaskCondition
    /** One task per step of the named task's plan; `{{item}}` is the step (H-28). */
    foreach?: string
  }>
  /** `worktrees: true` in the file — each writing task gets its own tree (HF-3). */
  worktrees?: boolean
}

/**
 * A workflow as it is written on disk (H-28), for the editor: the file's path and its text, not just
 * the shape the runner reads.
 */
export type WorkflowFile = {
  name: string
  scope: "project" | "global"
  path: string
  source: string
  workflow: Workflow
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
  /** `false` offers the server's tools one by one instead of through `execute` (OpenCode 2's default). */
  codemode?: boolean
}

export type McpRemoteConfig = {
  type: "remote"
  url: string
  headers?: Record<string, string>
  enabled?: boolean
  timeout?: number
  codemode?: boolean
}

export type McpConfig = McpLocalConfig | McpRemoteConfig

/** Where an MCP server is written: the global config file or the directory's own. */
export type McpScope = "global" | "project"

export type StashedPrompt = {
  id: string
  text: string
  createdAt: number
}

/** A context pack (H-26): a named set of references to pull back into a prompt. */
export type ContextPack = {
  id: string
  name: string
  refs: string[]
  /** The folder it belongs to; absent means every project. */
  directory?: string
  createdAt: number
}

/** One file's text, read to look at it (H-19). */
export type FileText = {
  path: string
  content: string
  bytes: number
  truncated: boolean
  binary: boolean
}

/** A note the harness keeps about a project (H-37). */
export type ProjectMemory = {
  id: string
  directory: string
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
  /** A five-field cron pattern, read in `timezone` like the other wall-clock schedules (RP-07). */
  | { type: "cron"; expression: string; timezone?: string }

/** A failed run tried again `count` times, the first after `backoffMinutes`, doubling each time (RP-07). */
export type RoutineRetry = { count: number; backoffMinutes: number }

/** What asked for a run: a routine on its schedule, or a person pressing the button. */
export type RunSource = { type: "routine"; routineID: string } | { type: "manual" }

/** `awaiting` is a run stopped on purpose at a human gate, waiting to be let through (H-21). */
export type RunStatus = "running" | "awaiting" | "success" | "failed" | "stopped"

/** One execution the harness server owns, as the app reads it. Mirrors `harness-server`'s own type. */
/** Which workflow produced a run, which version of its file and which inputs (RP-01). */
export type RunWorkflow = {
  name: string
  scope: "project" | "global"
  /** The sha256 of the file as it was at launch. */
  hash: string
  inputs: Record<string, string>
}

export type Run = {
  id: string
  source: RunSource
  /** The workflow this run executed, when one did; a routine that runs one has both (RP-01). */
  workflow?: RunWorkflow
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
  /** This run refused the shell: the engine hides the bash tool and denies every command (H-47). */
  shell?: boolean
  /** Context packs every task of this run is given (H-31), by name. */
  packs?: string[]
  /** Each writing task ran in its own worktree (H-29). */
  worktrees?: boolean
  /** How this run spends (H-30): a model per role, a fallback, and a budget. */
  policy?: RunPolicy
  /**
   * Why it is waiting: a person at a gate, a budget it reached, or a task's session asking a person
   * mid-turn (RP-05), answered in the engine rather than approved.
   */
  paused?: "gate" | "budget" | "request"
  /** Somebody let it past the budget. */
  budgetApproved?: boolean
  /** Which budget a run waiting at the budget gate reached (UL-08). */
  overBudget?: string
  /** The approval a scheduled web action ran under (WA-7). */
  allow?: BrowserAllowRule[]
  /** Present when the run was asked for by id; the list leaves them out. */
  tasks?: Task[]
  /**
   * How its work was judged (RP-06): the worst verdict among its tasks, naming the task. Derived by
   * the server from the tasks on every read, so it follows `run.changed`. Absent until a task is judged.
   */
  verdict?: RunVerdict
}

/**
 * Whether a task met its goal, judged by something other than the agent (RP-06), best to worst.
 * `verified` only comes from a check that ran; a clean answer nothing checked is `unverified`.
 */
export type VerdictValue = "verified" | "unverified" | "needs-user" | "failed"

export type TaskVerdict = {
  value: VerdictValue
  /** The agent's own words when it gave up or asked, or what the check or the auditor said. */
  reason: string
  /** A check that ran, the deterministic rule over the answer, or an auditor model. */
  source: "check" | "rule" | "model"
}

export type RunVerdict = TaskVerdict & { taskID: string }

export type TaskStatus = "queued" | "running" | "success" | "failed" | "stopped" | "skipped"

/** When a task is allowed to run, in terms of an earlier task's outcome (H-28). */
export type TaskCondition = {
  task: string
  is: Array<Exclude<TaskStatus, "queued" | "running">>
}

/** What a task does: a turn of the engine, the project's checks (H-22), another vendor's CLI (H-38), or a web recipe (WA-7). */
export type TaskKind = "agent" | "verify" | "external" | "action"

/** The approval a scheduled web action runs under (WA-7): the engine's own rule, narrowed to allow. */
export type BrowserAllowRule = {
  permission: "browser" | "browser_sensitive"
  pattern: string
  action: "allow"
}

/** What a browser action does, from least to most (BU-01): its approval and grants are per tier. */
export type BrowserTier = "read" | "navigate" | "interact" | "sensitive"

/** A standing browser grant the server keeps (BU-01): a tier on a site, for one session or always. */
export type BrowserGrant = {
  id: string
  origin: string
  tier: BrowserTier
  scope: "session" | "always"
  sessionID?: string
  createdAt: number
}

/** A browser approval asked in the session (BU-01): the site, the tier and the answers on offer. */
export type BrowserApproval = {
  origin: string
  site: string
  tier: BrowserTier
  action: string
  options: Array<{ value: string; label: string }>
  /** The reader's own browser, through an MCP preset (BU-02), rather than the agent's. */
  yours?: boolean
  /** The desktop's preview (BU-06): the person opening a site there, not the agent acting. */
  preview?: boolean
}

/** A web action a routine or task runs (WA-7): a profile id and the values it was given. */
export type ActionTaskInput = {
  id: string
  inputs?: Record<string, unknown>
}

export type Task = {
  id: string
  runID: string
  position: number
  name: string
  prompt: string
  kind?: TaskKind
  /** The command an `external` task ran (H-38). */
  command?: string
  /** The recipe and values an `action` task ran (WA-7). */
  action?: ActionTaskInput
  /** Which attempt this is, from 1. A retry after a failed check is a new task (H-22). */
  attempt?: number
  /** The task this one attempts again. */
  retryOf?: string
  /** `human` holds the run here until somebody reads what it did and lets it through. */
  gate?: "human"
  /** The tasks this one waited for, by name (H-28). An empty list means it was a root. */
  dependsOn?: string[]
  /** The condition that let it run, when it declared one (H-28). */
  when?: TaskCondition
  /** The plan this task was split from: one task per step shares its name (H-28). */
  foreach?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  sessionID?: string
  /**
   * The tree the task ran in (H-29): the project folder, or the worktree it was given. Its
   * checkpoints, its diff and its findings belong to that tree, so that is what "checkpoints"
   * opens (H-32's noted gap).
   */
  directory?: string
  status: TaskStatus
  startedAt?: number
  finishedAt?: number
  error?: string
  output?: string
  tokens?: number
  cost?: number
  /** `verified`: it ran only after verified work (RP-06). */
  require?: "verified"
  /** Whether it met its goal (RP-06), once judged. Agent and verify tasks are. */
  verdict?: TaskVerdict
  /** The model it was sent to and why (PI-04), once an agent task has started. */
  route?: TaskRoute
  /** What a verify task's look at the page found (CL-4), once it ran. */
  visualResult?: VisualResult
}

/**
 * Which model an agent task was sent to, and why (PI-04). `model` is absent when the engine's default
 * ran; `fallback` says the run's policy moved it there because a budget or a quota neared its limit.
 */
export type TaskRoute = {
  model?: string
  fallback: boolean
  reason: string
  source: "rule" | "model"
}

/**
 * One capture of a verify task's look at the page (CL-4), against the capture the same step took the
 * time before: the artifact ids of before, after and their difference.
 */
export type VisualShot = {
  name: string
  outcome: "first" | "same" | "changed"
  /** The share of the compared pixels that differ, 0 to 1. */
  changed: number
  /** Whether two captures in a row agreed before this one was kept. */
  stable: boolean
  after: string
  before?: string
  diff?: string
}

export type VisualResult = {
  status: "ran" | "not-run" | "failed"
  url?: string
  problem?: string
  shots: VisualShot[]
}

export type RoutineRun = {
  id: string
  source?: RunSource
  sessionID?: string
  status: RunStatus
  startedAt: number
  finishedAt?: number
  error?: string
  /** The server sends a routine's runs as runs, verdict included (RP-06). */
  verdict?: RunVerdict
  /** Which try of its beat this run is, from 1 (RP-07). */
  attempt?: number
}

export type RoutineInput = {
  name: string
  description: string
  prompt: string
  schedule: RoutineSchedule
  projectDirectory?: string
  agent?: string
  model?: { providerID: string; id: string; variant?: string }
  /** Run a workflow instead of a single prompt (HF-8). */
  workflow?: { name: string; inputs?: Record<string, string> }
  /** Model fallback and budget for the runs it starts (HF-8). */
  policy?: RunPolicy
  /** Drive a deterministic web action instead of a prompt (WA-7). */
  action?: ActionTaskInput
  /** The allow rules the action needs to run unattended (WA-7). */
  allow?: BrowserAllowRule[]
  /** Beats the server was not running for: run once for all of them, or wait for the next (RP-07). */
  missed?: "catch-up" | "skip"
  /** Try a failed run again (RP-07). */
  retry?: RoutineRetry
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
  workflow?: { name: string; inputs?: Record<string, string> }
  policy?: RunPolicy
  action?: ActionTaskInput
  allow?: BrowserAllowRule[]
  missed?: "catch-up" | "skip"
  retry?: RoutineRetry
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  runs: RoutineRun[]
  /** When it fires next, as the server reckons it (RP-07): the app keeps no schedule logic of its own. */
  nextRunAt?: number
  /** How many of its newest runs failed one after the other (RP-07). */
  failedInARow: number
  /** It failed often enough in a row to raise its notice (RP-07). */
  failing: boolean
}

/** Where a web action is declared: the global config, or a project's own `.opencode` (WA-8). */
export type ActionProfileScope = "global" | "project"

export type ActionInputKind = "string" | "image"

export type ActionStepName = "goto" | "waitFor" | "fill" | "click" | "upload" | "submit" | "assert" | "screenshot"

export type ActionStep =
  | { goto: string; timeoutMs?: number; sensitive?: boolean }
  | { waitFor: string; timeoutMs?: number; state?: "attached" | "visible"; sensitive?: boolean }
  | { fill: { selector: string; text?: string; credential?: string }; timeoutMs?: number; sensitive?: boolean }
  | { click: string; timeoutMs?: number; sensitive?: boolean }
  | { upload: { selector: string; from: string }; timeoutMs?: number }
  | { submit: { selector: string }; timeoutMs?: number }
  | { assert: { selector: string; text?: string }; timeoutMs?: number }
  | { screenshot: string }

export type ActionExtract = { selector: string; as?: "text" | "html" | "attribute"; attribute?: string }

export type ActionEvidence = { screenshots?: "each" | "failure" | "none"; text?: boolean }

/** A web action as the editor reads it (WA-8): the validated envelope plus where it lives. */
export type ActionProfileDetail = {
  id: string
  scope: ActionProfileScope
  tool: string
  description: string
  kind: "browser"
  origin: string
  credential?: string
  inputs: Record<string, ActionInputKind>
  steps: ActionStep[]
  extract?: Record<string, ActionExtract>
  guards: string[]
  sensitive: boolean
  availability: "host" | "desktop"
  evidence: ActionEvidence
  /** Where it is written, when the server says (WA-8). */
  path?: string
}

/** The catalogue as a routine preselects from (WA-7) and the editor edits (WA-8). */
export type ActionProfileSummary = ActionProfileDetail

export type ActionCatalog = {
  profiles: ActionProfileDetail[]
  rejected: Array<{ id: string; code: string; message: string }>
}

/** One written profile's file (WA-8), from `GET /harness/action-profiles`. */
export type ActionProfileFile = { id: string; scope: ActionProfileScope; path: string }

/** One step of a preview (WA-8): `skipped` is at or after the first side effect. */
export type ActionPreviewStep = {
  index: number
  kind: ActionStepName
  status: "ok" | "failed" | "planned" | "skipped"
  attempts: number
  durationMs: number
  screenshot?: string
  /** Why a failed preview step failed, so the editor can say more than "failed" (WA-8). */
  error?: string
}

export type ActionPreview = {
  action: string
  tool: string
  status: "preview"
  origin: string
  url: string
  title: string
  startedAt: number
  finishedAt: number
  steps: ActionPreviewStep[]
}

/** What a click-to-pick read from a point on the page (WA-8). */
export type SelectorCapture = {
  found: boolean
  reason?: "none" | "iframe"
  viewport?: { width: number; height: number }
  box?: { x: number; y: number; width: number; height: number }
  tag?: string
  candidates?: string[]
  text?: string
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

/**
 * What resuming a run would do (RP-04): the tasks that run, in order, and the checkpoint the folder
 * goes back to with what that writes and deletes. No checkpoint means the folder is left as it is.
 */
export type ResumePlan = { tasks: Task[]; checkpoint?: Checkpoint; plan?: RestorePlan }

/**
 * The usage ledger read back (UL-05), as `/harness/usage/summary`, `/sessions/:id` and `/runs/:id`
 * answer. Mirrors `harness-server/src/usage.ts`.
 */
export type UsageDimension =
  | "run"
  | "task"
  | "workflow"
  | "routine"
  | "agent"
  | "model"
  | "provider"
  | "directory"
  | "tag"
  | "purpose"
  | "day"
  | "session"

/** Whose price a figure is: the engine's list price, FlupCode's, the provider's own report; or none. */
export type CostBasis = "engine-list-price" | "flupcode-priced" | "provider-reported" | "unpriced"

/** How it was paid for: per use, by a subscription (so the figure is notional), on this machine, or not known. */
export type Billing = "metered" | "subscription" | "local" | "unknown"

export type LedgerTokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

/** Money with what it is. Lines with different basis or billing are never added together. */
export type MoneyLine = { basis: Exclude<CostBasis, "unpriced">; billing: Billing; usd: number; events: number }

/** What a set of ledger rows adds up to; `unpriced` had no price at all and is never $0. */
export type UsageBucket = {
  events: number
  tokens: LedgerTokens
  money: MoneyLine[]
  unpriced: { events: number; tokens: LedgerTokens }
}

/** One group: `key` identifies it (null for rows the dimension does not name); `fields` say what it is. */
export type UsageGroup = UsageBucket & { key: string | null; fields: Record<string, string | number | null> }

export type UsageSummary = {
  groupBy: UsageDimension | null
  total: UsageBucket
  groups: UsageGroup[]
  rest?: UsageBucket & { groups: number }
}

export type UsageSessionReport = {
  sessionID: string
  total: UsageBucket
  own: UsageBucket
  sessions: Array<UsageBucket & { sessionID: string; parentSessionID: string | null; depth: number }>
  byAgent: UsageGroup[]
  /** What the tree spent from the `from` it was asked with: the composer's turn. */
  since?: UsageBucket
}

export type UsageRunReport = {
  runID: string
  total: UsageBucket
  byTask: UsageGroup[]
  byPurpose: UsageGroup[]
  byAgent: UsageGroup[]
  byModel: UsageGroup[]
  /** The budgets it answers to and where each stands on the ledger (UL-08). */
  budgets?: BudgetStanding[]
}

/** A budget's scope (UL-08): one run (its policy), or a day of spend overall, by workflow or by routine. */
export type BudgetScope = "run" | "day" | "workflow" | "routine"

/** A budget measured on the ledger: `spent` in its unit; `unpriced` steps a cost figure cannot count. */
export type BudgetStanding = {
  scope: BudgetScope
  name: string
  budgetID?: string
  unit: "usd" | "tokens"
  limit: number
  softPct?: number
  spent: number
  unpriced: number
  level?: "soft" | "hard"
  reason: string
}

/** A standing budget over a day (UL-08), as saved, with today's standing. */
export type Budget = {
  id: string
  scope: Exclude<BudgetScope, "run">
  target?: string
  unit: "usd" | "tokens"
  limit: number
  softPct?: number
  createdAt: number
  name: string
  spent: number
  unpriced: number
  level?: "soft" | "hard"
}

export type BudgetInput = Pick<Budget, "scope" | "target" | "unit" | "limit" | "softPct">

/**
 * A provider quota window as the server last read it (UL-07): `calendar` resets at `resetAt`,
 * `spendCap` never resets, `balance` is prepaid money with only what remains. `null` is not said.
 */
export type QuotaWindow = {
  id: string
  kind: "calendar" | "spendCap" | "balance"
  unit: "credits" | "requests" | "usd" | "cny"
  used: number | null
  limit: number | null
  remaining: number | null
  resetAt: number | null
  /** The pace from the stored readings, and when it runs out at it; `null` until there are enough. */
  forecast: { perHour: number; exhaustsAt: number | null } | null
}

/** One connected provider's quota (UL-07): its windows at the last good read, and the last failure. */
export type ProviderQuota = {
  providerID: string
  name: string
  docs: string
  sampledAt: number | null
  error?: { message: string; at: number }
  windows: QuotaWindow[]
}

export type MetricTokens = { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

/** One turn of one session, as the harness recorded it (AH-B01). */
export type SessionMetricTurn = {
  sessionID: string
  turnID: string
  turn: number
  projectID?: string
  providerID?: string
  modelID?: string
  agent?: string
  requests: number
  tokens: MetricTokens
  cost: number
  modelMs: number
  firstTokenMs?: number
  toolCalls: number
  toolErrors: number
  toolOutputBytes: number
  tools: Record<string, { calls: number; errors: number; bytes: number }>
  compactions: number
  skills: string[]
  startedAt: number
  endedAt: number
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

/** Where a config file lives: the global config or the project's own `.opencode`. */
export type ConfigFileScope = "global" | "project"

/** What a config file is: a tool module the engine scans, a guard a delivery profile names, or a config file. */
export type ConfigFileKind = "tool" | "guard" | "config"

/**
 * A config file the engine would load. Mirrors `harness-server`'s own type.
 *
 * `missing` is a guard the config names but which is not on disk, so the engine would refuse it;
 * `symlink` carries the link's target when the file is a link rather than one of its own.
 */
export type ConfigFileEntry = {
  name: string
  path: string
  scope: ConfigFileScope
  kind: ConfigFileKind
  bytes: number
  mtimeMs: number
  symlink?: { target: string }
  missing?: boolean
}

/** How exporting one file ended: copied, already there, in the way, left alone, or outside the repo. */
export type ConfigFileExportClassification = "written" | "unchanged" | "conflicts" | "skipped" | "outside"

/** One requested file, classified and mapped to where it would go in the repository. */
export type ConfigFileExportEntry = {
  path: string
  target: string
  classification: ConfigFileExportClassification
  reason?: string
}

/** Copying config files into the user's own config repository. Mirrors `harness-server`'s own type. */
export type ConfigFileExport = {
  repo: string
  /** True when nothing was written and this is only the plan. */
  dryRun: boolean
  written: string[]
  unchanged: string[]
  conflicts: string[]
  skipped: string[]
  outside: string[]
  entries: ConfigFileExportEntry[]
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

// ── Adaptive harness (FH-070) ─────────────────────────────────────────────────────────────────
//
// The read surfaces the settings panel and the inspectors consume. These mirror the shapes
// `harness-server` answers; the settings model is narrowed to the fields the panel draws, never
// widened, so a field the UI does not write cannot be invented here.

/** Where a settings leaf takes its value from, as the server reports it. */
export type AdaptiveProvenance = "env" | "block" | "default"

/** The per-field guard the server enforces before it writes a leaf. */
export type AdaptiveGuard = "none" | "env-disabled" | "adaptive-token" | "egress-allowlist"

/** When a write to a leaf needs an explicit confirmation. */
export type AdaptiveConfirmation = "none" | "required" | "widening"

export type AdaptiveFieldType = "boolean" | "string-list" | "kinds" | "number" | "count" | "model"

/** A note the server travels beside a successful write. */
export type AdaptiveWarning =
  | "evaluation-gated"
  | "runtime-inert"
  | "no-model"
  | "skills-still-load"
  | "learning-draft-egress"
  | "classifier-no-consent"
  | "model-no-consent"

/** One switch the settings panel may render; the server's list is the whole allowlist. */
export type AdaptiveWritableField = {
  path: string
  type: AdaptiveFieldType
  confirmation: AdaptiveConfirmation
  guard: AdaptiveGuard
  warning?: AdaptiveWarning
}

/** One remote provider's consent: whether it may be sent anything, for which projects and kinds. */
export type AdaptiveProviderConsent = { enabled: boolean; projects: string[]; kinds: Record<string, boolean> }

/** The values the panel draws, narrowed from the server's resolved `AdaptiveConfig`. */
export type AdaptiveSettings = {
  enabled: boolean
  shadow: boolean
  context: { enabled: boolean; apply: boolean }
  /** `frozen` and `limits` (AH-F03) are absent from an older server. */
  learning: {
    enabled: boolean
    maxInputChars: number
    frozen?: boolean
    limits?: { proposalsPerDay: number; maxLearnedSkills: number; patchesPerWeek: number }
  }
  relevance: { enabled: boolean }
  guardrails: { enabled: boolean }
  /** The predictive model per kind; `skillReflection`'s decides whose consent learning needs. */
  models?: Record<string, string>
  /** Consent per remote provider (AH-C03), keyed by the predictive model id. */
  egress: { providers: Record<string, AdaptiveProviderConsent> }
  /** `decisionsDays` is the shadow decisions' window, which the server resolves even while off. */
  retention: { enabled: boolean; decisionsDays?: number }
  budget: { monthlyTokens: number; hotReserveFraction: number }
}

export type AdaptiveRuntimeCapabilities = {
  runtime: "legacy" | "v2" | "unknown"
  degraded: boolean
  canUseLegacyHooks: boolean
  canInjectSystemPrompt: boolean
  canObserveToolCalls: boolean
  canObserveCompaction: boolean
  canTransformMessages: boolean
  canUseSdkPath: true
  checkedAt: number
}

/** What the adaptive budget has spent this month, read-only in E8. */
export type AdaptiveUsage = {
  month: string
  tokensSpent: number
  calls: number
  monthlyTokens: number
  hotReserveFraction: number
}

/** A change the runtime probe saw in what the engine offers the adaptive plugins (AH-D05). */
export type AdaptiveRuntimeAlert = {
  kind: "runtime-changed" | "engine-version-changed" | "v2-turns-observed"
  from?: string
  to: string
  at: number
}

/** One learning cap a project has reached (AH-F03): what it used against the most it may. */
export type AdaptiveLearningLimitHit = {
  projectID: string
  limit: "proposals-per-day" | "learned-skills" | "patches-per-week"
  used: number
  max: number
}

/**
 * What `/harness/adaptive/model-key` answers for one provider: where its key comes from, whether one
 * can be saved here and the variable that sets it from the environment. Never the key.
 */
export type AdaptiveModelKeyStatus = { source: "env" | "stored" | "none"; storable: boolean; env: string }

/** `GET /harness/adaptive/config`: the settings surface as the panel reads it. */
export type AdaptiveConfigView = {
  effective: AdaptiveSettings
  source: Record<string, AdaptiveProvenance>
  /** An older server also names its one keyed provider here; `adaptive-legacy.ts` reads that. */
  env: { adaptiveDisabled: boolean }
  /**
   * Whether the old single switch still assigns the predictive model to every decision the config does
   * not name. Absent from an older server: read it through `legacySwitchOn`.
   */
  legacySwitch?: boolean
  /** `alerts` are the unacknowledged runtime changes (AH-D05); absent from an older server. */
  runtime: {
    runtime: "legacy" | "v2" | "unknown"
    degraded: boolean
    checkedAt: number
    alerts?: AdaptiveRuntimeAlert[]
  }
  capabilities: AdaptiveRuntimeCapabilities
  canWrite: boolean
  writer: { path: string; exists: boolean }
  usage: AdaptiveUsage
  writable: AdaptiveWritableField[]
  /** The model a learning draft is sent to (`provider/model`); absent from an older server. */
  learningDraft?: { model: string | null }
  /**
   * The model assigned to review finished sessions (null when none is) and whether it may run for at
   * least one project; when it may not, Learning proposes with the built-in rules. Absent from an
   * older server.
   */
  learningClassifier?: { model: string | null; ready: boolean }
  /** The learning caps reached right now, per project (AH-F03); absent from an older server. */
  learningLimits?: { reached: AdaptiveLearningLimitHit[] }
  /** The providers a consent row is drawn for: the registered remote models, then any configured. */
  egressProviders?: string[]
  /**
   * The registered predictive providers, with the names a reader is shown (PI-01). An older server
   * serves them as `models`: read them through `viewProviders`.
   */
  providers?: AdaptiveModel[]
}

/**
 * One registered predictive provider (AH-C01, PI-01) as the settings view serves it: `name` is what
 * the reader sees, the id only what the config file says. A remote one needs its consent; one that
 * needs a key says where that key comes from.
 */
export type AdaptiveModel = {
  id: string
  name: string
  locality: "local" | "remote"
  supports: string[]
  needsConsent: boolean
  needsKey: boolean
  key?: AdaptiveModelKeyStatus
}

/** Who answered a decision (AH-C02): the rule alone, a model, or the rule after a model did not win. */
export type DecisionSource = "baseline" | "model" | "fallback" | "unknown"

/** One audited decision (FH-015). Mirrors `harness-server`'s own type. */
export type StoredDecision = {
  id: string
  kind: string
  sessionID?: string
  episodeID?: string
  projectID?: string
  inputsHash: string
  stateSummary: Record<string, unknown>
  answer: unknown
  baselineAnswer: unknown
  baselineRule: string
  confidence?: number
  probabilities?: Record<string, number>
  provider: string
  attemptedProvider?: string
  modelVersion?: string
  /** Provider-neutral since AH-C02; `unknown` is a stored value this build does not know, kept in `raw`. */
  source: DecisionSource
  providerID?: string
  providerVersion?: string
  costUsd?: number
  inputTokens?: number
  raw?: { kind?: string; source?: string }
  degraded: boolean
  degradedReason?: string
  latencyMs: number
  shadow: boolean
  /** The session's holdout arm (AH-B05): `control` was decided and audited but not applied. */
  arm?: "control" | "treatment"
  /** The outcome label (AH-C06), once the labeler judged the decision. */
  label?: DecisionLabel
  createdAt: number
  updatedAt: number
}

/**
 * Whether a kind's predictive model is asked (AH-C05). Mirrors `harness-server`'s own type: warming
 * up, asked, only explored because it does not pay for itself, or paused because it does not help.
 */
export type ValueGateState = "warming-up" | "asking" | "exploring" | "paused"

/** One kind and model's value-of-information gate. Mirrors `harness-server`'s own type. */
export type ValueGateStatus = {
  kind: string
  modelID: string
  modelVersion?: string
  state: ValueGateState
  samples: number
  disagreements: number
  disagreementRate: number
  uplift: number
  valueUsd: number
  costUsd: number
  p95LatencyMs?: number
  latencySamples: number
}

/** The gate of every assigned kind, with the numbers it is judged by. */
export type ValueGateSnapshot = {
  enabled: boolean
  window: number
  minSamples: number
  epsilon: number
  explorationRate: number
  kinds: ValueGateStatus[]
}

export type DecisionLabelOutcome = "correct" | "incorrect" | "unknown"

/**
 * How a decision scored against what actually happened (AH-C06). Mirrors `harness-server`'s own
 * type: the answer's outcome, the baseline answer's against the same truth, and what produced it.
 */
export type DecisionLabel = {
  outcome: DecisionLabelOutcome
  baselineOutcome?: DecisionLabelOutcome
  source: string
  labeledAt: number
}

/**
 * The live advisory of the failure/loop guardrails (FH-062). Mirrors `harness-server`'s own type:
 * opaque — a reason, the counts, the tool, the deterministic decision id and when.
 */
export type GuardrailStatus = {
  reason: "loop" | "error"
  repeatedCalls: number
  repeatedErrors: number
  tool?: string
  decisionID: string
  at: number
}

/** A person's override of the adaptive layer for one session (AH-E02). Mirrors the server's own type. */
export type SessionAdaptiveOverride = { paused: boolean; excludedSkills: string[] }

/** What the composer's "Adaptive" chip says about a session's latest turn (AH-E02), from the audit. */
export type SessionTurnSummary = {
  sessionID: string
  override: SessionAdaptiveOverride
  relevance?: { decisionID: string; skills: string[]; acted: boolean; degradedReason?: string; at: number }
  plan?: { id: string; tokensSaved: number; applied: boolean; decisionID?: string; at: number }
  model?: { providerID: string; kind: string; latencyMs: number; decisionID: string; at: number }
}

/** What the decision audit explains about one row (FH-015). Mirrors the server's own type. */
export type DecisionExplanation = {
  id: string
  question: string
  answer: unknown
  baseline: { answer: unknown; rule: string }
  why: string
  source: DecisionSource
  provider: string
  attemptedProvider?: string
  modelVersion?: string
  providerID?: string
  providerVersion?: string
  costUsd?: number
  inputTokens?: number
  raw?: { kind?: string; source?: string }
  confidence?: number
  probabilities?: Record<string, number>
  latencyMs: number
  degraded: boolean
  degradedReason?: string
  episodeID?: string
  evidenceRefs: string[]
  decidedAt: number
  label?: DecisionLabel
}

export type ItemDisposition = "keep" | "archive" | "drop"

/** One observed item as a context plan decided about it (FH-022). */
export type ContextPlanEntry = {
  id: string
  kind: string
  score: number
  disposition: ItemDisposition
  reason: string
  protected: boolean
  tokens: number
  evidenceRef?: string
}

/** A context plan (FH-022). Mirrors `harness-server`'s own type. */
export type StoredPlan = {
  id: string
  runID?: string
  taskID?: string
  episodeID?: string
  sessionID?: string
  projectID?: string
  objectiveHash: string
  entries: ContextPlanEntry[]
  /** `model` names the model that refined the plan in `scoreProvider` (AH-C02). */
  scoreSource: "baseline" | "model" | "unknown"
  scoreProvider?: string
  rawScoreSource?: string
  degraded: boolean
  degradedReason?: string
  applied: boolean
  tokensBefore: number
  tokensAfter: number
  decisionID?: string
  createdAt: number
  truncated: boolean
  updatedAt: number
}

export type SkillProposalStatus = "proposed" | "promoted" | "rejected"

/** One skill proposal a reflection drafted, before or after the curator decided on it (FH-034). */
export type SkillProposal = {
  id: string
  episodeID: string
  sessionID?: string
  projectID: string
  decisionID?: string
  intent: "add" | "patch" | "merge" | "drop"
  targetSkill?: string
  name?: string
  description?: string
  body?: string
  bodyHash?: string
  evidenceRefs: string[]
  confidence?: number
  modelVersion?: string
  status: SkillProposalStatus
  reason?: string
  createdAt: number
  updatedAt: number
}

export type LearnedSkillState = "probation" | "mature" | "stale" | "archived" | "merged"

export type LearnedSkillUsage = { load: number; view: number; patch: number; opportunities: number }

/** One learned skill in the roster, with its sidecar state (FH-034/FH-041). */
export type LearnedSkill = {
  name: string
  description: string
  learned: boolean
  state?: LearnedSkillState
  /** `load` is real sessions that used it, `opportunities` real sessions seen since install (AH-F02). */
  usage?: LearnedSkillUsage
  /** When a real session last used it. */
  lastUsedAt?: number
  /** Real sessions closed since its last use. */
  sessionsSinceUse?: number
  /** It sat unused long enough that a person may want to archive it; nothing archives it by itself. */
  suggestArchive?: boolean
  /** A person disabled it (AH-E04): its file sits outside `skills/`, so no new session loads it. */
  disabled?: boolean
  /** Where its `SKILL.md` is on the machine running the harness, for "Open file". */
  path?: string
  /** Its text, on the detail read only. */
  body?: string
}
