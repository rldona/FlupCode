import { Database } from "bun:sqlite"
import type { UsageDimension, UsageRow, UsageTotalRow } from "./usage"
import { KIND_PURPOSE, repositoryRoot } from "./usage-ledger"
import type {
  Billing,
  CostBasis,
  LedgerEvent,
  SessionAttribution,
  ToolEvent,
  UsageEvent,
  UsagePurpose,
} from "./usage-ledger"
import { safeEvent } from "./stream"
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import type { BrowserTier } from "./browser-policy"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, sep } from "node:path"
import {
  normalizeEpisodeLimit,
  normalizeOutcome,
  parseFailures,
  parseStringList,
  parseVerifications,
  RUN_EPISODE_PREFIX,
} from "./adaptive/episode"
import {
  EVIDENCE_SLICE_LIMIT,
  EVIDENCE_TOTAL_LIMIT,
  evidenceHash,
  isEvidenceHash,
  sliceEvidence,
} from "./adaptive/evidence"
import { TOOL_TRIM_MAX_STORED_BYTES } from "./adaptive/config"
import { CHECKPOINTS_KEPT_PER_RUN } from "./checkpoint"
import type {
  EvidenceInput,
  EvidenceKind,
  EvidenceLink,
  EvidenceSlice,
} from "./adaptive/evidence"
import type {
  ActionTaskInput,
  BrowserAllowRule,
  BrowserAuditEntry,
  BrowserGrant,
  Routine,
  RoutineCreateOptions,
  Artifact,
  ArtifactInput,
  ArtifactKind,
  AdaptiveUsage,
  RoutineInput,
  RoutineRepository,
  Run,
  RunPolicy,
  RunSource,
  RunWorkflow,
  Task,
  TaskCondition,
  TaskInput,
  TaskStatus,
  RunStatus,
  ServerEvent,
  StoredEvent,
  Checkpoint,
  Finding,
  SessionPrefs,
  StashedPrompt,
  ContextPack,
  SharedConversation,
  ProjectMemory,
  EpisodeFilter,
  EpisodeInput,
  SessionEpisode,
  StoredDecision,
  StoredDecisionInput,
  DecisionFilter,
  PlanFilter,
  StoredPlan,
  StoredPlanInput,
  ReflectionJobFilter,
  StoredReflectionJob,
  StoredReflectionJobInput,
  SkillProposalFilter,
  StoredSkillProposal,
  StoredSkillProposalInput,
  WorkflowVersion,
  TaskVerdict,
} from "./types"
import { VERDICTS } from "./types"
import { runVerdict } from "./verdict"
import { decisionFromRow, decisionRowFrom } from "./adaptive/decision-record"
import type { DecisionRow } from "./adaptive/decision-record"
import { planFromRow, planRowFrom } from "./adaptive/context-record"
import type { PlanRow } from "./adaptive/context-record"
import { reflectionJobFromRow, reflectionJobRowFrom } from "./adaptive/learning/reflection-job"
import type { ReflectionRow } from "./adaptive/learning/reflection-job"
import { proposalFromRow, proposalRowFrom } from "./adaptive/learning/proposal-record"
import type { SkillProposalRow } from "./adaptive/learning/proposal-record"
import type { RetentionCutoffs, RetentionPurge } from "./adaptive/retention"
import type { ValueSamples } from "./adaptive/value-gate"
import type { DecisionKind, DecisionLabelCounts, DecisionLabelInput } from "./adaptive/decision"
import { applyObservation, emptyTurn } from "./adaptive/session-metrics"
import type { MetricObservation, SessionMetricTurn } from "./adaptive/session-metrics"
import type { Arm, HoldoutCapability } from "./adaptive/holdout"

/** How much text an artifact keeps inline (§12.1). Anything past it is cut, and says it was. */
export const ARTIFACT_LIMIT = 1_000_000

/** Mirrors `documents.ts`; duplicated rather than imported to avoid a reverse dependency. */
const DOCUMENTS_DIRECTORY = join(".flupcode", "artifacts")
/** The most turns one cost summary reads (AH-B02): months of heavy use, and still bounded. */
const SESSION_METRIC_TURN_CAP = 20_000

/**
 * The identity of an artifact's text, so the same report written twice is recognised (H-14).
 *
 * Over the stored form rather than the raw one, so a reader comparing a plan against what was
 * indexed sees the same hash the repository kept.
 */
export const artifactHash = (content: string) =>
  Bun.hash(content.length > ARTIFACT_LIMIT ? content.slice(0, ARTIFACT_LIMIT) : content).toString(16)

/** The slice of the repository that indexing plans needs, so it takes no more than that (H-14). */
export type ArtifactRepository = Pick<SqliteRoutineRepository, "addArtifact" | "listArtifacts">

/**
 * Runs are their own table, keyed by what asked for them rather than owned by a routine, and there
 * is a log of what changed so a client can catch up instead of polling. The lock is keyed by a
 * string for the same reason: what must not run twice at once is a run, and a routine is only one
 * thing that starts one.
 */
const schema = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  project_directory TEXT,
  agent TEXT,
  model_json TEXT,
  action_json TEXT,
  allow_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_run_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_id TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  error TEXT,
  directory TEXT,
  options TEXT
);
CREATE INDEX IF NOT EXISTS runs_source_started_at ON runs(source_type, source_id, started_at DESC);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent',
  command TEXT,
  action_json TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  retries INTEGER,
  retry_of TEXT,
  gate TEXT,
  agent TEXT,
  model_json TEXT,
  depends_on TEXT,
  when_json TEXT,
  foreach_source TEXT,
  session_id TEXT,
  directory TEXT,
  status TEXT NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  error TEXT,
  output TEXT,
  tokens INTEGER,
  cost REAL
);
CREATE INDEX IF NOT EXISTS tasks_run_position ON tasks(run_id, position);
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  directory TEXT,
  run_id TEXT,
  task_id TEXT,
  session_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  mime TEXT NOT NULL,
  content TEXT,
  path TEXT,
  bytes INTEGER,
  truncated INTEGER,
  hash TEXT,
  producer TEXT NOT NULL,
  pinned INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_created_at ON artifacts(created_at DESC);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(run_id, created_at DESC);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  sha TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  run_id TEXT,
  task_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS checkpoints_directory ON checkpoints(directory, created_at DESC);
CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  directory TEXT,
  run_id TEXT,
  task_id TEXT,
  file TEXT NOT NULL,
  line INTEGER,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  source TEXT,
  resolved INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_directory ON findings(directory, created_at DESC);
CREATE TABLE IF NOT EXISTS session_prefs (
  session_id TEXT PRIMARY KEY,
  pinned INTEGER,
  tags_json TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stashed_prompts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stashed_prompts_created_at ON stashed_prompts(created_at DESC);
CREATE TABLE IF NOT EXISTS context_packs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  refs_json TEXT NOT NULL,
  directory TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS context_packs_directory ON context_packs(directory, name);
CREATE TABLE IF NOT EXISTS shared_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY,
  directory TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_memory_directory ON project_memory(directory, created_at);
CREATE TABLE IF NOT EXISTS action_credentials (
  name TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  iv TEXT NOT NULL,
  tag TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS locks (
  key TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_episodes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT,
  objective TEXT NOT NULL,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  files_json TEXT NOT NULL DEFAULT '[]',
  commands_json TEXT NOT NULL DEFAULT '[]',
  failures_json TEXT NOT NULL DEFAULT '[]',
  verifications_json TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT 'unknown',
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_episodes_project ON session_episodes(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_episodes_session ON session_episodes(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS session_episodes_run ON session_episodes(run_id, created_at DESC);
CREATE TABLE IF NOT EXISTS evidence (
  hash TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  bytes INTEGER,
  truncated INTEGER,
  created_at INTEGER NOT NULL,
  last_read_at INTEGER
);
CREATE TABLE IF NOT EXISTS evidence_total (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bytes INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS episode_evidence (
  episode_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (episode_id, hash)
);
CREATE INDEX IF NOT EXISTS episode_evidence_episode ON episode_evidence(episode_id, position);
CREATE INDEX IF NOT EXISTS episode_evidence_hash ON episode_evidence(hash);
-- A trimmed tool output (AH-D02): the session that owns the ref, and the evidence row that holds it.
CREATE TABLE IF NOT EXISTS tool_evidence (
  session_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  hash TEXT NOT NULL,
  tool TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, ref)
);
CREATE INDEX IF NOT EXISTS tool_evidence_hash ON tool_evidence(hash);
CREATE TABLE IF NOT EXISTS adaptive_usage (
  month TEXT PRIMARY KEY,
  tokens INTEGER NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS adaptive_decision (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  episode_id TEXT,
  project_id TEXT,
  kind TEXT NOT NULL,
  inputs_hash TEXT NOT NULL,
  state_summary_json TEXT NOT NULL DEFAULT '{}',
  answer_json TEXT NOT NULL,
  baseline_answer_json TEXT NOT NULL,
  baseline_rule TEXT NOT NULL,
  confidence REAL,
  probabilities_json TEXT,
  provider TEXT NOT NULL,
  attempted_provider TEXT,
  model_version TEXT,
  source TEXT NOT NULL,
  degraded INTEGER NOT NULL DEFAULT 0,
  degraded_reason TEXT,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  policy_json TEXT NOT NULL DEFAULT '{}',
  shadow INTEGER NOT NULL DEFAULT 1,
  -- The provider-neutral audit (AH-C02): a table created here already has the columns the numbered
  -- migration adds to one written before them, so a recreated table never misses them.
  provider_id TEXT,
  provider_version TEXT,
  cost_usd REAL,
  input_tokens INTEGER,
  label TEXT,
  labeled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS adaptive_decision_episode ON adaptive_decision(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_decision_session ON adaptive_decision(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_decision_kind ON adaptive_decision(kind, created_at DESC);
-- The unfiltered audit page (AH-E05) walks this in list order and seeks to the keyset cursor.
CREATE INDEX IF NOT EXISTS adaptive_decision_created ON adaptive_decision(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS adaptive_decision_hash ON adaptive_decision(inputs_hash);
-- The purge deletes shadow vs acting rows by updated_at; without this it scanned the table.
CREATE INDEX IF NOT EXISTS adaptive_decision_shadow_updated ON adaptive_decision(shadow, updated_at);
CREATE TABLE IF NOT EXISTS adaptive_plan (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  task_id TEXT,
  episode_id TEXT,
  session_id TEXT,
  project_id TEXT,
  objective_hash TEXT NOT NULL,
  items_json TEXT NOT NULL DEFAULT '[]',
  item_count INTEGER NOT NULL DEFAULT 0,
  keep_count INTEGER NOT NULL DEFAULT 0,
  archive_count INTEGER NOT NULL DEFAULT 0,
  drop_count INTEGER NOT NULL DEFAULT 0,
  score_source TEXT NOT NULL,
  score_provider TEXT,
  degraded INTEGER NOT NULL DEFAULT 0,
  degraded_reason TEXT,
  applied INTEGER NOT NULL DEFAULT 0,
  tokens_before INTEGER NOT NULL DEFAULT 0,
  tokens_after INTEGER NOT NULL DEFAULT 0,
  decision_id TEXT,
  truncated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS adaptive_plan_run ON adaptive_plan(run_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_plan_task ON adaptive_plan(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_plan_episode ON adaptive_plan(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_plan_session ON adaptive_plan(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_plan_project ON adaptive_plan(project_id, created_at DESC);
-- The retention purge (FH-082, ADR-0022 §2) filters on updated_at per state and correlates
-- decision_id; neither was indexed, so the synchronous startup/sweep delete scanned the tables.
CREATE INDEX IF NOT EXISTS adaptive_plan_decision ON adaptive_plan(decision_id);
CREATE INDEX IF NOT EXISTS adaptive_plan_applied_updated ON adaptive_plan(applied, updated_at);
CREATE TABLE IF NOT EXISTS reflection_job (
  episode_id TEXT PRIMARY KEY,
  session_id TEXT,
  project_id TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  decision_id TEXT,
  proposal_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reflection_job_project ON reflection_job(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reflection_job_status ON reflection_job(status, created_at DESC);
-- The purge deletes terminal jobs by updated_at and correlates decision_id/proposal_id.
CREATE INDEX IF NOT EXISTS reflection_job_decision ON reflection_job(decision_id);
CREATE INDEX IF NOT EXISTS reflection_job_proposal ON reflection_job(proposal_id);
CREATE INDEX IF NOT EXISTS reflection_job_status_updated ON reflection_job(status, updated_at);
CREATE TABLE IF NOT EXISTS skill_proposals (
  id TEXT PRIMARY KEY,
  episode_id TEXT NOT NULL,
  session_id TEXT,
  project_id TEXT NOT NULL,
  decision_id TEXT,
  intent TEXT NOT NULL,
  target_skill TEXT,
  name TEXT,
  description TEXT,
  body TEXT,
  body_hash TEXT,
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL,
  model_version TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_proposals_episode ON skill_proposals(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS skill_proposals_project ON skill_proposals(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS skill_proposals_status ON skill_proposals(status, created_at DESC);
-- The purge deletes rejected proposals by updated_at and correlates decision_id.
CREATE INDEX IF NOT EXISTS skill_proposals_decision ON skill_proposals(decision_id);
CREATE INDEX IF NOT EXISTS skill_proposals_status_updated ON skill_proposals(status, updated_at);
-- The per-turn cost baseline (AH-B01): one row per turn, folded from the metrics plugin.
CREATE TABLE IF NOT EXISTS session_metrics (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  project_id TEXT,
  provider_id TEXT,
  model_id TEXT,
  agent TEXT,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  model_ms INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  tool_errors INTEGER NOT NULL DEFAULT 0,
  tool_output_bytes INTEGER NOT NULL DEFAULT 0,
  tools_json TEXT NOT NULL DEFAULT '{}',
  compactions INTEGER NOT NULL DEFAULT 0,
  skills_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, turn_id)
);
CREATE INDEX IF NOT EXISTS session_metrics_session_turn ON session_metrics(session_id, turn);
CREATE INDEX IF NOT EXISTS session_metrics_ended ON session_metrics(ended_at);
-- Observations already folded: the engine can deliver the same event to more than one plugin
-- instance, and a second copy must not be a second request.
CREATE TABLE IF NOT EXISTS session_metric_seen (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS session_metric_seen_at ON session_metric_seen(at);
`

/**
 * The first shape of this server stored runs as `routine_runs`, owned by a routine. Anyone who ran
 * that build has rows worth keeping, so they are carried over once and the old tables dropped.
 */
const migration = `
INSERT OR IGNORE INTO runs (id, source_type, source_id, session_id, status, started_at, finished_at, error)
  SELECT id, 'routine', routine_id, session_id, status, started_at, finished_at, error FROM routine_runs;
DROP TABLE routine_runs;
DROP TABLE routine_locks;
`

/**
 * The schema version every database had before versioned migrations existed (AH-C02).
 *
 * Until then the shape was kept by `CREATE TABLE IF NOT EXISTS` plus `addColumn`, which is additive
 * and idempotent and still runs first on every start. A database with no `schema_version` row is at
 * this version; everything past it is a numbered migration that runs once, in order.
 */
const LEGACY_SCHEMA_VERSION = 1

/** How many pre-migration backups are kept beside the database; older ones are removed. */
const BACKUPS_KEPT = 3

/**
 * The ledger's columns behind each summary dimension but `tag` (UL-05, audit §8.4), named as the
 * summary's `fields`. A day is the local one, as `dayOf` counts it, of when the fact happened.
 */
const USAGE_COLUMNS: Record<Exclude<UsageDimension, "tag">, Record<string, string>> = {
  run: { runID: "run_id" },
  task: { taskID: "task_id", runID: "run_id", attempt: "attempt" },
  workflow: { workflowName: "workflow_name", workflowHash: "workflow_hash" },
  routine: { routineID: "routine_id" },
  agent: { agent: "agent" },
  model: { providerID: "provider_id", modelID: "model_id", variant: "variant" },
  provider: { providerID: "provider_id" },
  directory: { directory: "directory" },
  purpose: { purpose: "purpose" },
  day: { day: "date(COALESCE(ended_at, started_at) / 1000, 'unixepoch', 'localtime')" },
  session: { sessionID: "session_id" },
}

type RoutineRow = {
  id: string
  name: string
  description: string
  prompt: string
  schedule_json: string
  project_directory: string | null
  agent: string | null
  model_json: string | null
  workflow_json: string | null
  policy_json: string | null
  action_json: string | null
  allow_json: string | null
  enabled: number
  created_at: number
  last_run_at: number | null
}

type RunRow = {
  id: string
  source_type: string
  source_id: string | null
  directory: string | null
  session_id: string | null
  status: RunStatus
  started_at: number
  finished_at: number | null
  error: string | null
  options: string | null
  workflow_json: string | null
}

type TaskRow = {
  id: string
  run_id: string
  position: number
  name: string
  prompt: string
  kind: string | null
  command: string | null
  action_json: string | null
  attempt: number | null
  retries: number | null
  retry_of: string | null
  gate: string | null
  agent: string | null
  model_json: string | null
  depends_on: string | null
  when_json: string | null
  foreach_source: string | null
  session_id: string | null
  directory: string | null
  status: TaskStatus
  started_at: number | null
  finished_at: number | null
  error: string | null
  output: string | null
  tokens: number | null
  cost: number | null
  /** RP-06 (migration 9); absent on a database that has not reached it yet. */
  verdict?: string | null
  verdict_reason?: string | null
  verdict_source?: string | null
  require_verdict?: string | null
}

const decodeTask = (row: TaskRow): Task => ({
  id: row.id,
  runID: row.run_id,
  position: row.position,
  name: row.name,
  prompt: row.prompt,
  kind:
    row.kind === "verify"
      ? "verify"
      : row.kind === "external"
        ? "external"
        : row.kind === "action"
          ? "action"
          : "agent",
  command: row.command ?? undefined,
  action: decodeAction(row.action_json),
  attempt: row.attempt ?? 1,
  retries: row.retries ?? undefined,
  retryOf: row.retry_of ?? undefined,
  gate: row.gate === "human" ? "human" : undefined,
  agent: row.agent ?? undefined,
  model: decodeModel(row.model_json),
  dependsOn: decodeDependsOn(row.depends_on),
  when: decodeWhen(row.when_json),
  foreach: row.foreach_source ?? undefined,
  sessionID: row.session_id ?? undefined,
  directory: row.directory ?? undefined,
  status: row.status,
  startedAt: row.started_at ?? undefined,
  finishedAt: row.finished_at ?? undefined,
  error: row.error ?? undefined,
  output: row.output ?? undefined,
  tokens: row.tokens ?? undefined,
  cost: row.cost ?? undefined,
  ...(row.require_verdict === "verified" ? { require: "verified" as const } : {}),
  ...decodeVerdict(row),
})

/** A task's verdict (RP-06), or nothing: a value this build does not know reads as not judged. */
const decodeVerdict = (row: Pick<TaskRow, "verdict" | "verdict_reason" | "verdict_source">): Pick<Task, "verdict"> => {
  const value = VERDICTS.find((verdict) => verdict === row.verdict)
  const source = row.verdict_source === "check" || row.verdict_source === "model" ? row.verdict_source : "rule"
  return value ? { verdict: { value, reason: row.verdict_reason ?? "", source } } : {}
}

type ArtifactRow = {
  id: string
  directory: string | null
  run_id: string | null
  task_id: string | null
  session_id: string | null
  kind: string
  title: string
  mime: string
  content: string | null
  path: string | null
  bytes: number | null
  truncated: number | null
  hash: string | null
  producer: string
  pinned: number | null
  expires_at: number | null
  created_at: number
}

type CheckpointRow = {
  id: string
  directory: string
  sha: string
  title: string
  summary: string | null
  run_id: string | null
  task_id: string | null
  created_at: number
}

const decodeCheckpoint = (row: CheckpointRow): Checkpoint => ({
  id: row.id,
  directory: row.directory,
  sha: row.sha,
  title: row.title,
  ...(row.summary ? { summary: row.summary } : {}),
  ...(row.run_id ? { runID: row.run_id } : {}),
  ...(row.task_id ? { taskID: row.task_id } : {}),
  createdAt: row.created_at,
})

type FindingRow = {
  id: string
  directory: string | null
  run_id: string | null
  task_id: string | null
  file: string
  line: number | null
  severity: string
  title: string
  detail: string | null
  source: string | null
  resolved: number | null
  created_at: number
}

const decodeFinding = (row: FindingRow): Finding => ({
  id: row.id,
  file: row.file,
  severity: row.severity as Finding["severity"],
  title: row.title,
  createdAt: row.created_at,
  ...(row.directory ? { directory: row.directory } : {}),
  ...(row.run_id ? { runID: row.run_id } : {}),
  ...(row.task_id ? { taskID: row.task_id } : {}),
  ...(row.line !== null ? { line: row.line } : {}),
  ...(row.detail ? { detail: row.detail } : {}),
  ...(row.source ? { source: row.source as Finding["source"] } : {}),
  ...(row.resolved ? { resolved: true } : {}),
})

type SessionPrefsRow = {
  session_id: string
  pinned: number | null
  tags_json: string | null
  updated_at: number
}

const decodeSessionPrefs = (row: SessionPrefsRow): SessionPrefs => ({
  sessionID: row.session_id,
  pinned: !!row.pinned,
  tags: readTags(row.tags_json),
  updatedAt: row.updated_at,
})

/** Only string tags come back; a hand-edited file must not put a number in a chip. */
function readTags(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : []
  } catch {
    return []
  }
}

type StashedPromptRow = { id: string; text: string; created_at: number }

type BrowserGrantRow = { id: string; origin: string; tier: string; scope: string; session_id: string | null; created_at: number }

type BrowserAuditRow = {
  id: string
  at: number
  kind: string
  origin: string
  tier: string
  decision: string | null
  scope: string | null
  outcome: string | null
  reason: string | null
  action: string | null
  session_id: string | null
  run_id: string | null
  task_id: string | null
  artifact_id: string | null
}

const decodeStash = (row: StashedPromptRow): StashedPrompt => ({
  id: row.id,
  text: row.text,
  createdAt: row.created_at,
})

type ContextPackRow = { id: string; name: string; refs_json: string; directory: string | null; created_at: number }

const decodePack = (row: ContextPackRow): ContextPack => ({
  id: row.id,
  name: row.name,
  refs: readRefs(row.refs_json),
  ...(row.directory ? { directory: row.directory } : {}),
  createdAt: row.created_at,
})

function readRefs(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((ref): ref is string => typeof ref === "string") : []
  } catch {
    return []
  }
}

type SharedConversationRow = { id: string; title: string; markdown: string; created_at: number }

const decodeShare = (row: SharedConversationRow): SharedConversation => ({
  id: row.id,
  title: row.title,
  markdown: row.markdown,
  createdAt: row.created_at,
})

type ProjectMemoryRow = { id: string; directory: string; text: string; created_at: number }

const decodeMemory = (row: ProjectMemoryRow): ProjectMemory => ({
  id: row.id,
  directory: row.directory,
  text: row.text,
  createdAt: row.created_at,
})

export type EpisodeRow = {
  id: string
  session_id: string
  project_id: string
  run_id: string | null
  objective: string
  tool_calls: number
  files_json: string | null
  commands_json: string | null
  failures_json: string | null
  verifications_json: string | null
  outcome: string | null
  started_at: number
  ended_at: number | null
  evidence_refs_json: string | null
  created_at: number
  updated_at: number
}

/**
 * A stored episode, read defensively.
 *
 * Structured fields are JSON text, an outcome is a string and every scalar SQLite is free to hand
 * back with the wrong type, so a hand-edited row or one written by a different build must degrade
 * to `[]`/`unknown`/its default rather than take a read down (FH-001).
 */
export const decodeEpisode = (row: EpisodeRow): SessionEpisode => {
  const endedAt = readOptionalNumber(row.ended_at)
  return {
    id: readString(row.id),
    sessionID: readString(row.session_id),
    projectID: readString(row.project_id),
    ...(typeof row.run_id === "string" && row.run_id ? { runID: row.run_id } : {}),
    objective: readString(row.objective),
    toolCalls: readNumber(row.tool_calls),
    files: parseStringList(row.files_json),
    commands: parseStringList(row.commands_json),
    failures: parseFailures(row.failures_json),
    verifications: parseVerifications(row.verifications_json),
    outcome: normalizeOutcome(row.outcome),
    startedAt: readNumber(row.started_at),
    ...(endedAt !== undefined ? { endedAt } : {}),
    evidenceRefs: parseStringList(row.evidence_refs_json),
    timeCreated: readNumber(row.created_at),
    timeUpdated: readNumber(row.updated_at),
  }
}

/** A stored scalar read as its type or a default, so a row SQLite let through cannot lie to a caller. */
const readNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0)

const readOptionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const readString = (value: unknown): string => (typeof value === "string" ? value : "")

type EvidenceRow = {
  hash: string
  content: string
  bytes: number | null
  truncated: number | null
  created_at: number
  last_read_at: number | null
}

const decodeEvidence = (row: EvidenceRow): EvidenceSlice => ({
  hash: row.hash,
  content: row.content,
  createdAt: row.created_at,
  ...(row.bytes !== null ? { bytes: row.bytes } : {}),
  ...(row.truncated ? { truncated: true } : {}),
})

/** A link's kind read back as one of ours; a hand-edited row with anything else is skipped. */
const evidenceKind = (value: string): EvidenceKind | undefined =>
  value === "signal" || value === "event" || value === "overflow" ? value : undefined

const decodeArtifact = (row: ArtifactRow): Artifact => ({
  id: row.id,
  kind: row.kind as Artifact["kind"],
  title: row.title,
  mime: row.mime,
  producer: row.producer as Artifact["producer"],
  createdAt: row.created_at,
  ...(row.content !== null ? { content: row.content } : {}),
  ...(row.path !== null ? { path: row.path } : {}),
  ...(row.directory !== null ? { directory: row.directory } : {}),
  ...(row.run_id !== null ? { runID: row.run_id } : {}),
  ...(row.task_id !== null ? { taskID: row.task_id } : {}),
  ...(row.session_id !== null ? { sessionID: row.session_id } : {}),
  ...(row.bytes !== null ? { bytes: row.bytes } : {}),
  ...(row.truncated ? { truncated: true } : {}),
  ...(row.hash !== null ? { hash: row.hash } : {}),
  ...(row.pinned ? { pinned: true } : {}),
  ...(row.expires_at !== null ? { expiresAt: row.expires_at } : {}),
})

type EventRow = { seq: number; created_at: number; payload_json: string }

type ActionCredentialRow = {
  name: string
  origin: string
  iv: string
  tag: string
  ciphertext: string
  created_at: number
  updated_at: number
}

const decodeModel = (value: string | null) => {
  if (!value) return undefined
  try {
    const model = JSON.parse(value) as { providerID?: unknown; id?: unknown; variant?: unknown }
    if (typeof model.providerID !== "string" || typeof model.id !== "string") return undefined
    return {
      providerID: model.providerID,
      id: model.id,
      variant: typeof model.variant === "string" ? model.variant : undefined,
    }
  } catch {
    return undefined
  }
}

/** The tasks a task waits for (H-28). A malformed list is treated as none rather than crashing a run. */
const decodeDependsOn = (value: string | null) => {
  if (!value) return undefined
  try {
    const list = JSON.parse(value) as unknown
    if (!Array.isArray(list)) return undefined
    return list.filter((entry): entry is string => typeof entry === "string")
  } catch {
    return undefined
  }
}

/** The condition that lets a task run (H-28). Same rule: an unreadable one means "no condition". */
const decodeWhen = (value: string | null): TaskCondition | undefined => {
  if (!value) return undefined
  try {
    const condition = JSON.parse(value) as { task?: unknown; is?: unknown }
    if (typeof condition.task !== "string" || !Array.isArray(condition.is)) return undefined
    const is = condition.is.filter((entry): entry is TaskCondition["is"][number] => typeof entry === "string")
    return is.length > 0 ? { task: condition.task, is } : undefined
  } catch {
    return undefined
  }
}

const decodeRoutine = (row: RoutineRow, runs: Run[]): Routine => ({
  id: row.id,
  name: row.name,
  description: row.description,
  prompt: row.prompt,
  schedule: JSON.parse(row.schedule_json),
  projectDirectory: row.project_directory ?? undefined,
  agent: row.agent ?? undefined,
  model: decodeModel(row.model_json),
  workflow: decodeRoutineWorkflow(row.workflow_json),
  policy: decodeRoutinePolicy(row.policy_json),
  action: decodeAction(row.action_json),
  allow: decodeAllow(row.allow_json),
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastRunAt: row.last_run_at ?? undefined,
  runs,
})

/**
 * An action a routine or task runs (WA-7), or nothing when the row predates the column.
 *
 * An unreadable value means "no action", never a half-parsed one: a scheduled run must not invent
 * the recipe it is about to drive.
 */
export function decodeAction(value: string | null): ActionTaskInput | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { id?: unknown; inputs?: unknown }
    if (typeof parsed.id !== "string" || !parsed.id.trim()) return undefined
    const inputs =
      parsed.inputs && typeof parsed.inputs === "object" && !Array.isArray(parsed.inputs)
        ? (parsed.inputs as Record<string, unknown>)
        : undefined
    return { id: parsed.id.trim(), ...(inputs ? { inputs } : {}) }
  } catch {
    return undefined
  }
}

/** The allow rules a scheduled action runs under (WA-7). Same rule: unreadable means none. */
export function decodeAllow(value: string | null): BrowserAllowRule[] | undefined {
  if (!value) return undefined
  try {
    return parseAllow(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

/** The same reading for a value that is already parsed, as a run's options store it. */
export function parseAllow(value: unknown): BrowserAllowRule[] | undefined {
  if (!Array.isArray(value)) return undefined
  const rules = value.flatMap((entry): BrowserAllowRule[] => {
    if (!entry || typeof entry !== "object") return []
    const rule = entry as { permission?: unknown; pattern?: unknown; action?: unknown }
    if (rule.action !== "allow") return []
    if (rule.permission !== "browser" && rule.permission !== "browser_sensitive") return []
    if (typeof rule.pattern !== "string" || !rule.pattern) return []
    return [{ permission: rule.permission, pattern: rule.pattern, action: "allow" }]
  })
  return rules.length > 0 ? rules : undefined
}

const encodeAction = (action: ActionTaskInput | undefined): string | null =>
  action ? JSON.stringify({ id: action.id, ...(action.inputs ? { inputs: action.inputs } : {}) }) : null

const encodeAllow = (allow: BrowserAllowRule[] | undefined): string | null =>
  allow && allow.length > 0 ? JSON.stringify(allow) : null

/** A routine's workflow, or nothing when it runs a single prompt (HF-8). */
function decodeRoutineWorkflow(value: string | null): Routine["workflow"] {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { name?: unknown; inputs?: unknown }
    if (typeof parsed.name !== "string" || !parsed.name.trim()) return undefined
    const inputs: Record<string, string> = {}
    if (parsed.inputs && typeof parsed.inputs === "object" && !Array.isArray(parsed.inputs)) {
      for (const [name, entry] of Object.entries(parsed.inputs as Record<string, unknown>)) {
        if (typeof entry === "string") inputs[name] = entry
      }
    }
    return { name: parsed.name.trim(), ...(Object.keys(inputs).length > 0 ? { inputs } : {}) }
  } catch {
    return undefined
  }
}

function decodeRoutinePolicy(value: string | null): Routine["policy"] {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as RunPolicy
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

const decodeSource = (row: RunRow): RunSource =>
  row.source_type === "routine" && row.source_id ? { type: "routine", routineID: row.source_id } : { type: "manual" }

const decodeRun = (row: RunRow): Run => ({
  id: row.id,
  source: decodeSource(row),
  directory: row.directory ?? undefined,
  sessionID: row.session_id ?? undefined,
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at ?? undefined,
  error: row.error ?? undefined,
  ...decodeOptions(row.options),
  ...decodeWorkflow(row.workflow_json),
})

/** A run's workflow (RP-01), or nothing: a row from before it was recorded reads as a plain run. */
const decodeWorkflow = (value: string | null): Pick<Run, "workflow"> => {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as Partial<RunWorkflow>
    if (typeof parsed.name !== "string" || typeof parsed.hash !== "string") return {}
    return {
      workflow: {
        name: parsed.name,
        scope: parsed.scope === "project" ? "project" : "global",
        hash: parsed.hash,
        inputs: Object.fromEntries(
          Object.entries(parsed.inputs ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      },
    }
  } catch {
    return {}
  }
}

/**
 * How a run was asked to behave, kept with the run rather than with the request that started it.
 *
 * A run is driven twice — once when it starts and again when somebody lets it through a gate — and a
 * limit that lived only in the first call would quietly stop applying at the second.
 */
const decodeOptions = (
  value: string | null,
): Pick<
  Run,
  "toolLimitMs" | "outside" | "shell" | "packs" | "worktrees" | "policy" | "paused" | "budgetApproved" | "allow"
> => {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as {
      toolLimitMs?: unknown
      outside?: unknown
      shell?: unknown
      packs?: unknown
      worktrees?: unknown
      policy?: unknown
      paused?: unknown
      budgetApproved?: unknown
      allow?: unknown
    }
    const allow = parseAllow(parsed.allow)
    return {
      ...(typeof parsed.toolLimitMs === "number" && parsed.toolLimitMs > 0 ? { toolLimitMs: parsed.toolLimitMs } : {}),
      ...(parsed.outside === true ? { outside: true } : {}),
      ...(parsed.shell === false ? { shell: false } : {}),
      ...(Array.isArray(parsed.packs)
        ? { packs: parsed.packs.filter((entry): entry is string => typeof entry === "string") }
        : {}),
      ...(parsed.worktrees === true ? { worktrees: true } : {}),
      ...(parsed.policy && typeof parsed.policy === "object" && !Array.isArray(parsed.policy)
        ? { policy: parsed.policy as Run["policy"] }
        : {}),
      ...(parsed.paused === "gate" || parsed.paused === "budget" ? { paused: parsed.paused } : {}),
      ...(parsed.budgetApproved === true ? { budgetApproved: true } : {}),
      ...(allow !== undefined ? { allow } : {}),
    }
  } catch {
    return {}
  }
}

const encodeOptions = (
  run: Pick<
    Run,
    "toolLimitMs" | "outside" | "shell" | "packs" | "worktrees" | "policy" | "paused" | "budgetApproved" | "allow"
  >,
) => {
  const options = {
    ...(run.toolLimitMs ? { toolLimitMs: run.toolLimitMs } : {}),
    ...(run.outside ? { outside: true } : {}),
    ...(run.shell === false ? { shell: false } : {}),
    ...(run.packs && run.packs.length > 0 ? { packs: run.packs } : {}),
    ...(run.worktrees ? { worktrees: true } : {}),
    ...(run.policy ? { policy: run.policy } : {}),
    ...(run.paused ? { paused: run.paused } : {}),
    ...(run.budgetApproved ? { budgetApproved: true } : {}),
    ...(run.allow && run.allow.length > 0 ? { allow: run.allow } : {}),
  }
  return Object.keys(options).length > 0 ? JSON.stringify(options) : null
}

const sourceKey = (source: RunSource) => (source.type === "routine" ? source.routineID : null)

export class SqliteRoutineRepository implements RoutineRepository {
  readonly db: Database
  private readonly listeners = new Set<(entry: StoredEvent) => void>()
  private since: number | undefined

  constructor(private readonly path = process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    // A reader no longer waits behind the writer, and two processes on one file (the app and a dev
    // copy, a CLI) wait for each other's lock instead of failing at once with SQLITE_BUSY (RP-02).
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec("PRAGMA busy_timeout = 5000")
    // A database with no tables yet has no rows a migration could rewrite, so it needs no backup.
    const fresh = (this.db.query("SELECT COUNT(*) AS count FROM sqlite_master").get() as { count: number }).count === 0
    this.db.exec(schema)
    const legacy = this.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'routine_runs'")
      .get() as { name?: string } | null
    if (legacy?.name) this.db.exec(migration)
    // `CREATE TABLE IF NOT EXISTS` leaves a table that already exists alone, columns and all, so a
    // database written before this column existed never gets it. Every desktop app that has ever
    // run has one of those.
    this.addColumn("tasks", "kind", "TEXT NOT NULL DEFAULT 'agent'")
    this.addColumn("tasks", "command", "TEXT")
    this.addColumn("tasks", "attempt", "INTEGER NOT NULL DEFAULT 1")
    this.addColumn("tasks", "retries", "INTEGER")
    this.addColumn("tasks", "retry_of", "TEXT")
    this.addColumn("tasks", "gate", "TEXT")
    this.addColumn("runs", "directory", "TEXT")
    this.addColumn("findings", "source", "TEXT")
    this.addColumn("runs", "options", "TEXT")
    this.addColumn("routines", "workflow_json", "TEXT")
    this.addColumn("routines", "policy_json", "TEXT")
    this.addColumn("routines", "action_json", "TEXT")
    this.addColumn("routines", "allow_json", "TEXT")
    this.addColumn("tasks", "action_json", "TEXT")
    this.addColumn("tasks", "directory", "TEXT")
    this.addColumn("tasks", "depends_on", "TEXT")
    this.addColumn("tasks", "when_json", "TEXT")
    this.addColumn("tasks", "foreach_source", "TEXT")
    this.addColumn("checkpoints", "summary", "TEXT")
    this.addColumn("artifacts", "pinned", "INTEGER")
    this.addColumn("artifacts", "expires_at", "INTEGER")
    this.addColumn("adaptive_decision", "attempted_provider", "TEXT")
    this.addColumn("adaptive_plan", "truncated", "INTEGER NOT NULL DEFAULT 0")
    this.addColumn("reflection_job", "claimed_at", "INTEGER")
    this.addColumn("adaptive_decision", "arm", "TEXT")
    this.addColumn("session_metrics", "arms_json", "TEXT")
    this.addColumn("session_metrics", "rereads_after_compaction", "INTEGER NOT NULL DEFAULT 0")
    this.addColumn("session_metrics", "summary_tokens", "INTEGER NOT NULL DEFAULT 0")
    this.migrateDocumentPaths()
    this.migrateEvidenceSize()
    this.migrate(fresh)
  }

  /**
   * Run the numbered migrations this database has not had yet, each once and in order (AH-C02).
   *
   * The version lives in a `schema_version` table rather than `PRAGMA user_version`: both are
   * transactional, but the table keeps a history — which migration ran, when, and the backup taken
   * before it — that a single integer cannot, and it cannot collide with another tool that sets
   * `user_version` on the same file. Each migration and its version row commit together, so a crash
   * leaves the database at a version it fully reached and the next start resumes from there.
   *
   * Before the first migration that rewrites rows, the file is copied with `VACUUM INTO` (outside any
   * transaction). A backup that cannot be taken stops the start rather than rewriting without one.
   */
  private migrate(fresh: boolean) {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL,
      backup TEXT
    )`)
    const current =
      (this.db.query("SELECT MAX(version) AS version FROM schema_version").get() as { version: number | null })
        .version ?? LEGACY_SCHEMA_VERSION
    // What has not run yet, rather than what is above the newest: versions are handed out in advance
    // to tickets built in parallel, so a database can reach 7 before 6 exists and must still get 6.
    const applied = new Set(
      (this.db.query("SELECT version FROM schema_version").all() as Array<{ version: number }>).map((row) => row.version),
    )
    const pending = this.migrations().filter(
      (migration) => migration.version > LEGACY_SCHEMA_VERSION && !applied.has(migration.version),
    )
    if (pending.length === 0) return
    const backup =
      !fresh && this.path !== ":memory:" && pending.some((migration) => migration.rewrites)
        ? this.backup(current)
        : null
    for (const migration of pending) {
      // Rebuilding a table that others point at needs the keys off while it is swapped: SQLite only
      // honours that pragma outside a transaction. They are checked before the migration commits.
      if (migration.rebuildsTables) this.db.exec("PRAGMA foreign_keys = OFF")
      try {
        this.db.transaction(() => {
          migration.up()
          if (migration.rebuildsTables) {
            const broken = this.db.query("PRAGMA foreign_key_check").all()
            if (broken.length > 0) throw new Error(`Migration ${migration.name} left ${broken.length} broken references`)
          }
          this.db
            .query("INSERT INTO schema_version (version, name, applied_at, backup) VALUES (?1, ?2, ?3, ?4)")
            .run(migration.version, migration.name, Date.now(), backup)
        })()
      } finally {
        if (migration.rebuildsTables) this.db.exec("PRAGMA foreign_keys = ON")
      }
    }
  }

  /** The numbered migrations, oldest first. A version is never reused or edited once released. */
  private migrations(): Array<{ version: number; name: string; rewrites: boolean; rebuildsTables?: boolean; up: () => void }> {
    return [
      {
        version: 2,
        name: "decision-audit-v2",
        rewrites: true,
        up: () => this.migrateDecisionAudit(),
      },
      {
        // A run names the workflow it executed and the file is kept as it ran (RP-01). Existing runs
        // keep no workflow: none was recorded, and guessing one from the tasks would be invented.
        // Flagged as rewriting so the file is copied first: it changes the table holding every run.
        version: 3,
        name: "workflow-identity",
        rewrites: true,
        up: () => {
          this.addColumn("runs", "workflow_json", "TEXT")
          this.db.exec(`CREATE TABLE IF NOT EXISTS workflow_versions (
            hash TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            scope TEXT NOT NULL,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL
          )`)
        },
      },
      {
        // Deleting a run has a defined effect on everything that hangs off it (RP-02). The rows a
        // deleted run left behind are settled first, as decided for this migration: its tasks, which
        // nothing shows, go; its findings and artifacts, which the app still lists, stay and stop
        // pointing at it. Checkpoints keep no key: their git refs live outside the database, so the
        // sweep that removes the refs (TI-15) is what takes them.
        version: 4,
        name: "referential-integrity",
        rewrites: true,
        rebuildsTables: true,
        up: () => this.migrateReferentialIntegrity(),
      },
      {
        // The usage ledger (UL-01, audit §8.4): new tables only, append-only and never pruned. Flagged
        // as rewriting so the file is still copied first, as every schema change is.
        version: 5,
        name: "usage-ledger",
        rewrites: true,
        up: () =>
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS usage_event (
              id TEXT PRIMARY KEY,
              kind TEXT NOT NULL,
              session_id TEXT NOT NULL,
              parent_session_id TEXT,
              root_session_id TEXT,
              message_id TEXT,
              turn_id TEXT,
              engine_seq INTEGER,
              agent TEXT,
              provider_id TEXT,
              model_id TEXT,
              variant TEXT,
              tokens_input INTEGER NOT NULL DEFAULT 0,
              tokens_output INTEGER NOT NULL DEFAULT 0,
              tokens_reasoning INTEGER NOT NULL DEFAULT 0,
              tokens_cache_read INTEGER NOT NULL DEFAULT 0,
              tokens_cache_write INTEGER NOT NULL DEFAULT 0,
              cost_usd REAL,
              cost_basis TEXT NOT NULL,
              billing TEXT NOT NULL,
              started_at INTEGER,
              ended_at INTEGER,
              first_token_ms INTEGER,
              finish TEXT,
              error_type TEXT,
              retry_attempt INTEGER,
              directory TEXT,
              engine_project_id TEXT,
              run_id TEXT,
              task_id TEXT,
              attempt INTEGER,
              routine_id TEXT,
              workflow_name TEXT,
              workflow_hash TEXT,
              purpose TEXT,
              tags_json TEXT
            );
            CREATE INDEX IF NOT EXISTS usage_event_session ON usage_event(session_id, ended_at);
            CREATE INDEX IF NOT EXISTS usage_event_ended ON usage_event(ended_at);
            CREATE INDEX IF NOT EXISTS usage_event_run ON usage_event(run_id);
            CREATE TABLE IF NOT EXISTS tool_event (
              id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              message_id TEXT,
              tool TEXT NOT NULL,
              started_at INTEGER,
              ms INTEGER NOT NULL,
              error INTEGER NOT NULL,
              bytes INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS tool_event_session ON tool_event(session_id, started_at);
          `),
      },
      {
        // How far the usage reconciler (UL-03) has read each engine session: the session's own
        // `time.updated` when its transcript was last turned into ledger rows. A session that has not
        // changed since is not read again, so a restart does not replay every transcript. A new table
        // only; flagged as rewriting so the file is copied first, as every schema change is.
        version: 6,
        name: "usage-reconciled",
        rewrites: true,
        up: () =>
          this.db.exec(`CREATE TABLE IF NOT EXISTS usage_reconciled (
            session_id TEXT PRIMARY KEY,
            engine_updated INTEGER NOT NULL,
            reconciled_at INTEGER NOT NULL
          )`),
      },
      {
        // Who each session works for (UL-04, audit §8.4). The sessions of existing runs are known
        // from their tasks and threads, so they are attributed now and any ledger row already taken
        // for them is stamped. A closing note's or a commit message's session from before was never
        // recorded anywhere, so it stays unattributed rather than guessed from its title.
        version: 7,
        name: "usage-attribution",
        rewrites: true,
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS session_attribution (
              session_id TEXT PRIMARY KEY,
              parent_session_id TEXT,
              source TEXT NOT NULL,
              run_id TEXT,
              task_id TEXT,
              attempt INTEGER,
              routine_id TEXT,
              workflow_name TEXT,
              workflow_hash TEXT,
              purpose TEXT,
              directory TEXT,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS session_attribution_parent ON session_attribution(parent_session_id);
            CREATE INDEX IF NOT EXISTS usage_event_parent ON usage_event(parent_session_id);
          `)
          const sessions = this.db
            .query(
              `SELECT session_id AS sessionID, run_id AS runID, id AS taskID FROM tasks WHERE session_id IS NOT NULL
               UNION ALL
               SELECT session_id, id, NULL FROM runs WHERE session_id IS NOT NULL`,
            )
            .all() as Array<{ sessionID: string; runID: string; taskID: string | null }>
          for (const session of sessions)
            this.attributeSession(session.sessionID, {
              runID: session.runID,
              ...(session.taskID ? { taskID: session.taskID } : {}),
              purpose: "run-task",
            })
        },
      },
      {
        // The usage summary (UL-05) reads the ledger by when each fact happened: the end of a step,
        // or the start of a compaction the transcript gives no end for. An index on that moment keeps
        // a month's summary of a million-row ledger in tens of milliseconds. No rollup table: rows are
        // stamped after they land (UL-04) and re-priced when a model turns out to have no price, so a
        // copy of their sums would go stale, and a day is local, so it moves with the time zone. An
        // index only, but flagged as rewriting so the file is copied first, as every schema change is.
        version: 8,
        name: "usage-summary",
        rewrites: true,
        up: () => this.db.exec("CREATE INDEX IF NOT EXISTS usage_event_at ON usage_event(COALESCE(ended_at, started_at))"),
      },
      {
        // Whether a task met its goal (RP-06): the verdict, why, and who judged it, and the
        // `require: verified` a workflow task may declare. Tasks from before stay unjudged: nobody
        // judged them, and reading a verdict into an old answer now would be inventing one. A run's
        // verdict is not stored at all: it is derived from its tasks whenever the run is read.
        version: 9,
        name: "task-verdict",
        rewrites: true,
        up: () => {
          this.addColumn("tasks", "verdict", "TEXT")
          this.addColumn("tasks", "verdict_reason", "TEXT")
          this.addColumn("tasks", "verdict_source", "TEXT")
          this.addColumn("tasks", "require_verdict", "TEXT")
        },
      },
      {
        // The browser policy (BU-01): standing grants per origin and tier, and the audit of every
        // decision and action. The "always" answers the web-action approver kept in
        // `action-approvals.json` beside the database become grants: a bare origin was a read-only
        // action's consent, so it is kept as "open and read pages" there. An `origin:action` entry
        // was a sensitive action's, which now asks every time, so it is not carried over. The file
        // itself is left where it is.
        version: 10,
        name: "browser-policy",
        rewrites: true,
        up: () => {
          this.db.exec(`
            CREATE TABLE IF NOT EXISTS browser_grants (
              id TEXT PRIMARY KEY,
              origin TEXT NOT NULL,
              tier TEXT NOT NULL,
              scope TEXT NOT NULL,
              session_id TEXT,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS browser_grants_origin ON browser_grants(origin);
            CREATE TABLE IF NOT EXISTS browser_audit (
              id TEXT PRIMARY KEY,
              at INTEGER NOT NULL,
              kind TEXT NOT NULL,
              origin TEXT NOT NULL,
              tier TEXT NOT NULL,
              decision TEXT,
              scope TEXT,
              outcome TEXT,
              reason TEXT,
              action TEXT,
              session_id TEXT,
              run_id TEXT,
              task_id TEXT,
              artifact_id TEXT
            );
            CREATE INDEX IF NOT EXISTS browser_audit_run ON browser_audit(run_id, at);
            CREATE INDEX IF NOT EXISTS browser_audit_session ON browser_audit(session_id, at);
          `)
          for (const origin of this.legacyActionApprovals())
            this.addBrowserGrant({ origin, tier: "navigate", scope: "always" })
        },
      },
    ]
  }

  /** The bare origins the web-action approver remembered before BU-01, if its file is there. */
  private legacyActionApprovals(): string[] {
    if (this.path === ":memory:") return []
    const file = join(dirname(this.path), "action-approvals.json")
    if (!existsSync(file)) return []
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"))
    const always = parsed && typeof parsed === "object" && "always" in parsed ? parsed.always : undefined
    if (!Array.isArray(always)) return []
    return always.filter(
      (entry): entry is string => typeof entry === "string" && URL.canParse(entry) && new URL(entry).origin === entry,
    )
  }

  private migrateReferentialIntegrity() {
    // Rebuilt below, the artifacts table must not be named by a trigger while it is swapped: a run
    // of this migration over a database that already had it (or a later one's) would fail there.
    this.db.exec("DROP TRIGGER IF EXISTS runs_take_harness_artifacts")
    this.db.exec(`
      DELETE FROM tasks WHERE run_id NOT IN (SELECT id FROM runs);
      UPDATE findings SET run_id = NULL WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs);
      UPDATE findings SET task_id = NULL WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks);
      UPDATE artifacts SET run_id = NULL WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs);
      UPDATE artifacts SET task_id = NULL WHERE task_id IS NOT NULL AND task_id NOT IN (SELECT id FROM tasks);
    `)
    this.rebuildWithKeys("tasks", { run_id: "REFERENCES runs(id) ON DELETE CASCADE" })
    this.rebuildWithKeys("findings", {
      run_id: "REFERENCES runs(id) ON DELETE CASCADE",
      task_id: "REFERENCES tasks(id) ON DELETE SET NULL",
    })
    this.rebuildWithKeys("artifacts", {
      run_id: "REFERENCES runs(id) ON DELETE SET NULL",
      task_id: "REFERENCES tasks(id) ON DELETE SET NULL",
    })
    // What the harness itself left on a run goes with the run, unless somebody pinned it; anything an
    // agent or a person made stays, detached by the key above.
    this.db.exec(`CREATE TRIGGER IF NOT EXISTS runs_take_harness_artifacts BEFORE DELETE ON runs BEGIN
      DELETE FROM artifacts WHERE run_id = OLD.id AND producer = 'harness' AND COALESCE(pinned, 0) = 0;
    END`)
  }

  /**
   * A table recreated with foreign keys on some of its columns (RP-02): SQLite cannot add one to an
   * existing table. Every column it has now — the ones `addColumn` added over the years included — is
   * copied with its type, default and constraints, and so are its indexes.
   */
  private rebuildWithKeys(table: string, keys: Record<string, string>) {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string
      type: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>
    const indexes = (
      this.db
        .query("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ?1 AND sql IS NOT NULL")
        .all(table) as Array<{ sql: string }>
    ).map((row) => row.sql)
    const definitions = columns.map((column) =>
      [
        column.name,
        column.type,
        column.pk ? "PRIMARY KEY" : "",
        column.notnull ? "NOT NULL" : "",
        column.dflt_value !== null ? `DEFAULT ${column.dflt_value}` : "",
        keys[column.name] ?? "",
      ]
        .filter(Boolean)
        .join(" "),
    )
    const names = columns.map((column) => column.name).join(", ")
    this.db.exec(`
      CREATE TABLE ${table}_rebuilt (${definitions.join(", ")});
      INSERT INTO ${table}_rebuilt (${names}) SELECT ${names} FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}_rebuilt RENAME TO ${table};
    `)
    for (const sql of indexes) this.db.exec(sql)
  }

  /**
   * The provider-neutral decision audit (AH-C02).
   *
   * `source` moves from `deterministic | jev | fallback` to `baseline | model | fallback`, and which
   * model was involved moves to `provider_id`. A `jev` row answered by a model: its id is the one the
   * row already named (`attempted_provider`, or `provider` before that column existed). A `fallback`
   * row consulted a model that did not win; its id is only known when `attempted_provider` was
   * recorded, and is left missing rather than guessed otherwise. Historical cost and tokens were never
   * measured, so they stay `NULL`, not zero. A source outside the v1 vocabulary is left as it is: the
   * reader keeps the row and exposes the raw value.
   *
   * A plan's `score_source` is migrated the same way rather than only tolerated on read, so the
   * stored vocabulary is one; its model is taken from the decision it points at, `jev` otherwise
   * (the only model that could refine a plan before this version).
   */
  private migrateDecisionAudit() {
    this.addColumn("adaptive_decision", "provider_id", "TEXT")
    this.addColumn("adaptive_decision", "provider_version", "TEXT")
    this.addColumn("adaptive_decision", "cost_usd", "REAL")
    this.addColumn("adaptive_decision", "input_tokens", "INTEGER")
    this.addColumn("adaptive_decision", "label", "TEXT")
    this.addColumn("adaptive_decision", "labeled_at", "INTEGER")
    this.addColumn("adaptive_plan", "score_provider", "TEXT")
    this.db.exec(`
      UPDATE adaptive_decision
         SET source = 'model',
             provider_id = COALESCE(provider_id, attempted_provider, provider),
             provider_version = COALESCE(provider_version, model_version)
       WHERE source = 'jev';
      UPDATE adaptive_decision SET source = 'baseline' WHERE source = 'deterministic';
      UPDATE adaptive_decision
         SET provider_id = COALESCE(provider_id, attempted_provider),
             provider_version = COALESCE(provider_version, model_version)
       WHERE source = 'fallback';
      UPDATE adaptive_plan
         SET score_source = 'model',
             score_provider = COALESCE(
               score_provider,
               (SELECT d.provider_id FROM adaptive_decision d WHERE d.id = adaptive_plan.decision_id AND d.source = 'model'),
               'jev'
             )
       WHERE score_source = 'jev';
      UPDATE adaptive_plan SET score_source = 'baseline' WHERE score_source = 'deterministic';
    `)
  }

  /**
   * Copy the database beside itself as `<db>.bak-v<from>-<timestamp>` and keep the newest few.
   *
   * `VACUUM INTO` writes a consistent copy through SQLite itself, WAL included, so no half-written
   * page is copied; it must run outside a transaction, which is why it runs before the first one.
   */
  private backup(from: number) {
    const target = `${this.path}.bak-v${from}-${new Date().toISOString().replace(/[:.]/g, "-")}`
    this.db.query("VACUUM INTO ?1").run(target)
    const prefix = `${basename(this.path)}.bak-v`
    readdirSync(dirname(this.path))
      .filter((name) => name.startsWith(prefix))
      .map((name) => join(dirname(this.path), name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      .slice(BACKUPS_KEPT)
      .forEach((stale) => rmSync(stale, { force: true }))
    return target
  }

  /**
   * Rows indexed before documents stored a project-relative path kept only what was below
   * `.flupcode/artifacts`, so the same file would look new and be indexed again on the next pass.
   * Repairing them once keeps one convention and stops the duplicate rows.
   */
  private migrateDocumentPaths() {
    const rows = this.db
      .query(
        "SELECT id, path FROM artifacts WHERE kind = 'document' AND path IS NOT NULL AND path <> '' AND directory IS NOT NULL",
      )
      .all() as Array<{ id: string; path: string }>
    for (const row of rows) {
      if (isAbsolute(row.path)) continue
      // An API-made row may already be project-relative with either separator, so compare by
      // normalized segments before deciding it is a legacy one that still needs the prefix.
      const normalized = row.path.replace(/[\\/]+/g, sep)
      if (normalized === DOCUMENTS_DIRECTORY) continue
      if (normalized.startsWith(DOCUMENTS_DIRECTORY + sep)) continue
      this.db.query("UPDATE artifacts SET path = ?1 WHERE id = ?2").run(join(DOCUMENTS_DIRECTORY, row.path), row.id)
    }
  }

  /**
   * Keep the evidence byte total without reading the store on every write (AH-A08).
   *
   * `size` is the stored content's UTF-8 length; rows from before the column are measured once, when
   * it is added. Triggers keep `evidence_total` in step with every insert, content edit and delete,
   * so a put under the limit reads one row, and an upsert of content already stored inserts nothing
   * and counts nothing. A row written without its size (by hand) is measured as it lands. The total
   * is recomputed from the index at every start, so a restart heals any drift, and the eviction
   * order is indexed on the very expression it sorts by.
   */
  private migrateEvidenceSize() {
    if (this.addColumn("evidence", "size", "INTEGER"))
      this.db.exec("UPDATE evidence SET size = LENGTH(CAST(content AS BLOB))")
    this.db.exec(`
      DROP INDEX IF EXISTS evidence_last_read_at;
      CREATE INDEX IF NOT EXISTS evidence_lru ON evidence(COALESCE(last_read_at, created_at), hash, size);
      CREATE TRIGGER IF NOT EXISTS evidence_total_insert AFTER INSERT ON evidence BEGIN
        UPDATE evidence_total SET bytes = bytes + COALESCE(NEW.size, LENGTH(CAST(NEW.content AS BLOB)));
        UPDATE evidence SET size = LENGTH(CAST(NEW.content AS BLOB)) WHERE rowid = NEW.rowid AND size IS NULL;
      END;
      CREATE TRIGGER IF NOT EXISTS evidence_total_update AFTER UPDATE OF content ON evidence BEGIN
        UPDATE evidence_total SET bytes = bytes - OLD.size + LENGTH(CAST(NEW.content AS BLOB));
        UPDATE evidence SET size = LENGTH(CAST(NEW.content AS BLOB)) WHERE rowid = NEW.rowid;
      END;
      CREATE TRIGGER IF NOT EXISTS evidence_total_delete AFTER DELETE ON evidence BEGIN
        UPDATE evidence_total SET bytes = bytes - OLD.size;
      END;
      INSERT OR REPLACE INTO evidence_total (id, bytes) SELECT 1, COALESCE(SUM(size), 0) FROM evidence;
    `)
  }

  /** Add a column a database written before it existed lacks; true when it had to be added. */
  private addColumn(table: string, column: string, definition: string) {
    const columns = this.db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
    if (columns.some((entry) => entry.name === column)) return false
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
    return true
  }

  // ---- routines -------------------------------------------------------------------------------

  list() {
    const rows = this.db.query("SELECT * FROM routines ORDER BY created_at DESC").all() as RoutineRow[]
    // The newest of each routine's runs, as `get` reads them: the scheduler lists routines on every
    // tick, and loading every run a routine ever had made that tick grow with history (RP-02).
    const runs = this.db
      .query(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY started_at DESC) AS rank
           FROM runs WHERE source_type = 'routine'
         ) WHERE rank <= ?1 ORDER BY started_at DESC`,
      )
      .all(ROUTINE_RUNS_LISTED) as RunRow[]
    const byRoutine = new Map<string, Run[]>()
    for (const run of this.runsFrom(runs)) {
      const key = run.source.type === "routine" ? run.source.routineID : ""
      byRoutine.set(key, [...(byRoutine.get(key) ?? []), run])
    }
    return rows.map((row) => decodeRoutine(row, byRoutine.get(row.id) ?? []))
  }

  get(id: string) {
    const row = this.db.query("SELECT * FROM routines WHERE id = ?1").get(id) as RoutineRow | null
    if (!row) return undefined
    return decodeRoutine(row, this.listRuns({ type: "routine", routineID: id }))
  }

  create(input: RoutineInput, options: RoutineCreateOptions = {}) {
    const id = options.id ?? crypto.randomUUID()
    const source: RunSource = { type: "routine", routineID: id }
    const routine: Routine = {
      id,
      ...input,
      enabled: options.enabled ?? true,
      createdAt: options.createdAt ?? Date.now(),
      lastRunAt: options.lastRunAt,
      runs: options.runs?.map((run) => ({ ...run, source })) ?? [],
    }
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO routines
            (id, name, description, prompt, schedule_json, project_directory, agent, model_json, workflow_json, policy_json, action_json, allow_json, enabled, created_at, last_run_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
        )
        .run(
          routine.id,
          routine.name,
          routine.description,
          routine.prompt,
          JSON.stringify(routine.schedule),
          routine.projectDirectory ?? null,
          routine.agent ?? null,
          routine.model ? JSON.stringify(routine.model) : null,
          routine.workflow ? JSON.stringify(routine.workflow) : null,
          routine.policy ? JSON.stringify(routine.policy) : null,
          encodeAction(routine.action),
          encodeAllow(routine.allow),
          routine.enabled ? 1 : 0,
          routine.createdAt,
          routine.lastRunAt ?? null,
        )
      for (const run of routine.runs) this.insertRun(run)
    })()
    this.append({ type: "routine.changed", routine })
    return routine
  }

  update(id: string, input: RoutineInput) {
    if (!this.get(id)) return undefined
    this.db
      .query(
        `UPDATE routines
         SET name = ?1, description = ?2, prompt = ?3, schedule_json = ?4, project_directory = ?5, agent = ?6, model_json = ?7, workflow_json = ?8, policy_json = ?9, action_json = ?10, allow_json = ?11
         WHERE id = ?12`,
      )
      .run(
        input.name,
        input.description,
        input.prompt,
        JSON.stringify(input.schedule),
        input.projectDirectory ?? null,
        input.agent ?? null,
        input.model ? JSON.stringify(input.model) : null,
        input.workflow ? JSON.stringify(input.workflow) : null,
        input.policy ? JSON.stringify(input.policy) : null,
        encodeAction(input.action),
        encodeAllow(input.allow),
        id,
      )
    const routine = this.get(id)
    if (routine) this.append({ type: "routine.changed", routine })
    return routine
  }

  remove(id: string) {
    const removed = this.db.transaction(() => {
      // Runs are keyed by their source rather than owned by a foreign key, so they go explicitly,
      // and the tasks they were made of go with them.
      this.db
        .query(
          `DELETE FROM tasks WHERE run_id IN
             (SELECT id FROM runs WHERE source_type = 'routine' AND source_id = ?1)`,
        )
        .run(id)
      this.db.query("DELETE FROM runs WHERE source_type = 'routine' AND source_id = ?1").run(id)
      this.db.query("DELETE FROM locks WHERE key = ?1").run(routineLockKey(id))
      return this.db.query("DELETE FROM routines WHERE id = ?1").run(id).changes > 0
    })()
    if (removed) this.append({ type: "routine.removed", routineID: id })
    return removed
  }

  setEnabled(id: string, enabled: boolean) {
    this.db.query("UPDATE routines SET enabled = ?1 WHERE id = ?2").run(enabled ? 1 : 0, id)
    const routine = this.get(id)
    if (routine) this.append({ type: "routine.changed", routine })
  }

  markRun(routineID: string, now: number) {
    this.db.query("UPDATE routines SET last_run_at = ?1 WHERE id = ?2").run(now, routineID)
  }

  // ---- runs -----------------------------------------------------------------------------------

  private insertRun(run: Run) {
    this.db
      .query(
        `INSERT OR IGNORE INTO runs
           (id, source_type, source_id, session_id, status, started_at, finished_at, error, directory, options, workflow_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .run(
        run.id,
        run.source.type,
        sourceKey(run.source),
        run.sessionID ?? null,
        run.status,
        run.startedAt,
        run.finishedAt ?? null,
        run.error ?? null,
        run.directory ?? null,
        encodeOptions(run),
        run.workflow ? JSON.stringify(run.workflow) : null,
      )
  }

  startRun(
    source: RunSource,
    now: number,
    directory?: string,
    options: Pick<Run, "toolLimitMs" | "outside" | "shell" | "packs" | "worktrees" | "policy" | "allow" | "workflow"> = {},
  ) {
    const run: Run = { id: crypto.randomUUID(), source, status: "running", startedAt: now, directory, ...options }
    this.db.transaction(() => {
      this.insertRun(run)
      if (source.type === "routine") this.markRun(source.routineID, now)
    })()
    this.append({ type: "run.started", run })
    return run
  }

  /**
   * Runs as the app reads them, each with the verdict its tasks add up to (RP-06).
   *
   * Derived here rather than stored: a check that upgrades a task or a retry that supersedes one
   * changes the run's verdict, and a stored copy would have to be kept in step with every such write.
   * One query covers the whole page of runs.
   */
  private runsFrom(rows: RunRow[]): Run[] {
    if (rows.length === 0) return []
    const judged = this.db
      .query(
        `SELECT id, run_id, retry_of, verdict, verdict_reason, verdict_source FROM tasks
         WHERE run_id IN (SELECT value FROM json_each(?1)) AND (verdict IS NOT NULL OR retry_of IS NOT NULL)`,
      )
      .all(JSON.stringify(rows.map((row) => row.id))) as Array<
      Pick<TaskRow, "id" | "run_id" | "retry_of" | "verdict" | "verdict_reason" | "verdict_source">
    >
    return rows.map((row) => {
      const verdict = runVerdict(
        judged
          .filter((task) => task.run_id === row.id)
          .map((task) => ({ id: task.id, retryOf: task.retry_of ?? undefined, ...decodeVerdict(task) })),
      )
      return { ...decodeRun(row), ...(verdict ? { verdict } : {}) }
    })
  }

  getRun(runID: string) {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?1").get(runID) as RunRow | null
    return row ? this.runsFrom([row])[0] : undefined
  }

  /** A workflow's runs, newest first (RP-01); in one folder when it is given, since a name is per project. */
  listWorkflowRuns(name: string, directory?: string, limit = 50) {
    const rows = this.db
      .query(
        `SELECT * FROM runs
         WHERE json_extract(workflow_json, '$.name') = ?1 AND (?2 IS NULL OR directory = ?2)
         ORDER BY started_at DESC LIMIT ?3`,
      )
      .all(name, directory ?? null, limit) as RunRow[]
    return this.runsFrom(rows)
  }

  /** Keeps a workflow file as a run executed it, once per content (RP-01). */
  recordWorkflowVersion(version: Omit<WorkflowVersion, "createdAt">, now = Date.now()) {
    this.db
      .query("INSERT OR IGNORE INTO workflow_versions (hash, name, scope, source, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(version.hash, version.name, version.scope, version.source, now)
  }

  getWorkflowVersion(hash: string): WorkflowVersion | undefined {
    const row = this.db.query("SELECT * FROM workflow_versions WHERE hash = ?1").get(hash) as {
      hash: string
      name: string
      scope: string
      source: string
      created_at: number
    } | null
    if (!row) return undefined
    return {
      hash: row.hash,
      name: row.name,
      scope: row.scope === "project" ? "project" : "global",
      source: row.source,
      createdAt: row.created_at,
    }
  }

  listRuns(source?: RunSource, limit = 50) {
    const rows = source
      ? (this.db
          .query("SELECT * FROM runs WHERE source_type = ?1 AND source_id IS ?2 ORDER BY started_at DESC LIMIT ?3")
          .all(source.type, sourceKey(source), limit) as RunRow[])
      : (this.db.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?1").all(limit) as RunRow[])
    return this.runsFrom(rows)
  }

  /**
   * Terminal runs finished inside the window that still have no terminal episode, newest first
   * (FH-002).
   *
   * A live capture writes the run's episode id with no `ended_at`, so a run excluded on "a row
   * exists" would never be revisited after a restart marked it failed: its checkpoint would stay
   * `unknown` forever. Only a terminal episode settles a run, so the `NOT EXISTS` requires
   * `ended_at IS NOT NULL`; a terminal run always has `finished_at`, and `captureRun` writes its
   * `endedAt`, so one sweep converges.
   *
   * The sweep's limit has to choose among the runs that actually need a backfill. `listRuns` pages
   * the newest runs whatever their capture state, so filtering afterwards lets already-captured
   * ones exhaust the limit and leaves older ones unswept; the `NOT EXISTS` against the deterministic
   * episode id is what keeps the page filled with runs that need one.
   */
  listRunsWithoutTerminalEpisode(input: { since: number; limit: number }) {
    const rows = this.db
      .query(
        `SELECT * FROM runs
         WHERE status IN ('success', 'failed', 'stopped')
           AND finished_at IS NOT NULL
           AND finished_at >= ?1
           AND NOT EXISTS (
             SELECT 1 FROM session_episodes
             WHERE session_episodes.id = ?2 || runs.id AND session_episodes.ended_at IS NOT NULL
           )
         ORDER BY finished_at DESC
         LIMIT ?3`,
      )
      .all(input.since, RUN_EPISODE_PREFIX, input.limit) as RunRow[]
    return this.runsFrom(rows)
  }

  /**
   * Which of these sessions a harness run owns, as its own thread or a task's (AH-B03).
   *
   * An interactive episode is only for a session no run owns: a run's sessions are the run's
   * episode, never episodes of their own. One query for the whole batch, however long it is.
   */
  sessionsOwnedByRuns(sessionIDs: string[]) {
    if (sessionIDs.length === 0) return new Set<string>()
    const rows = this.db
      .query(
        `SELECT session_id FROM runs WHERE session_id IN (SELECT value FROM json_each(?1))
         UNION
         SELECT session_id FROM tasks WHERE session_id IN (SELECT value FROM json_each(?1))`,
      )
      .all(JSON.stringify(sessionIDs)) as { session_id: string }[]
    return new Set(rows.map((row) => row.session_id))
  }

  listRunning() {
    const rows = this.db
      .query("SELECT * FROM runs WHERE status IN ('running', 'awaiting') ORDER BY started_at DESC")
      .all() as RunRow[]
    return this.runsFrom(rows)
  }

  attachSession(runID: string, sessionID: string) {
    this.db.query("UPDATE runs SET session_id = ?1 WHERE id = ?2").run(sessionID, runID)
    this.attributeSession(sessionID, { runID, purpose: "run-task" })
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
  }

  finishRun(runID: string, status: Exclude<RunStatus, "running">, error?: string, now = Date.now()) {
    this.db
      .query("UPDATE runs SET status = ?1, finished_at = ?2, error = ?3 WHERE id = ?4")
      .run(status, now, error ?? null, runID)
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
  }

  removeRun(runID: string) {
    const removed = this.db.transaction(() => {
      this.db.query("DELETE FROM tasks WHERE run_id = ?1").run(runID)
      return this.db.query("DELETE FROM runs WHERE id = ?1").run(runID).changes > 0
    })()
    if (removed) this.append({ type: "run.removed", runID })
    return removed
  }

  awaitRun(runID: string) {
    this.db.query("UPDATE runs SET status = 'awaiting' WHERE id = ?1 AND status = 'running'").run(runID)
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
  }

  resumeRun(runID: string) {
    const changed =
      this.db.query("UPDATE runs SET status = 'running' WHERE id = ?1 AND status = 'awaiting'").run(runID).changes > 0
    if (!changed) return false
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
    return true
  }

  /** Why a run is waiting: a person at a gate, or a budget it reached (H-30). */
  setPaused(runID: string, paused: "gate" | "budget") {
    this.patchOptions(runID, { paused })
  }

  /** Somebody said to carry on past the budget (H-30), so it is not checked again. */
  approveBudget(runID: string) {
    this.patchOptions(runID, { budgetApproved: true, paused: undefined })
  }

  private patchOptions(runID: string, patch: Pick<Run, "paused" | "budgetApproved">) {
    const run = this.getRun(runID)
    if (!run) return
    this.db.query("UPDATE runs SET options = ?1 WHERE id = ?2").run(encodeOptions({ ...run, ...patch }), runID)
    const next = this.getRun(runID)
    if (next) this.append({ type: "run.changed", run: next })
  }

  /**
   * Put a finished run back to running so a new task can be done (H-12).
   *
   * A manual retry adds a task to the run it belongs to rather than starting a second run, so the
   * run stays the thing that is being supervised. A run already running or waiting at a gate is left
   * alone: the first would pick the task up on its own, and the second has nobody driving it.
   */
  reopenRun(runID: string) {
    const changed =
      this.db
        .query("UPDATE runs SET status = 'running', finished_at = NULL, error = NULL WHERE id = ?1 AND status NOT IN ('running', 'awaiting')")
        .run(runID).changes > 0
    if (!changed) return false
    const run = this.getRun(runID)
    if (run) this.append({ type: "run.changed", run })
    return true
  }

  // ---- artifacts ------------------------------------------------------------------------------

  addArtifact(input: ArtifactInput, now = Date.now()) {
    const full = input.content ?? ""
    const truncated = full.length > ARTIFACT_LIMIT
    // Cut rather than refused: a report that is too long is still worth most of its first page, and
    // saying how much was cut is more use than storing nothing.
    const content = input.content === undefined ? undefined : truncated ? full.slice(0, ARTIFACT_LIMIT) : full
    const artifact: Artifact = {
      id: crypto.randomUUID(),
      ...input,
      mime: input.mime ?? "text/markdown",
      createdAt: now,
      ...(content !== undefined ? { content } : {}),
      ...(truncated ? { bytes: full.length, truncated: true } : {}),
      // An explicit identity wins: a tool-dropped artifact is recognised by its own id, not by words
      // that may repeat (H-14).
      ...(input.hash ? { hash: input.hash } : content !== undefined ? { hash: artifactHash(content) } : {}),
    }
    this.db
      .query(
        `INSERT INTO artifacts
           (id, directory, run_id, task_id, session_id, kind, title, mime, content, path, bytes, truncated, hash,
            producer, pinned, expires_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
      )
      .run(
        artifact.id,
        artifact.directory ?? null,
        artifact.runID ?? null,
        artifact.taskID ?? null,
        artifact.sessionID ?? null,
        artifact.kind,
        artifact.title,
        artifact.mime,
        artifact.content ?? null,
        artifact.path ?? null,
        artifact.bytes ?? null,
        artifact.truncated ? 1 : null,
        artifact.hash ?? null,
        artifact.producer,
        artifact.pinned ? 1 : null,
        artifact.expiresAt ?? null,
        artifact.createdAt,
      )
    this.append({ type: "artifact.created", artifact })
    return artifact
  }

  listArtifacts(filter: { directory?: string; runID?: string; kind?: ArtifactKind; q?: string } = {}, limit = 100) {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.directory) {
      values.push(filter.directory)
      where.push(`directory = ?${values.length}`)
    }
    if (filter.runID) {
      values.push(filter.runID)
      where.push(`run_id = ?${values.length}`)
    }
    if (filter.kind) {
      values.push(filter.kind)
      where.push(`kind = ?${values.length}`)
    }
    // Text search over title and inline content (HF-7). LIKE wildcards in the query are escaped
    // so searching for `100%` finds that, not everything.
    if (filter.q?.trim()) {
      const needle = `%${filter.q.trim().replace(/[\\%_]/g, (char) => `\\${char}`)}%`
      values.push(needle, needle)
      where.push(`(title LIKE ?${values.length - 1} ESCAPE '\\' OR content LIKE ?${values.length} ESCAPE '\\')`)
    }
    values.push(limit)
    const rows = this.db
      .query(
        `SELECT * FROM artifacts ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY COALESCE(pinned, 0) DESC, created_at DESC LIMIT ?${values.length}`,
      )
      .all(...(values as never[])) as ArtifactRow[]
    return rows.map(decodeArtifact)
  }

  getArtifact(id: string) {
    const row = this.db.query("SELECT * FROM artifacts WHERE id = ?1").get(id) as ArtifactRow | null
    return row ? decodeArtifact(row) : undefined
  }

  setArtifactPinned(id: string, pinned: boolean) {
    const changed = this.db.query("UPDATE artifacts SET pinned = ?1 WHERE id = ?2").run(pinned ? 1 : null, id).changes
    if (!changed) return undefined
    const artifact = this.getArtifact(id)
    if (artifact) this.append({ type: "artifact.changed", artifact })
    return artifact
  }

  setArtifactRetention(id: string, expiresAt: number | undefined) {
    const changed = this.db
      .query("UPDATE artifacts SET expires_at = ?1 WHERE id = ?2")
      .run(expiresAt ?? null, id).changes
    if (!changed) return undefined
    const artifact = this.getArtifact(id)
    if (artifact) this.append({ type: "artifact.changed", artifact })
    return artifact
  }

  /**
   * Forget what was told to expire (H-14). Never a pinned one: it was explicitly kept, and a sweep
   * that ignores that is worse than no sweep. Nothing is removed by a default — only a stated date.
   */
  removeExpiredArtifacts(now = Date.now()) {
    const removed = this.db
      .query("DELETE FROM artifacts WHERE expires_at IS NOT NULL AND expires_at <= ?1 AND COALESCE(pinned, 0) = 0")
      .run(now).changes
    return removed
  }

  /**
   * Checkpoints (H-15). The commit lives in the reader's own repository; this is the index of them,
   * which is what lets the app list them without walking git's refs on every render.
   */
  addCheckpoint(checkpoint: Checkpoint) {
    this.db
      .query(
        `INSERT INTO checkpoints (id, directory, sha, title, summary, run_id, task_id, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .run(
        checkpoint.id,
        checkpoint.directory,
        checkpoint.sha,
        checkpoint.title,
        checkpoint.summary ?? null,
        checkpoint.runID ?? null,
        checkpoint.taskID ?? null,
        checkpoint.createdAt,
      )
    this.append({ type: "checkpoint.added", checkpoint })
    return checkpoint
  }

  listCheckpoints(filter: { directory?: string; runID?: string } = {}, limit = 50): Checkpoint[] {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.directory) {
      values.push(filter.directory)
      where.push(`directory = ?${values.length}`)
    }
    if (filter.runID) {
      values.push(filter.runID)
      where.push(`run_id = ?${values.length}`)
    }
    values.push(limit)
    const rows = this.db
      .query(
        `SELECT * FROM checkpoints ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC LIMIT ?${values.length}`,
      )
      .all(...(values as never[])) as CheckpointRow[]
    return rows.map(decodeCheckpoint)
  }

  /** By id, however old: a point the list showed once must still be found to restore it (TI-15). */
  getCheckpoint(id: string) {
    const row = this.db.query("SELECT * FROM checkpoints WHERE id = ?1").get(id) as CheckpointRow | null
    return row ? decodeCheckpoint(row) : undefined
  }

  /**
   * Forgets the points nobody can reach any more (TI-15): those of a run that is gone, and those of a
   * run beyond its newest `keepPerRun`. A point of no run (taken by hand, or before a restore) is
   * never one of them. Hands back what went, so the caller can drop the refs that kept the commits.
   */
  removeStaleCheckpoints(keepPerRun = CHECKPOINTS_KEPT_PER_RUN) {
    const rows = this.db
      .query(
        `DELETE FROM checkpoints WHERE id IN (
           SELECT id FROM checkpoints WHERE run_id IS NOT NULL AND run_id NOT IN (SELECT id FROM runs)
           UNION
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY created_at DESC, rowid DESC) AS rank
             FROM checkpoints WHERE run_id IS NOT NULL
           ) WHERE rank > ?1
         ) RETURNING *`,
      )
      .all(keepPerRun) as CheckpointRow[]
    for (const row of rows) this.append({ type: "checkpoint.removed", checkpointID: row.id })
    return rows.map(decodeCheckpoint)
  }

  removeCheckpoint(id: string) {
    const removed = this.db.query("DELETE FROM checkpoints WHERE id = ?1").run(id).changes > 0
    if (removed) this.append({ type: "checkpoint.removed", checkpointID: id })
    return removed
  }

  /**
   * Every task with the run it belonged to (H-16).
   *
   * One query rather than walking runs and asking for each one's tasks: the adding up happens in
   * `summarise`, and this only has to hand it rows.
   *
   * A view of the usage ledger since UL-05: a task's tokens and cost are its ledger rows' (its
   * session, its subagents and its retried steps), no longer the last answer's input and output the
   * task kept. Tokens are input, output and reasoning, without the cache, as before. A task whose
   * rows have no price at all has no cost; the old shape has no word for unpriced, so its sums add
   * it as nothing. The summary (`usageTotals`) is what says unpriced.
   */
  usageRows(filter: { directory?: string; since?: number } = {}): UsageRow[] {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.directory) {
      values.push(filter.directory)
      where.push(`runs.directory = ?${values.length}`)
    }
    if (filter.since !== undefined) {
      values.push(filter.since)
      where.push(`runs.started_at >= ?${values.length}`)
    }
    const rows = this.db
      .query(
        // Per task through the run index, so the ledger is not grouped whole for every read.
        `SELECT tasks.*, runs.directory AS run_directory,
           (SELECT SUM(tokens_input + tokens_output + tokens_reasoning) FROM usage_event e
             WHERE e.run_id = tasks.run_id AND e.task_id = tasks.id) AS ledger_tokens,
           (SELECT SUM(CASE WHEN cost_basis != 'unpriced' THEN cost_usd END) FROM usage_event e
             WHERE e.run_id = tasks.run_id AND e.task_id = tasks.id) AS ledger_cost
         FROM tasks JOIN runs ON runs.id = tasks.run_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
      )
      .all(...(values as never[])) as Array<
      TaskRow & { run_directory: string | null; ledger_tokens: number | null; ledger_cost: number | null }
    >
    return rows.map((row) => {
      const model = row.model_json ? (JSON.parse(row.model_json) as { providerID: string; id: string }) : undefined
      return {
        runID: row.run_id,
        taskID: row.id,
        name: row.name,
        // Old rows predate both columns, and their defaults are what they would have had.
        kind: row.kind ?? "agent",
        attempt: row.attempt ?? 1,
        status: row.status,
        ...(row.run_directory ? { directory: row.run_directory } : {}),
        ...(row.agent ? { agent: row.agent } : {}),
        ...(model ? { model } : {}),
        ...(row.started_at ? { startedAt: row.started_at } : {}),
        ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
        ...(row.ledger_tokens !== null ? { tokens: row.ledger_tokens } : {}),
        ...(row.ledger_cost !== null ? { cost: row.ledger_cost } : {}),
      }
    })
  }

  /** Findings (H-32). Anchored to a file and usually to a line, so the diff can carry them. */
  addFindings(
    input: Array<Omit<Finding, "id" | "createdAt">>,
    now = Date.now(),
  ): Finding[] {
    if (input.length === 0) return []
    const findings = input.map((entry) => ({ ...entry, id: crypto.randomUUID(), createdAt: now }))
    this.db.transaction(() => {
      for (const finding of findings) {
        this.db
          .query(
            `INSERT INTO findings (id, directory, run_id, task_id, file, line, severity, title, detail, source, resolved, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          )
          .run(
            finding.id,
            finding.directory ?? null,
            finding.runID ?? null,
            finding.taskID ?? null,
            finding.file,
            finding.line ?? null,
            finding.severity,
            finding.title,
            finding.detail ?? null,
            finding.source ?? null,
            null,
            finding.createdAt,
          )
      }
    })()
    this.append({ type: "findings.added", findings })
    return findings
  }

  listFindings(filter: { directory?: string; runID?: string; resolved?: boolean } = {}, limit = 500): Finding[] {
    const where: string[] = []
    const values: unknown[] = []
    if (filter.directory) {
      values.push(filter.directory)
      where.push(`directory = ?${values.length}`)
    }
    if (filter.runID) {
      values.push(filter.runID)
      where.push(`run_id = ?${values.length}`)
    }
    if (filter.resolved === false) where.push("resolved IS NULL")
    values.push(limit)
    const rows = this.db
      .query(
        `SELECT * FROM findings ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC LIMIT ?${values.length}`,
      )
      .all(...(values as never[])) as FindingRow[]
    return rows.map(decodeFinding)
  }

  resolveFinding(id: string, resolved: boolean) {
    const changed = this.db
      .query("UPDATE findings SET resolved = ?2 WHERE id = ?1")
      .run(id, resolved ? 1 : null).changes
    if (changed === 0) return undefined
    const row = this.db.query("SELECT * FROM findings WHERE id = ?1").get(id) as FindingRow | null
    const finding = row ? decodeFinding(row) : undefined
    if (finding) this.append({ type: "finding.changed", finding })
    return finding
  }

  removeFindings(filter: { runID?: string } = {}) {
    if (!filter.runID) return 0
    return this.db.query("DELETE FROM findings WHERE run_id = ?1").run(filter.runID).changes
  }

  removeArtifact(id: string) {
    return this.db.query("DELETE FROM artifacts WHERE id = ?1").run(id).changes > 0
  }

  // ---- what a reader keeps about a session (H-18) ---------------------------------------------

  listSessionPrefs() {
    // Newest first, with the id as a tie-break: two changes can share a millisecond, and a list
    // whose order wobbles between reads is one nothing can be asserted about.
    const rows = this.db
      .query("SELECT * FROM session_prefs ORDER BY updated_at DESC, session_id ASC")
      .all() as SessionPrefsRow[]
    return rows.map(decodeSessionPrefs)
  }

  getSessionPrefs(sessionID: string) {
    const row = this.db.query("SELECT * FROM session_prefs WHERE session_id = ?1").get(sessionID) as
      | SessionPrefsRow
      | null
    return row ? decodeSessionPrefs(row) : undefined
  }

  setSessionPinned(sessionID: string, pinned: boolean, at?: number) {
    return this.writePrefs(sessionID, { pinned }, at)
  }

  setSessionTags(sessionID: string, tags: string[], at?: number) {
    // Kept in the order given, without repeats: a tag a reader typed twice is one tag.
    return this.writePrefs(sessionID, { tags: [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))] }, at)
  }

  /**
   * One row per session, merged rather than replaced.
   *
   * Pinning a session must not drop its tags, and tagging one must not unpin it, so the change is
   * applied to what is there. An empty result is removed outright: a row that says nothing is not
   * worth keeping, and it would make the list say a reader had kept something they had not.
   *
   * `at` exists for tests: two changes in the same millisecond used to leave "newest first"
   * to the clock, which made the same two calls order differently between machines.
   */
  private writePrefs(sessionID: string, change: { pinned?: boolean; tags?: string[] }, at = Date.now()): SessionPrefs {
    const current = this.getSessionPrefs(sessionID)
    const next: SessionPrefs = {
      sessionID,
      pinned: change.pinned ?? current?.pinned ?? false,
      tags: change.tags ?? current?.tags ?? [],
      updatedAt: at,
    }
    if (!next.pinned && next.tags.length === 0) {
      this.db.query("DELETE FROM session_prefs WHERE session_id = ?1").run(sessionID)
    } else {
      this.db
        .query(
          `INSERT INTO session_prefs (session_id, pinned, tags_json, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(session_id) DO UPDATE SET pinned = ?2, tags_json = ?3, updated_at = ?4`,
        )
        .run(sessionID, next.pinned ? 1 : null, JSON.stringify(next.tags), next.updatedAt)
    }
    // Published either way: a reader that stopped pinning has to learn it lost its pin too.
    this.append({ type: "session.changed", prefs: next })
    return next
  }

  listStash() {
    const rows = this.db.query("SELECT * FROM stashed_prompts ORDER BY created_at DESC").all() as StashedPromptRow[]
    return rows.map(decodeStash)
  }

  addToStash(text: string, now = Date.now()) {
    const prompt: StashedPrompt = { id: crypto.randomUUID(), text, createdAt: now }
    this.db
      .query("INSERT INTO stashed_prompts (id, text, created_at) VALUES (?1, ?2, ?3)")
      .run(prompt.id, prompt.text, prompt.createdAt)
    this.append({ type: "stash.added", prompt })
    return prompt
  }

  removeFromStash(id: string) {
    const removed = this.db.query("DELETE FROM stashed_prompts WHERE id = ?1").run(id).changes > 0
    if (removed) this.append({ type: "stash.removed", promptID: id })
    return removed
  }

  /** Packs for this folder plus the global ones, by name. */
  listPacks(directory?: string) {
    const rows = this.db
      .query("SELECT * FROM context_packs WHERE directory IS NULL OR directory = ?1 ORDER BY name ASC")
      .all(directory ?? null) as ContextPackRow[]
    return rows.map(decodePack)
  }

  /**
   * One pack per name and folder: saving a name that is already there replaces it.
   *
   * Otherwise a reader who fixes a typo ends up with two packs whose names differ by a letter, and
   * the menu they pick from is worse for it.
   */
  savePack(input: { name: string; refs: string[]; directory?: string }) {
    const name = input.name.trim()
    const refs = [...new Set(input.refs.map((ref) => ref.trim()).filter(Boolean))]
    const createdAt = Date.now()
    const id = crypto.randomUUID()
    this.db
      .query("DELETE FROM context_packs WHERE name = ?1 AND directory IS ?2")
      .run(name, input.directory ?? null)
    this.db
      .query("INSERT INTO context_packs (id, name, refs_json, directory, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
      .run(id, name, JSON.stringify(refs), input.directory ?? null, createdAt)
    return { id, name, refs, ...(input.directory ? { directory: input.directory } : {}), createdAt }
  }

  removePack(id: string) {
    return this.db.query("DELETE FROM context_packs WHERE id = ?1").run(id).changes > 0
  }

  /** Keeps a conversation so a link can read it (H-35). */
  saveShare(input: { title: string; markdown: string }) {
    const share: SharedConversation = {
      id: crypto.randomUUID(),
      title: input.title.trim() || "Conversation",
      markdown: input.markdown,
      createdAt: Date.now(),
    }
    this.db
      .query("INSERT INTO shared_conversations (id, title, markdown, created_at) VALUES (?1, ?2, ?3, ?4)")
      .run(share.id, share.title, share.markdown, share.createdAt)
    return share
  }

  getShare(id: string) {
    const row = this.db.query("SELECT * FROM shared_conversations WHERE id = ?1").get(id) as SharedConversationRow | null
    return row ? decodeShare(row) : undefined
  }

  /** A project's notes, oldest first, so they read in the order they were written (H-37). */
  listProjectMemory(directory: string) {
    const rows = this.db
      .query("SELECT * FROM project_memory WHERE directory = ?1 ORDER BY created_at ASC, rowid ASC")
      .all(directory) as ProjectMemoryRow[]
    return rows.map(decodeMemory)
  }

  addProjectMemory(input: { directory: string; text: string }) {
    const note: ProjectMemory = {
      id: crypto.randomUUID(),
      directory: input.directory,
      text: input.text.trim(),
      createdAt: Date.now(),
    }
    this.db
      .query("INSERT INTO project_memory (id, directory, text, created_at) VALUES (?1, ?2, ?3, ?4)")
      .run(note.id, note.directory, note.text, note.createdAt)
    return note
  }

  removeProjectMemory(id: string) {
    return this.db.query("DELETE FROM project_memory WHERE id = ?1").run(id).changes > 0
  }

  removeFinishedRuns() {
    const removed = this.db.transaction(() => {
      const going = "status IN ('running', 'awaiting')"
      const rows = this.db.query(`SELECT id FROM runs WHERE NOT ${going}`).all() as Array<{ id: string }>
      const ids = rows.map((row) => row.id)
      if (ids.length === 0) return ids
      this.db.query(`DELETE FROM tasks WHERE run_id IN (SELECT id FROM runs WHERE NOT ${going})`).run()
      this.db.query(`DELETE FROM runs WHERE NOT ${going}`).run()
      return ids
    })()
    // One event per run, the same one a single delete sends: a reader that already handles it needs
    // to learn nothing new to keep up with a clear-out.
    for (const id of removed) this.append({ type: "run.removed", runID: id })
    return removed
  }

  recoverRunning(now: number) {
    this.db
      .query(
        `UPDATE runs
         SET status = 'failed', finished_at = ?1, error = 'Harness server restarted while the run was active'
         WHERE status IN ('running', 'awaiting')`,
      )
      .run(now)
    // Work in flight died with the process, but its row says otherwise. Back to queued with the
    // reason on it, so a resume picks it up — with the caveat that its side effects may already
    // have happened, which the resume names (HF-5).
    this.requeueActiveTasks("Harness server restarted while the task was active")
    this.db.query("DELETE FROM locks").run()
  }

  /**
   * In-flight rows back to queued (HF-5).
   *
   * A task the runner had started but never finished has an unknown outcome: the engine may have
   * done the work and only the record was lost. Requeueing keeps the reason visible so a resume is
   * an explicit decision, not a silent replay.
   */
  requeueActiveTasks(reason: string) {
    return this.db.transaction(() => {
      const rows = this.db.query("SELECT id FROM tasks WHERE status = 'running'").all() as Array<{ id: string }>
      for (const row of rows) {
        this.db.query("UPDATE tasks SET status = 'queued', error = ?1 WHERE id = ?2 AND status = 'running'").run(reason, row.id)
        const task = this.getTask(row.id)
        if (task) this.append({ type: "task.changed", task })
      }
      return rows.map((row) => row.id)
    })()
  }

  // ---- tasks ----------------------------------------------------------------------------------

  addTasks(runID: string, inputs: TaskInput[]) {
    const existing = this.db.query("SELECT COUNT(*) as n FROM tasks WHERE run_id = ?1").get(runID) as { n: number }
    const tasks = inputs.map((input, index) => ({
      ...input,
      kind: input.kind ?? ("agent" as const),
      attempt: input.attempt ?? 1,
      id: crypto.randomUUID(),
      runID,
      position: existing.n + index,
      status: "queued" as const,
    }))
    this.db.transaction(() => {
      for (const task of tasks) {
        this.db
          .query(
            `INSERT INTO tasks
               (id, run_id, position, name, prompt, kind, command, action_json, attempt, retries, retry_of, gate, agent, model_json, depends_on, when_json, foreach_source, require_verdict, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, 'queued')`,
          )
          .run(
            task.id,
            runID,
            task.position,
            task.name,
            task.prompt,
            task.kind,
            task.command ?? null,
            encodeAction(task.action),
            task.attempt,
            task.retries ?? null,
            task.retryOf ?? null,
            task.gate ?? null,
            task.agent ?? null,
            task.model ? JSON.stringify(task.model) : null,
            task.dependsOn !== undefined ? JSON.stringify(task.dependsOn) : null,
            task.when ? JSON.stringify(task.when) : null,
            task.foreach ?? null,
            task.require ?? null,
          )
      }
    })()
    for (const task of tasks) this.append({ type: "task.changed", task })
    return tasks
  }

  listTasks(runID: string) {
    const rows = this.db
      .query("SELECT * FROM tasks WHERE run_id = ?1 ORDER BY position ASC")
      .all(runID) as TaskRow[]
    return rows.map(decodeTask)
  }

  getTask(taskID: string) {
    const row = this.db.query("SELECT * FROM tasks WHERE id = ?1").get(taskID) as TaskRow | null
    return row ? decodeTask(row) : undefined
  }

  startTask(taskID: string, now: number) {
    this.db.query("UPDATE tasks SET status = 'running', started_at = ?1 WHERE id = ?2").run(now, taskID)
    return this.publishTask(taskID)
  }

  attachTaskSession(taskID: string, sessionID: string) {
    this.db.query("UPDATE tasks SET session_id = ?1 WHERE id = ?2").run(sessionID, taskID)
    const task = this.getTask(taskID)
    if (task) this.attributeSession(sessionID, { runID: task.runID, taskID, purpose: "run-task" })
    this.publishTask(taskID)
  }

  /** The tree a task runs in (H-29): the primary checkout, or the worktree it was given. */
  attachTaskDirectory(taskID: string, directory: string) {
    this.db.query("UPDATE tasks SET directory = ?1 WHERE id = ?2").run(directory, taskID)
    this.publishTask(taskID)
  }

  finishTask(
    taskID: string,
    status: Exclude<TaskStatus, "queued" | "running">,
    result: { error?: string; output?: string; tokens?: number; cost?: number } = {},
    now = Date.now(),
  ) {
    this.db
      .query(
        `UPDATE tasks SET status = ?1, finished_at = ?2, error = ?3, output = ?4, tokens = ?5, cost = ?6
         WHERE id = ?7`,
      )
      .run(
        status,
        now,
        result.error ?? null,
        result.output ?? null,
        result.tokens ?? null,
        result.cost ?? null,
        taskID,
      )
    this.publishTask(taskID)
  }

  /**
   * Records whether a task met its goal (RP-06), and tells the app about the task and its run: the
   * run's verdict is derived from its tasks, so it changes with them.
   */
  setTaskVerdict(taskID: string, verdict: TaskVerdict) {
    this.db
      .query("UPDATE tasks SET verdict = ?1, verdict_reason = ?2, verdict_source = ?3 WHERE id = ?4")
      .run(verdict.value, verdict.reason, verdict.source, taskID)
    const task = this.publishTask(taskID)
    const run = task ? this.getRun(task.runID) : undefined
    if (run) this.append({ type: "run.changed", run })
    return task
  }

  private publishTask(taskID: string) {
    const task = this.getTask(taskID)
    if (task) this.append({ type: "task.changed", task })
    return task
  }

  // ---- session episodes (FH-001) --------------------------------------------------------------

  /**
   * Keep one session that did something, by id.
   *
   * A second write with the same id is the same episode seen again — a capture that was retried, or
   * an outcome added later — so it replaces the row rather than doubling it, keeps `timeCreated` and
   * moves `timeUpdated`.
   */
  createEpisode(input: EpisodeInput, now = Date.now()) {
    const id = input.id ?? crypto.randomUUID()
    const existing = this.db.query("SELECT created_at FROM session_episodes WHERE id = ?1").get(id) as
      | { created_at: number }
      | null
    const episode: SessionEpisode = {
      id,
      sessionID: input.sessionID,
      projectID: input.projectID,
      ...(input.runID ? { runID: input.runID } : {}),
      objective: input.objective,
      toolCalls: input.toolCalls,
      files: input.files,
      commands: input.commands,
      failures: input.failures,
      verifications: input.verifications,
      outcome: normalizeOutcome(input.outcome),
      startedAt: input.startedAt,
      ...(input.endedAt !== undefined ? { endedAt: input.endedAt } : {}),
      evidenceRefs: input.evidenceRefs,
      timeCreated: existing?.created_at ?? now,
      timeUpdated: now,
    }
    this.db
      .query(
        `INSERT INTO session_episodes
           (id, session_id, project_id, run_id, objective, tool_calls, files_json, commands_json,
            failures_json, verifications_json, outcome, started_at, ended_at, evidence_refs_json,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           project_id = excluded.project_id,
           run_id = excluded.run_id,
           objective = excluded.objective,
           tool_calls = excluded.tool_calls,
           files_json = excluded.files_json,
           commands_json = excluded.commands_json,
           failures_json = excluded.failures_json,
           verifications_json = excluded.verifications_json,
           outcome = excluded.outcome,
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           evidence_refs_json = excluded.evidence_refs_json,
           updated_at = excluded.updated_at`,
      )
      .run(
        episode.id,
        episode.sessionID,
        episode.projectID,
        episode.runID ?? null,
        episode.objective,
        episode.toolCalls,
        JSON.stringify(episode.files),
        JSON.stringify(episode.commands),
        JSON.stringify(episode.failures),
        JSON.stringify(episode.verifications),
        episode.outcome,
        episode.startedAt,
        episode.endedAt ?? null,
        JSON.stringify(episode.evidenceRefs),
        episode.timeCreated,
        episode.timeUpdated,
      )
    return episode
  }

  getEpisode(id: string) {
    const row = this.db.query("SELECT * FROM session_episodes WHERE id = ?1").get(id) as EpisodeRow | null
    return row ? decodeEpisode(row) : undefined
  }

  listEpisodes(filter: EpisodeFilter = {}) {
    const limit = normalizeEpisodeLimit(filter.limit)
    if (limit === 0) return []
    const where: string[] = []
    const values: unknown[] = []
    if (filter.projectID) {
      values.push(filter.projectID)
      where.push(`project_id = ?${values.length}`)
    }
    if (filter.sessionID) {
      values.push(filter.sessionID)
      where.push(`session_id = ?${values.length}`)
    }
    if (filter.runID) {
      values.push(filter.runID)
      where.push(`run_id = ?${values.length}`)
    }
    const select = `SELECT * FROM session_episodes ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, rowid ASC`
    const rows = (
      limit === undefined
        ? this.db.query(select).all(...(values as never[]))
        : this.db.query(`${select} LIMIT ?${values.length + 1}`).all(...(values as never[]), limit)
    ) as EpisodeRow[]
    return rows.map(decodeEpisode)
  }

  // ---- evidence (FH-006) ----------------------------------------------------------------------

  /**
   * Keep one slice, addressed by the sha256 of the text that is stored (FH-006).
   *
   * The same text put twice is one row, so a recapture does not grow the store; a slice past the
   * limit is cut and says how much it was, because losing evidence is worse than marking it. The
   * total is enforced after every write, reading one row while under it, and nothing here throws: no
   * capture may fail because its evidence could not be kept.
   */
  putEvidence(input: EvidenceInput, now = Date.now()): EvidenceSlice | undefined {
    return this.storeEvidence(input, EVIDENCE_SLICE_LIMIT, now)
  }

  private storeEvidence(input: EvidenceInput, limit: number, now: number): EvidenceSlice | undefined {
    try {
      if (!input.content) return undefined
      const sliced = sliceEvidence(input, limit)
      const hash = evidenceHash(sliced.content)
      this.db
        .query(
          `INSERT INTO evidence (hash, content, bytes, truncated, created_at, last_read_at, size)
           VALUES (?1, ?2, ?3, ?4, ?5, NULL, LENGTH(CAST(?2 AS BLOB)))
           ON CONFLICT(hash) DO UPDATE SET
             truncated = CASE WHEN excluded.truncated = 1 THEN 1 ELSE evidence.truncated END,
             bytes = CASE
               WHEN excluded.bytes IS NOT NULL AND (evidence.bytes IS NULL OR excluded.bytes > evidence.bytes)
               THEN excluded.bytes ELSE evidence.bytes END`,
        )
        .run(hash, sliced.content, sliced.bytes ?? null, sliced.truncated ? 1 : null, now)
      const evicted = this.evictEvidence()
      if (evicted > 0) console.warn(`[flupcode] evicted ${evicted} evidence slice(s) past the total limit`)
      const row = this.db.query("SELECT * FROM evidence WHERE hash = ?1").get(hash) as EvidenceRow | null
      return row ? decodeEvidence(row) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * A slice by its address, verified rather than trusted (FH-006).
   *
   * The hash is recomputed over the stored text, so a row edited by hand reads as `undefined`
   * instead of handing a caller text that is not what its address claims. Reading marks it used.
   */
  getEvidence(hash: string, now = Date.now()): EvidenceSlice | undefined {
    try {
      if (!isEvidenceHash(hash)) return undefined
      const row = this.db.query("SELECT * FROM evidence WHERE hash = ?1").get(hash) as EvidenceRow | null
      if (!row) return undefined
      if (evidenceHash(row.content) !== row.hash) return undefined
      // Recency is bookkeeping: a read that found its slice is not lost because marking it failed.
      try {
        this.db.query("UPDATE evidence SET last_read_at = ?1 WHERE hash = ?2").run(now, hash)
      } catch {}
      return decodeEvidence(row)
    } catch {
      return undefined
    }
  }

  /**
   * Keep a trimmed tool output whole and hand back the session-scoped ref that reads it (AH-D02).
   *
   * It lives in the same content-addressed store as episode evidence, under the same global total
   * and LRU eviction, but it is never cut: an output past `TOOL_TRIM_MAX_STORED_BYTES` is refused, and
   * the ref is only returned once the stored row reads back whole, so a caller that gets a ref may
   * replace the output it came from. The ref is the first 16 hex digits of the content address, and
   * it is linked to one session: another session naming the same ref finds nothing.
   */
  putToolEvidence(
    input: { sessionID: string; tool: string; content: string },
    now = Date.now(),
  ): { ref: string; hash: string; bytes: number } | undefined {
    try {
      const bytes = Buffer.byteLength(input.content, "utf8")
      if (bytes === 0 || bytes > TOOL_TRIM_MAX_STORED_BYTES) return undefined
      const stored = this.storeEvidence({ content: input.content }, input.content.length, now)
      // Read back through the verified path: it confirms the whole text is there under its address
      // and marks it used, so content first stored long ago is not the next thing the LRU evicts.
      const slice = stored ? this.getEvidence(stored.hash, now) : undefined
      if (!slice || slice.content !== input.content) return undefined
      const ref = slice.hash.slice(0, 16)
      this.db
        .query(
          `INSERT INTO tool_evidence (session_id, ref, hash, tool, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT(session_id, ref) DO UPDATE SET hash = excluded.hash, tool = excluded.tool`,
        )
        .run(input.sessionID, ref, slice.hash, input.tool, now)
      return { ref, hash: slice.hash, bytes }
    } catch {
      return undefined
    }
  }

  /**
   * A trimmed tool output by its ref, only for the session that owns it (AH-D02).
   *
   * Read through `getEvidence`, so a row that was evicted or edited by hand reads as `undefined`
   * rather than as text its address does not name, and reading it marks it used for the LRU.
   */
  getToolEvidence(sessionID: string, ref: string, now = Date.now()): { content: string; tool: string } | undefined {
    try {
      const link = this.db
        .query("SELECT hash, tool FROM tool_evidence WHERE session_id = ?1 AND ref = ?2")
        .get(sessionID, ref) as { hash: string; tool: string } | null
      if (!link) return undefined
      const slice = this.getEvidence(link.hash, now)
      return slice ? { content: slice.content, tool: link.tool } : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Replace an episode's evidence associations in one transaction; a recapture converges (FH-006).
   *
   * Two candidates with the same text share an address and collapse into one row on `(episode_id,
   * hash)`, which is intended: the same slice is the same evidence, not two.
   */
  setEpisodeEvidence(episodeID: string, links: EvidenceLink[], now = Date.now()): void {
    try {
      this.db.transaction(() => {
        this.db.query("DELETE FROM episode_evidence WHERE episode_id = ?1").run(episodeID)
        for (const link of links) {
          this.db
            .query(
              `INSERT OR REPLACE INTO episode_evidence (episode_id, hash, position, kind, source, created_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
            )
            .run(episodeID, link.hash, link.position, link.kind, link.source ?? null, now)
        }
      })()
    } catch {
      // Evidence is a record of what happened, never a reason a capture fails.
    }
  }

  /**
   * The slices an episode kept, in the order they were captured (FH-006).
   *
   * Read through `getEvidence`, so a slice that was evicted or edited is skipped rather than
   * returned as something it is not.
   */
  evidenceFor(episode: Pick<SessionEpisode, "id">, now = Date.now()): EvidenceSlice[] {
    try {
      const links = this.db
        .query(
          "SELECT hash, kind, source FROM episode_evidence WHERE episode_id = ?1 ORDER BY position ASC, rowid ASC",
        )
        .all(episode.id) as Array<{ hash: string; kind: string; source: string | null }>
      return links.flatMap((link): EvidenceSlice[] => {
        const slice = this.getEvidence(link.hash, now)
        if (!slice) return []
        const kind = evidenceKind(link.kind)
        return [{ ...slice, ...(kind ? { kind } : {}), ...(link.source ? { source: link.source } : {}) }]
      })
    } catch {
      return []
    }
  }

  /**
   * Forget the least recently used slices until the store is back under its total in UTF-8 bytes
   * (FH-006).
   *
   * The content and the associations go together. Reading a slice moves it up the order, so what
   * goes first is what has not been looked at; the count says how many were dropped.
   */
  evictEvidence(input: { maxBytes?: number } = {}): number {
    try {
      const maxBytes = input.maxBytes ?? EVIDENCE_TOTAL_LIMIT
      const total =
        (this.db.query("SELECT bytes FROM evidence_total WHERE id = 1").get() as { bytes: number } | null)?.bytes ?? 0
      if (total <= maxBytes) return 0
      // Walk the LRU index only as far as the excess reaches; the rest of the store is never read.
      const rows = this.db
        .query(
          `SELECT hash, size FROM evidence
           ORDER BY COALESCE(last_read_at, created_at) ASC, hash ASC`,
        )
        .iterate() as IterableIterator<{ hash: string; size: number }>
      const doomed: string[] = []
      let excess = total - maxBytes
      for (const row of rows) {
        if (excess <= 0) break
        doomed.push(row.hash)
        excess -= row.size
      }
      if (doomed.length === 0) return 0
      return this.db.transaction(() => {
        for (const hash of doomed) {
          this.db.query("DELETE FROM episode_evidence WHERE hash = ?1").run(hash)
          this.db.query("DELETE FROM tool_evidence WHERE hash = ?1").run(hash)
          this.db.query("DELETE FROM evidence WHERE hash = ?1").run(hash)
        }
        return doomed.length
      })()
    } catch {
      return 0
    }
  }

  // ---- the usage ledger (UL-01) ---------------------------------------------------------------

  /** Stores the facts it has not seen, by id, in one transaction; returns how many were new. */
  recordUsage(batch: { events: LedgerEvent[]; tools: ToolEvent[] }) {
    const event = this.db.query(
      `INSERT OR IGNORE INTO usage_event (
        id, kind, session_id, parent_session_id, root_session_id, message_id, turn_id, engine_seq,
        agent, provider_id, model_id, variant,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
        cost_usd, cost_basis, billing, started_at, ended_at, first_token_ms, finish, error_type, retry_attempt,
        directory, engine_project_id,
        run_id, task_id, attempt, routine_id, workflow_name, workflow_hash, purpose, tags_json
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
        ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36)`,
    )
    const tool = this.db.query(
      `INSERT OR IGNORE INTO tool_event (id, session_id, message_id, tool, started_at, ms, error, bytes)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    // Stamped before the write lock is taken: a folder seen for the first time asks git.
    const events = batch.events.map((entry) => this.stamped(entry))
    return this.db.transaction(() => ({
      events: events.filter(
        (entry) =>
          event.run(
            entry.id,
            entry.kind,
            entry.sessionID,
            entry.parentSessionID ?? null,
            entry.rootSessionID ?? null,
            entry.messageID ?? null,
            entry.turnID ?? null,
            entry.engineSeq ?? null,
            entry.agent ?? null,
            entry.providerID ?? null,
            entry.modelID ?? null,
            entry.variant ?? null,
            entry.tokens.input,
            entry.tokens.output,
            entry.tokens.reasoning,
            entry.tokens.cacheRead,
            entry.tokens.cacheWrite,
            entry.costUSD ?? null,
            entry.costBasis,
            entry.billing,
            entry.startedAt ?? null,
            entry.endedAt ?? null,
            entry.firstTokenMs ?? null,
            entry.finish ?? null,
            entry.errorType ?? null,
            entry.retryAttempt ?? null,
            entry.directory ?? null,
            entry.engineProjectID ?? null,
            entry.runID ?? null,
            entry.taskID ?? null,
            entry.attempt ?? null,
            entry.routineID ?? null,
            entry.workflowName ?? null,
            entry.workflowHash ?? null,
            entry.purpose ?? null,
            entry.tags ? JSON.stringify(entry.tags) : null,
          ).changes > 0,
      ).length,
      tools: batch.tools.filter(
        (entry) =>
          tool.run(
            entry.id,
            entry.sessionID,
            entry.messageID ?? null,
            entry.tool,
            entry.startedAt ?? null,
            entry.ms,
            entry.error ? 1 : 0,
            entry.bytes,
          ).changes > 0,
      ).length,
    }))()
  }

  // ---- attribution (UL-04) ----------------------------------------------------------------------

  /**
   * Say who a session works for. The server's word (a run's task, a closing note, a commit message)
   * replaces what was learnt from the engine; what the engine says only fills a session nobody
   * stamped. Given a run, the rest — attempt, routine, workflow, folder — is read from the run.
   *
   * Rows the ledger already holds for the session and for its subagents are stamped too, column by
   * column and only where empty: a fact that arrived before its attribution is not left orphaned,
   * and nothing already stamped is changed. The facts themselves never are.
   */
  attributeSession(sessionID: string, attribution: SessionAttribution, source: "server" | "engine" = "server") {
    // The row alone, not `getRun`: attribution needs no verdict, and migration 7 attributes sessions
    // before migration 9 has added the columns a run's verdict is derived from.
    const row = attribution.runID
      ? (this.db.query("SELECT * FROM runs WHERE id = ?1").get(attribution.runID) as RunRow | null)
      : null
    const run = row ? decodeRun(row) : undefined
    const task = attribution.taskID ? this.getTask(attribution.taskID) : undefined
    const directory = attribution.directory ?? run?.directory
    const values = [
      sessionID,
      attribution.parentSessionID ?? null,
      source,
      attribution.runID ?? null,
      attribution.taskID ?? null,
      attribution.attempt ?? task?.attempt ?? null,
      attribution.routineID ?? (run?.source.type === "routine" ? run.source.routineID : null),
      attribution.workflowName ?? run?.workflow?.name ?? null,
      attribution.workflowHash ?? run?.workflow?.hash ?? null,
      attribution.purpose ?? null,
      directory ? repositoryRoot(directory) : null,
      Date.now(),
    ]
    this.db.transaction(() => {
      this.db
        .query(
          `INSERT INTO session_attribution (
            session_id, parent_session_id, source, run_id, task_id, attempt, routine_id, workflow_name,
            workflow_hash, purpose, directory, created_at
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
          ON CONFLICT(session_id) DO ${
            source === "server"
              ? `UPDATE SET parent_session_id = COALESCE(excluded.parent_session_id, parent_session_id),
                  source = excluded.source, run_id = excluded.run_id, task_id = excluded.task_id,
                  attempt = excluded.attempt, routine_id = excluded.routine_id,
                  workflow_name = excluded.workflow_name, workflow_hash = excluded.workflow_hash,
                  purpose = excluded.purpose, directory = COALESCE(excluded.directory, directory)`
              : "NOTHING"
          }`,
        )
        .run(...values)
      this.stampStored(sessionID)
    })()
  }

  knowsSession(sessionID: string) {
    return this.db.query("SELECT 1 FROM session_attribution WHERE session_id = ?1").get(sessionID) !== null
  }

  /** When attribution started: the time the migration that added it ran on this database. */
  attributionSince() {
    this.since ??= (this.db.query("SELECT applied_at FROM schema_version WHERE version = 7").get() as { applied_at: number })
      .applied_at
    return this.since
  }

  /**
   * Who a session works for, its own row first and then its ancestors', field by field: a subagent
   * of a run's task is that run's, and a closing note keeps its own purpose though it shares a run.
   */
  sessionAttribution(sessionID: string): SessionAttribution | undefined {
    const chain = this.db
      .query(
        `WITH RECURSIVE chain(session_id, depth) AS (
           SELECT ?1, 0
           UNION ALL
           SELECT a.parent_session_id, chain.depth + 1 FROM session_attribution a
             JOIN chain ON a.session_id = chain.session_id
             WHERE a.parent_session_id IS NOT NULL AND chain.depth < 32
         )
         SELECT a.* FROM chain JOIN session_attribution a ON a.session_id = chain.session_id ORDER BY chain.depth`,
      )
      .all(sessionID) as AttributionRow[]
    if (chain.length === 0) return undefined
    const first = <K extends keyof AttributionRow>(key: K) => chain.find((row) => row[key] !== null)?.[key] ?? undefined
    const merged = {
      parentSessionID: chain[0]!.parent_session_id ?? undefined,
      runID: first("run_id"),
      taskID: first("task_id"),
      attempt: first("attempt"),
      routineID: first("routine_id"),
      workflowName: first("workflow_name"),
      workflowHash: first("workflow_hash"),
      purpose: first("purpose"),
      directory: first("directory"),
    }
    const known = Object.fromEntries(Object.entries(merged).filter((entry) => entry[1] !== undefined))
    // A session the engine no longer knew is recorded so it is not asked about again, but says nothing.
    return Object.keys(known).length > 0 ? (known as SessionAttribution) : undefined
  }

  /**
   * A fact with the attribution of its session, or of the parent the event names when the session
   * is not known yet. What the caller set itself wins; a title or a compaction keeps its own purpose.
   */
  private stamped(entry: LedgerEvent): LedgerEvent {
    const known =
      this.sessionAttribution(entry.sessionID) ??
      (entry.parentSessionID ? this.sessionAttribution(entry.parentSessionID) : undefined)
    const inherited = {
      runID: known?.runID,
      taskID: known?.taskID,
      attempt: known?.attempt,
      routineID: known?.routineID,
      workflowName: known?.workflowName,
      workflowHash: known?.workflowHash,
    }
    const purpose = entry.purpose ?? KIND_PURPOSE[entry.kind] ?? known?.purpose
    const directory = known?.directory ?? (entry.directory ? repositoryRoot(entry.directory) : undefined)
    return {
      ...(Object.fromEntries(Object.entries(inherited).filter((field) => field[1] !== undefined)) as SessionAttribution),
      ...entry,
      ...(purpose ? { purpose } : {}),
      ...(directory ? { directory } : {}),
    }
  }

  /** Stamp the stored rows of a session and of every session under it, where they are still empty. */
  private stampStored(sessionID: string) {
    const sessions = this.db
      .query(
        `WITH RECURSIVE tree(session_id, depth) AS (
           SELECT ?1, 0
           UNION
           SELECT a.session_id, tree.depth + 1 FROM session_attribution a
             JOIN tree ON a.parent_session_id = tree.session_id WHERE tree.depth < 32
           UNION
           SELECT e.session_id, tree.depth + 1 FROM usage_event e
             JOIN tree ON e.parent_session_id = tree.session_id WHERE tree.depth < 32
         )
         SELECT DISTINCT e.session_id AS sessionID, e.parent_session_id AS parentSessionID FROM usage_event e
           JOIN tree ON e.session_id = tree.session_id`,
      )
      .all(sessionID) as Array<{ sessionID: string; parentSessionID: string | null }>
    const update = this.db.query(
      `UPDATE usage_event SET
         run_id = COALESCE(run_id, ?3), task_id = COALESCE(task_id, ?4), attempt = COALESCE(attempt, ?5),
         routine_id = COALESCE(routine_id, ?6), workflow_name = COALESCE(workflow_name, ?7),
         workflow_hash = COALESCE(workflow_hash, ?8), purpose = COALESCE(purpose, ?9),
         directory = COALESCE(?10, directory)
       WHERE session_id = ?1 AND parent_session_id IS ?2`,
    )
    for (const session of sessions) {
      const known =
        this.sessionAttribution(session.sessionID) ??
        (session.parentSessionID ? this.sessionAttribution(session.parentSessionID) : undefined)
      if (!known) continue
      update.run(
        session.sessionID,
        session.parentSessionID,
        known.runID ?? null,
        known.taskID ?? null,
        known.attempt ?? null,
        known.routineID ?? null,
        known.workflowName ?? null,
        known.workflowHash ?? null,
        known.purpose ?? null,
        known.directory ?? null,
      )
    }
  }

  /** The engine's `time.updated` of a session when the reconciler last read it (UL-03). */
  usageReconciled(sessionID: string) {
    const row = this.db.query("SELECT engine_updated FROM usage_reconciled WHERE session_id = ?1").get(sessionID) as
      | { engine_updated: number }
      | null
    return row?.engine_updated
  }

  markUsageReconciled(sessionID: string, engineUpdated: number, now = Date.now()) {
    this.db
      .query(
        `INSERT INTO usage_reconciled (session_id, engine_updated, reconciled_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(session_id) DO UPDATE SET engine_updated = excluded.engine_updated, reconciled_at = excluded.reconciled_at`,
      )
      .run(sessionID, engineUpdated, now)
  }

  // ---- browser policy (BU-01) -------------------------------------------------------------------

  listBrowserGrants(): BrowserGrant[] {
    const rows = this.db.query("SELECT * FROM browser_grants ORDER BY created_at, rowid").all() as BrowserGrantRow[]
    return rows.map((row) => ({
      id: row.id,
      origin: row.origin,
      tier: row.tier as BrowserTier,
      scope: row.scope === "session" ? "session" : "always",
      ...(row.session_id ? { sessionID: row.session_id } : {}),
      createdAt: row.created_at,
    }))
  }

  /** A grant, or the one already standing for the same origin, tier, scope and session. */
  addBrowserGrant(input: Omit<BrowserGrant, "id" | "createdAt">, now = Date.now()): BrowserGrant {
    const existing = this.listBrowserGrants().find(
      (grant) =>
        grant.origin === input.origin &&
        grant.tier === input.tier &&
        grant.scope === input.scope &&
        grant.sessionID === input.sessionID,
    )
    if (existing) return existing
    const grant: BrowserGrant = { id: crypto.randomUUID(), ...input, createdAt: now }
    this.db
      .query("INSERT INTO browser_grants (id, origin, tier, scope, session_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
      .run(grant.id, grant.origin, grant.tier, grant.scope, grant.sessionID ?? null, now)
    return grant
  }

  removeBrowserGrant(id: string) {
    return this.db.query("DELETE FROM browser_grants WHERE id = ?1").run(id).changes > 0
  }

  /** One audit line, kept in `browser_audit` and appended to the event log for its run. */
  recordBrowserAudit(input: Omit<BrowserAuditEntry, "id" | "at">, now = Date.now()): BrowserAuditEntry {
    const entry: BrowserAuditEntry = { id: crypto.randomUUID(), at: now, ...input }
    this.db
      .query(
        `INSERT INTO browser_audit (id, at, kind, origin, tier, decision, scope, outcome, reason, action, session_id, run_id, task_id, artifact_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .run(
        entry.id,
        now,
        entry.kind,
        entry.origin,
        entry.tier,
        entry.decision ?? null,
        entry.scope ?? null,
        entry.outcome ?? null,
        entry.reason ?? null,
        entry.action ?? null,
        entry.sessionID ?? null,
        entry.runID ?? null,
        entry.taskID ?? null,
        entry.artifactID ?? null,
      )
    this.append({ type: "browser.audit", entry }, now)
    return entry
  }

  /** The newest audit lines first, for a run, a session, or all of them. */
  listBrowserAudit(filter: { runID?: string; sessionID?: string; limit?: number } = {}): BrowserAuditEntry[] {
    const rows = this.db
      .query(
        `SELECT * FROM browser_audit
          WHERE (?1 IS NULL OR run_id = ?1) AND (?2 IS NULL OR session_id = ?2)
          ORDER BY at DESC, rowid DESC LIMIT ?3`,
      )
      .all(filter.runID ?? null, filter.sessionID ?? null, filter.limit ?? 100) as BrowserAuditRow[]
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      kind: row.kind as BrowserAuditEntry["kind"],
      origin: row.origin,
      tier: row.tier as BrowserTier,
      ...(row.decision ? { decision: row.decision as NonNullable<BrowserAuditEntry["decision"]> } : {}),
      ...(row.scope ? { scope: row.scope as NonNullable<BrowserAuditEntry["scope"]> } : {}),
      ...(row.outcome ? { outcome: row.outcome as NonNullable<BrowserAuditEntry["outcome"]> } : {}),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.action ? { action: row.action } : {}),
      ...(row.session_id ? { sessionID: row.session_id } : {}),
      ...(row.run_id ? { runID: row.run_id } : {}),
      ...(row.task_id ? { taskID: row.task_id } : {}),
      ...(row.artifact_id ? { artifactID: row.artifact_id } : {}),
    }))
  }

  /** A session's billable facts, in the order they were stored. */
  usageEvents(sessionID: string): LedgerEvent[] {
    const rows = this.db.query("SELECT * FROM usage_event WHERE session_id = ?1 ORDER BY rowid").all(sessionID) as UsageEventRow[]
    return rows.map(ledgerEventFromRow)
  }

  // ---- the usage summary (UL-05) ----------------------------------------------------------------

  /**
   * The ledger added up per value of a dimension (none for the plain total), per cost basis and
   * billing, and per whether the row carries a price. The folding into groups and money lines is
   * `summariseUsage`'s; this only filters and sums, so the arithmetic is tested without a database.
   *
   * `from` and `to` bound when a fact happened (`[from, to)`, its end, or its start without one);
   * `directory` is a repository root, as rows store it.
   */
  usageTotals(
    input: {
      groupBy?: UsageDimension
      tag?: string
      from?: number
      to?: number
      directory?: string
      runID?: string
      sessionIDs?: string[]
    } = {},
  ): UsageTotalRow[] {
    const values: Array<string | number> = []
    const bind = (value: string | number) => {
      values.push(value)
      return `?${values.length}`
    }
    const at = "COALESCE(ended_at, started_at)"
    const where = [
      ...(input.from !== undefined ? [`${at} >= ${bind(input.from)}`] : []),
      ...(input.to !== undefined ? [`${at} < ${bind(input.to)}`] : []),
      ...(input.directory !== undefined ? [`directory = ${bind(input.directory)}`] : []),
      ...(input.runID !== undefined ? [`run_id = ${bind(input.runID)}`] : []),
      ...(input.sessionIDs !== undefined ? [`session_id IN (${input.sessionIDs.map(bind).join(", ") || "NULL"})`] : []),
    ]
    const columns: Record<string, string> = !input.groupBy
      ? {}
      : input.groupBy === "tag"
        ? { tag: `json_extract(tags_json, ${bind(`$."${(input.tag ?? "").replaceAll('"', '""')}"`)})` }
        : USAGE_COLUMNS[input.groupBy]
    const keys = Object.entries(columns).map(([name, expression]) => `${expression} AS "${name}"`)
    // A row is priced when it has a basis other than unpriced and a cost; anything else is unpriced
    // whatever its basis says, so a missing cost is never added up as $0.
    const priced = "(cost_basis != 'unpriced' AND cost_usd IS NOT NULL)"
    const rows = this.db
      .query(
        `SELECT ${[...keys, ""].join(", ")}
           cost_basis AS basis, billing, ${priced} AS priced, COUNT(*) AS events,
           SUM(tokens_input) AS input, SUM(tokens_output) AS output, SUM(tokens_reasoning) AS reasoning,
           SUM(tokens_cache_read) AS cacheRead, SUM(tokens_cache_write) AS cacheWrite,
           COALESCE(SUM(CASE WHEN ${priced} THEN cost_usd END), 0) AS usd
         FROM usage_event
         ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
         GROUP BY ${[...Object.keys(columns).map((name) => `"${name}"`), "basis", "billing", "priced"].join(", ")}`,
      )
      .all(...values) as Array<Record<string, string | number | null>>
    return rows.map((row) => ({
      fields: Object.fromEntries(Object.keys(columns).map((name) => [name, row[name] ?? null])),
      basis: row.basis as CostBasis,
      billing: row.billing as Billing,
      priced: row.priced === 1,
      events: Number(row.events),
      tokens: {
        input: Number(row.input),
        output: Number(row.output),
        reasoning: Number(row.reasoning),
        cacheRead: Number(row.cacheRead),
        cacheWrite: Number(row.cacheWrite),
      },
      usd: Number(row.usd),
    }))
  }

  /**
   * Which session each subagent belongs to, as the ledger and the attribution table know it: the
   * engine's own `parentID` on a row first, then what the server learnt or stamped.
   */
  usageSessionParents() {
    const rows = this.db
      .query(
        `SELECT session_id AS sessionID, parent_session_id AS parentSessionID FROM usage_event WHERE parent_session_id IS NOT NULL
         UNION ALL
         SELECT session_id, parent_session_id FROM session_attribution WHERE parent_session_id IS NOT NULL`,
      )
      .all() as Array<{ sessionID: string; parentSessionID: string }>
    const parents = new Map<string, string>()
    for (const row of rows) if (!parents.has(row.sessionID)) parents.set(row.sessionID, row.parentSessionID)
    return parents
  }

  /** A session and every session under it, by the same links as `usageSessionParents`, nearest first. */
  usageSessionTree(sessionID: string) {
    return this.db
      .query(
        `WITH RECURSIVE links(session_id, parent_session_id) AS (
           SELECT DISTINCT session_id, parent_session_id FROM usage_event WHERE parent_session_id IS NOT NULL
           UNION
           SELECT session_id, parent_session_id FROM session_attribution WHERE parent_session_id IS NOT NULL
         ),
         tree(session_id, parent_session_id, depth) AS (
           SELECT ?1, NULL, 0
           UNION
           SELECT links.session_id, links.parent_session_id, tree.depth + 1 FROM links
             JOIN tree ON links.parent_session_id = tree.session_id WHERE tree.depth < 32
         )
         SELECT session_id AS sessionID, parent_session_id AS parentSessionID, MIN(depth) AS depth FROM tree
           GROUP BY session_id ORDER BY depth, session_id`,
      )
      .all(sessionID) as Array<{ sessionID: string; parentSessionID: string | null; depth: number }>
  }

  /**
   * Re-label as unpriced the rows of models the engine has no price for (UL-05). Such a model can
   * only ever have been reported at $0, so only $0 rows are touched: a row with a cost had a price
   * when it happened. The cost is dropped with it, since that $0 was never a price. Returns how many
   * rows changed.
   */
  markUnpriced(models: Array<{ providerID: string; modelID: string }>) {
    if (models.length === 0) return 0
    const update = this.db.query(
      `UPDATE usage_event SET cost_basis = 'unpriced', cost_usd = NULL
       WHERE provider_id = ?1 AND model_id = ?2 AND cost_basis = 'engine-list-price' AND COALESCE(cost_usd, 0) = 0`,
    )
    return this.db.transaction(() =>
      models.reduce((changed, model) => changed + update.run(model.providerID, model.modelID).changes, 0),
    )()
  }

  /** Whether the run exists or the ledger holds rows for it. */
  knowsRunUsage(runID: string) {
    return (
      this.getRun(runID) !== undefined ||
      this.db.query("SELECT 1 FROM usage_event WHERE run_id = ?1 LIMIT 1").get(runID) !== null
    )
  }

  /** A session's finished tools, in the order they were stored. */
  toolEvents(sessionID: string): ToolEvent[] {
    const rows = this.db.query("SELECT * FROM tool_event WHERE session_id = ?1 ORDER BY rowid").all(sessionID) as ToolEventRow[]
    return rows.map((row) => ({
      id: row.id,
      sessionID: row.session_id,
      ...(row.message_id === null ? {} : { messageID: row.message_id }),
      tool: row.tool,
      ...(row.started_at === null ? {} : { startedAt: row.started_at }),
      ms: row.ms,
      error: row.error === 1,
      bytes: row.bytes,
    }))
  }

  // ---- adaptive usage (FH-013) -----------------------------------------------------------------

  /**
   * What the Jev budget spent in a UTC month, or zero when the month has no row yet.
   *
   * A missing month is not an error: the ledger starts empty, and the governor treats zero as
   * "nothing spent", which is exactly right the first time.
   */
  adaptiveUsage(month: string): AdaptiveUsage {
    try {
      const row = this.db.query("SELECT tokens, calls FROM adaptive_usage WHERE month = ?1").get(month) as
        | { tokens: number; calls: number }
        | null
      return row ?? { tokens: 0, calls: 0 }
    } catch {
      return { tokens: 0, calls: 0 }
    }
  }

  /** Adds to the month's spend; a call that never reached Jev is not written at all. */
  addAdaptiveUsage(month: string, tokens: number, calls: number, now: number): void {
    try {
      this.db
        .query(
          `INSERT INTO adaptive_usage (month, tokens, calls, updated_at)
           VALUES (?1, ?2, ?3, ?4)
           ON CONFLICT(month) DO UPDATE SET tokens = tokens + ?2, calls = calls + ?3, updated_at = ?4`,
        )
        .run(month, tokens, calls, now)
    } catch {
      // A budget write that fails must not fail the decision it belonged to.
    }
  }

  // ---- adaptive decisions (FH-015) -------------------------------------------------------------

  /**
   * Writes the decision, or replaces the one already under this id.
   *
   * The id is deterministic, so a re-capture converges: the row keeps its `created_at` and only
   * moves `updated_at`. A failure to write is swallowed, because an audit row must never fail the
   * decision it belongs to.
   */
  createDecision(input: StoredDecisionInput, now = Date.now()): StoredDecision {
    const row = decisionRowFrom(input, now)
    try {
      this.db
        .query(
          `INSERT INTO adaptive_decision (
             id, session_id, episode_id, project_id, kind, inputs_hash, state_summary_json, answer_json,
             baseline_answer_json, baseline_rule, confidence, probabilities_json, provider, attempted_provider,
             model_version, source, degraded, degraded_reason, latency_ms, policy_json, shadow, created_at, updated_at,
             arm, provider_id, provider_version, cost_usd, input_tokens
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
             ?24, ?25, ?26, ?27, ?28)
           ON CONFLICT(id) DO UPDATE SET
             session_id = excluded.session_id,
             episode_id = excluded.episode_id,
             project_id = excluded.project_id,
             kind = excluded.kind,
             inputs_hash = excluded.inputs_hash,
             state_summary_json = excluded.state_summary_json,
             answer_json = excluded.answer_json,
             baseline_answer_json = excluded.baseline_answer_json,
             baseline_rule = excluded.baseline_rule,
             confidence = excluded.confidence,
             probabilities_json = excluded.probabilities_json,
             provider = excluded.provider,
             attempted_provider = excluded.attempted_provider,
             model_version = excluded.model_version,
             source = excluded.source,
             degraded = excluded.degraded,
             degraded_reason = excluded.degraded_reason,
             latency_ms = excluded.latency_ms,
             policy_json = excluded.policy_json,
             shadow = excluded.shadow,
             arm = excluded.arm,
             provider_id = excluded.provider_id,
             provider_version = excluded.provider_version,
             cost_usd = excluded.cost_usd,
             input_tokens = excluded.input_tokens,
             updated_at = excluded.updated_at`,
        )
        .run(
          row.id,
          row.session_id,
          row.episode_id,
          row.project_id,
          row.kind,
          row.inputs_hash,
          row.state_summary_json,
          row.answer_json,
          row.baseline_answer_json,
          row.baseline_rule,
          row.confidence,
          row.probabilities_json,
          row.provider,
          row.attempted_provider,
          row.model_version,
          row.source,
          row.degraded,
          row.degraded_reason,
          row.latency_ms,
          row.policy_json,
          row.shadow,
          row.created_at,
          row.updated_at,
          row.arm,
          row.provider_id,
          row.provider_version,
          row.cost_usd,
          row.input_tokens,
        )
    } catch {
      // An audit that cannot be written is dropped, never raised into the decision.
    }
    return this.getDecision(row.id) ?? { ...input, createdAt: now, updatedAt: now }
  }

  getDecision(id: string): StoredDecision | undefined {
    try {
      const row = this.db.query("SELECT * FROM adaptive_decision WHERE id = ?1").get(id) as DecisionRow | null
      return row ? decisionFromRow(row) : undefined
    } catch {
      return undefined
    }
  }

  /** Newest first, filtered by whichever of session, episode or kind is given. */
  listDecisions(filter: DecisionFilter = {}): StoredDecision[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (filter.sessionID) {
      clauses.push(`session_id = ?${values.length + 1}`)
      values.push(filter.sessionID)
    }
    if (filter.episodeID) {
      clauses.push(`episode_id = ?${values.length + 1}`)
      values.push(filter.episodeID)
    }
    if (filter.kind) {
      clauses.push(`kind = ?${values.length + 1}`)
      values.push(filter.kind)
    }
    if (filter.id) {
      clauses.push(`id = ?${values.length + 1}`)
      values.push(filter.id)
    }
    if (filter.acted !== undefined) {
      const acted = "shadow = 0 AND (arm IS NULL OR arm <> 'control')"
      clauses.push(filter.acted ? `(${acted})` : `NOT (${acted})`)
    }
    if (filter.before) {
      // Keyset pagination in the same order as the listing, so a page never repeats or skips a row
      // written while the reader was paging, and no OFFSET scan grows with the page number.
      const at = values.length + 1
      clauses.push(`(created_at < ?${at} OR (created_at = ?${at} AND id < ?${at + 1}))`)
      values.push(filter.before.createdAt, filter.before.id)
    }
    const limit = normalizeEpisodeLimit(filter.limit)
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const tail = limit !== undefined ? ` LIMIT ?${values.length + 1}` : ""
    if (limit !== undefined) values.push(limit)
    try {
      const rows = this.db
        .query(`SELECT * FROM adaptive_decision${where} ORDER BY created_at DESC, id DESC${tail}`)
        .all(...values) as DecisionRow[]
      // A row whose JSON is corrupt, or whose kind or source this build does not know, is decoded
      // defensively by `decisionFromRow` and kept, never thrown or dropped (AH-C02).
      return rows.map(decisionFromRow)
    } catch {
      // An unreadable audit page answers empty rather than taking the endpoint down.
      return []
    }
  }

  /** How many decisions of a kind this episode already has; the shadow uses it to skip a re-close. */
  countDecisionsForEpisode(episodeID: string, kind: DecisionKind): number {
    try {
      const row = this.db
        .query("SELECT COUNT(*) AS count FROM adaptive_decision WHERE episode_id = ?1 AND kind = ?2")
        .get(episodeID, kind) as { count: number } | null
      return row?.count ?? 0
    } catch {
      return 0
    }
  }

  // ---- outcome labels (AH-C06) ------------------------------------------------------------------

  /**
   * Unlabelled decisions of the given kinds created no later than `settledBefore`, oldest first and
   * strictly after the `(createdAt, id)` cursor, so a sweep can walk the backlog page by page and a
   * page of still-unknowable rows never starves the ones behind it.
   */
  listUnlabeledDecisions(input: {
    kinds: readonly DecisionKind[]
    settledBefore: number
    after?: { createdAt: number; id: string }
    limit: number
  }): StoredDecision[] {
    if (input.kinds.length === 0) return []
    const kinds = input.kinds.map((_, index) => `?${index + 5}`).join(", ")
    const rows = this.db
      .query(
        `SELECT * FROM adaptive_decision
         WHERE label IS NULL AND created_at <= ?1 AND kind IN (${kinds})
           AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
         ORDER BY created_at, id LIMIT ?4`,
      )
      .all(
        input.settledBefore,
        input.after?.createdAt ?? -1,
        input.after?.id ?? "",
        input.limit,
        ...input.kinds,
      ) as DecisionRow[]
    return rows.map(decisionFromRow)
  }

  /**
   * Writes a decision's outcome label once. A row that already carries one is left alone, so a
   * second sweep, or two racing ones, cannot relabel it; `updated_at` is not moved, because a label
   * is not a new capture and must not extend the row's retention.
   */
  labelDecision(id: string, label: DecisionLabelInput, at = Date.now()): boolean {
    return (
      this.db
        .query("UPDATE adaptive_decision SET label = ?2, labeled_at = ?3 WHERE id = ?1 AND label IS NULL")
        .run(id, JSON.stringify(label), at).changes > 0
    )
  }

  /** How many decisions of a kind were created in a window, and how their labels read. */
  countDecisionLabels(input: { kind: DecisionKind; since: number; until: number }): DecisionLabelCounts {
    // A label edited by hand into something that is not JSON counts as labelled, never as a throw.
    return this.db
      .query(
        `SELECT COUNT(*) AS eligible,
                COALESCE(SUM(CASE WHEN label IS NOT NULL THEN 1 ELSE 0 END), 0) AS labeled,
                COALESCE(SUM(CASE WHEN json_extract(CASE WHEN json_valid(label) THEN label END, '$.outcome') = 'correct' THEN 1 ELSE 0 END), 0) AS correct,
                COALESCE(SUM(CASE WHEN json_extract(CASE WHEN json_valid(label) THEN label END, '$.outcome') = 'incorrect' THEN 1 ELSE 0 END), 0) AS incorrect,
                COALESCE(SUM(CASE WHEN json_extract(CASE WHEN json_valid(label) THEN label END, '$.outcome') = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown
         FROM adaptive_decision
         WHERE kind = ?1 AND created_at >= ?2 AND created_at <= ?3`,
      )
      .get(input.kind, input.since, input.until) as DecisionLabelCounts
  }

  /**
   * What the value-of-information gate reads for one kind and model (AH-C05), newest first.
   *
   * The model's current version is the newest one it reported for the kind; the samples are that
   * version's own, so a version change starts the stats from zero. `labeled` are the decisions the
   * model answered whose label judged both the answer and the baseline answer; `calls` are the calls
   * that measured a cost, plus the timeouts (which carry no version but are latency the model took).
   * Each list is bounded by `limit`, so a refresh never scans more than the window.
   */
  listValueSamples(input: { kind: DecisionKind; providerID: string; limit: number }): ValueSamples {
    const newest = this.db
      .query(
        `SELECT provider_version FROM adaptive_decision
         WHERE kind = ?1 AND provider_id = ?2 AND provider_version IS NOT NULL
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(input.kind, input.providerID) as { provider_version: string } | null
    const version = newest?.provider_version ?? null
    // A label edited by hand into something that is not JSON is skipped, never a throw.
    const judged = `json_extract(CASE WHEN json_valid(label) THEN label END, '$.outcome') IN ('correct', 'incorrect')
      AND json_extract(CASE WHEN json_valid(label) THEN label END, '$.baselineOutcome') IN ('correct', 'incorrect')`
    const labeled = this.db
      .query(
        `SELECT * FROM adaptive_decision
         WHERE kind = ?1 AND provider_id = ?2 AND source = 'model' AND provider_version IS ?3 AND ${judged}
         ORDER BY created_at DESC, id DESC LIMIT ?4`,
      )
      .all(input.kind, input.providerID, version, input.limit) as DecisionRow[]
    const calls = this.db
      .query(
        `SELECT latency_ms, cost_usd FROM adaptive_decision
         WHERE kind = ?1 AND provider_id = ?2 AND source IN ('model', 'fallback')
           AND ((provider_version IS ?3 AND cost_usd IS NOT NULL) OR degraded_reason = 'timeout')
         ORDER BY created_at DESC, id DESC LIMIT ?4`,
      )
      .all(input.kind, input.providerID, version, input.limit) as Array<{ latency_ms: number; cost_usd: number | null }>
    return {
      ...(version !== null ? { version } : {}),
      labeled: labeled.map(decisionFromRow),
      calls: calls.map((call) => ({
        latencyMs: call.latency_ms,
        ...(call.cost_usd !== null ? { costUsd: call.cost_usd } : {}),
      })),
    }
  }

  // ---- context plans (FH-022) -----------------------------------------------------------------

  /**
   * Writes the plan, or replaces the one already under this id.
   *
   * The id is deterministic (`plan:<runID:taskID>` or `plan:<episodeID>`), so a re-plan converges:
   * the row keeps its `created_at` and only moves `updated_at`. A failure to write is swallowed,
   * because an audit row must never fail the planning it belongs to.
   */
  createPlan(input: StoredPlanInput, now = Date.now()): StoredPlan {
    const row = planRowFrom(input, now)
    try {
      this.db
        .query(
          `INSERT INTO adaptive_plan (
             id, run_id, task_id, episode_id, session_id, project_id, objective_hash, items_json,
             item_count, keep_count, archive_count, drop_count, score_source, degraded, degraded_reason,
             applied, tokens_before, tokens_after, decision_id, truncated, created_at, updated_at, score_provider
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
           ON CONFLICT(id) DO UPDATE SET
             run_id = excluded.run_id,
             task_id = excluded.task_id,
             episode_id = excluded.episode_id,
             session_id = excluded.session_id,
             project_id = excluded.project_id,
             objective_hash = excluded.objective_hash,
             items_json = excluded.items_json,
             item_count = excluded.item_count,
             keep_count = excluded.keep_count,
             archive_count = excluded.archive_count,
             drop_count = excluded.drop_count,
             score_source = excluded.score_source,
             score_provider = excluded.score_provider,
             degraded = excluded.degraded,
             degraded_reason = excluded.degraded_reason,
             applied = excluded.applied,
             tokens_before = excluded.tokens_before,
             tokens_after = excluded.tokens_after,
             decision_id = excluded.decision_id,
             truncated = excluded.truncated,
             updated_at = excluded.updated_at`,
        )
        .run(
          row.id,
          row.run_id,
          row.task_id,
          row.episode_id,
          row.session_id,
          row.project_id,
          row.objective_hash,
          row.items_json,
          row.item_count,
          row.keep_count,
          row.archive_count,
          row.drop_count,
          row.score_source,
          row.degraded,
          row.degraded_reason,
          row.applied,
          row.tokens_before,
          row.tokens_after,
          row.decision_id,
          row.truncated,
          row.created_at,
          row.updated_at,
          row.score_provider,
        )
    } catch {
      // An audit that cannot be written is dropped, never raised into the plan.
    }
    return this.getPlan(row.id) ?? { ...input, truncated: false, createdAt: now, updatedAt: now }
  }

  getPlan(id: string): StoredPlan | undefined {
    try {
      const row = this.db.query("SELECT * FROM adaptive_plan WHERE id = ?1").get(id) as PlanRow | null
      return row ? planFromRow(row) : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Marks a plan applied after it filtered the prompt. Best-effort like `createPlan`: a plan that
   * cannot be written must never fail the run that produced it.
   */
  markApplied(id: string, now = Date.now()): StoredPlan | undefined {
    try {
      this.db.query("UPDATE adaptive_plan SET applied = 1, updated_at = ?2 WHERE id = ?1").run(id, now)
    } catch {
      return undefined
    }
    return this.getPlan(id)
  }

  /** Newest first, filtered by whichever of run, task, episode, session or project is given. */
  listPlans(filter: PlanFilter = {}): StoredPlan[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    const add = (column: string, value: string | undefined) => {
      if (!value) return
      clauses.push(`${column} = ?${values.length + 1}`)
      values.push(value)
    }
    add("run_id", filter.runID)
    add("task_id", filter.taskID)
    add("episode_id", filter.episodeID)
    add("session_id", filter.sessionID)
    add("project_id", filter.projectID)
    const limit = normalizeEpisodeLimit(filter.limit)
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const tail = limit !== undefined ? ` LIMIT ?${values.length + 1}` : ""
    if (limit !== undefined) values.push(limit)
    try {
      const rows = this.db
        .query(`SELECT * FROM adaptive_plan${where} ORDER BY created_at DESC, id DESC${tail}`)
        .all(...values) as PlanRow[]
      // A row whose JSON is corrupt, or whose score source this build does not know, is decoded
      // defensively by `planFromRow` and kept, never thrown or dropped (AH-C02).
      return rows.map(planFromRow)
    } catch {
      // An unreadable plan page answers empty rather than taking the endpoint down.
      return []
    }
  }

  // ---- reflection jobs (FH-030) ----------------------------------------------------------------

  /**
   * Writes the job, or replaces the one already under this episode.
   *
   * The episode id is the primary key, so a second close or a sweep converges: the row keeps its
   * `created_at` and only moves `updated_at`. A failure to write is swallowed, because the audit of
   * an episode must never fail the episode's close.
   */
  createReflectionJob(input: StoredReflectionJobInput, now = Date.now()): StoredReflectionJob {
    const row = reflectionJobRowFrom(input, now)
    try {
      this.db
        .query(
          `INSERT INTO reflection_job (
             episode_id, session_id, project_id, status, reason, decision_id, proposal_id,
             attempts, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
           ON CONFLICT(episode_id) DO UPDATE SET
             session_id = excluded.session_id,
             project_id = excluded.project_id,
             status = excluded.status,
             reason = excluded.reason,
             decision_id = excluded.decision_id,
             proposal_id = excluded.proposal_id,
             attempts = MAX(reflection_job.attempts, excluded.attempts),
             updated_at = excluded.updated_at`,
        )
        .run(
          row.episode_id,
          row.session_id,
          row.project_id,
          row.status,
          row.reason,
          row.decision_id,
          row.proposal_id,
          row.attempts,
          row.created_at,
          row.updated_at,
        )
    } catch {
      // An audit that cannot be written is dropped, never raised into the episode.
    }
    return this.getReflectionJob(row.episode_id) ?? { ...input, createdAt: now, updatedAt: now }
  }

  /**
   * Claims the episode's reflection for this process, before any model call: `true` only when this
   * call inserted the `pending` row or took over a `pending` one whose claim is older than `leaseMs`
   * (a process that died mid-draft). A terminal job or a live claim answers `false`, so a restart or
   * a second harness process on the same database never reflects the same episode twice. The insert
   * and the takeover are one statement, which SQLite serialises across connections.
   */
  claimReflectionJob(
    input: { episodeID: string; sessionID?: string; projectID?: string },
    now: number,
    leaseMs: number,
  ): boolean {
    const claimed = this.db
      .query(
        `INSERT INTO reflection_job (
           episode_id, session_id, project_id, status, attempts, claimed_at, created_at, updated_at
         ) VALUES (?1, ?2, ?3, 'pending', 1, ?4, ?4, ?4)
         ON CONFLICT(episode_id) DO UPDATE SET
           attempts = reflection_job.attempts + 1,
           claimed_at = excluded.claimed_at,
           updated_at = excluded.updated_at
         WHERE reflection_job.status = 'pending'
           AND COALESCE(reflection_job.claimed_at, reflection_job.updated_at) < ?5`,
      )
      .run(input.episodeID, input.sessionID ?? null, input.projectID ?? null, now, now - leaseMs)
    return claimed.changes > 0
  }

  getReflectionJob(episodeID: string): StoredReflectionJob | undefined {
    try {
      const row = this.db.query("SELECT * FROM reflection_job WHERE episode_id = ?1").get(episodeID) as ReflectionRow | null
      return row ? reflectionJobFromRow(row) : undefined
    } catch {
      return undefined
    }
  }

  /** Newest first, filtered by whichever of project or status is given. */
  listReflectionJobs(filter: ReflectionJobFilter = {}): StoredReflectionJob[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (filter.projectID) {
      clauses.push(`project_id = ?${values.length + 1}`)
      values.push(filter.projectID)
    }
    if (filter.status) {
      clauses.push(`status = ?${values.length + 1}`)
      values.push(filter.status)
    }
    const limit = normalizeEpisodeLimit(filter.limit)
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const tail = limit !== undefined ? ` LIMIT ?${values.length + 1}` : ""
    if (limit !== undefined) values.push(limit)
    try {
      const rows = this.db
        .query(`SELECT * FROM reflection_job${where} ORDER BY created_at DESC, episode_id DESC${tail}`)
        .all(...values) as ReflectionRow[]
      // A row whose status is unknown is dropped by `reflectionJobFromRow`, never guessed at.
      return rows.flatMap((row) => {
        const job = reflectionJobFromRow(row)
        return job ? [job] : []
      })
    } catch {
      // An unreadable job page answers empty rather than taking the endpoint down.
      return []
    }
  }

  // ---- skill proposals (FH-034) ----------------------------------------------------------------

  /**
   * Writes the proposal, or replaces the one already under this id.
   *
   * The id is `proposal:<episodeID>`, so a re-close converges: the row keeps its `created_at` and
   * only moves `updated_at`. A failure to write is swallowed, because the audit of a reflection must
   * never fail the episode's close.
   */
  createProposal(input: StoredSkillProposalInput, now = Date.now()): StoredSkillProposal {
    const row = proposalRowFrom(input, now)
    try {
      this.db
        .query(
          `INSERT INTO skill_proposals (
             id, episode_id, session_id, project_id, decision_id, intent, target_skill, name, description,
             body, body_hash, evidence_refs_json, confidence, model_version, status, reason, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)
           ON CONFLICT(id) DO UPDATE SET
             episode_id = excluded.episode_id,
             session_id = excluded.session_id,
             project_id = excluded.project_id,
             decision_id = excluded.decision_id,
             intent = excluded.intent,
             target_skill = excluded.target_skill,
             name = excluded.name,
             description = excluded.description,
             body = excluded.body,
             body_hash = excluded.body_hash,
             evidence_refs_json = excluded.evidence_refs_json,
             confidence = excluded.confidence,
             model_version = excluded.model_version,
             status = excluded.status,
             reason = excluded.reason,
             updated_at = excluded.updated_at`,
        )
        .run(
          row.id,
          row.episode_id,
          row.session_id,
          row.project_id,
          row.decision_id,
          row.intent,
          row.target_skill,
          row.name,
          row.description,
          row.body,
          row.body_hash,
          row.evidence_refs_json,
          row.confidence,
          row.model_version,
          row.status,
          row.reason,
          row.created_at,
          row.updated_at,
        )
    } catch {
      // An audit that cannot be written is dropped, never raised into the reflection.
    }
    return this.getProposal(row.id) ?? { ...input, createdAt: now, updatedAt: now }
  }

  getProposal(id: string): StoredSkillProposal | undefined {
    try {
      const row = this.db.query("SELECT * FROM skill_proposals WHERE id = ?1").get(id) as SkillProposalRow | null
      return row ? proposalFromRow(row) : undefined
    } catch {
      return undefined
    }
  }

  /** Newest first, filtered by whichever of episode, project or status is given. */
  listProposals(filter: SkillProposalFilter = {}): StoredSkillProposal[] {
    const clauses: string[] = []
    const values: Array<string | number> = []
    if (filter.episodeID) {
      clauses.push(`episode_id = ?${values.length + 1}`)
      values.push(filter.episodeID)
    }
    if (filter.projectID) {
      clauses.push(`project_id = ?${values.length + 1}`)
      values.push(filter.projectID)
    }
    if (filter.status) {
      clauses.push(`status = ?${values.length + 1}`)
      values.push(filter.status)
    }
    const limit = normalizeEpisodeLimit(filter.limit)
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const tail = limit !== undefined ? ` LIMIT ?${values.length + 1}` : ""
    if (limit !== undefined) values.push(limit)
    try {
      const rows = this.db
        .query(`SELECT * FROM skill_proposals${where} ORDER BY created_at DESC, id DESC${tail}`)
        .all(...values) as SkillProposalRow[]
      // A row whose intent or status is unknown is dropped by `proposalFromRow`, never guessed at.
      return rows.flatMap((row) => {
        const proposal = proposalFromRow(row)
        return proposal ? [proposal] : []
      })
    } catch {
      // An unreadable proposal page answers empty rather than taking the endpoint down.
      return []
    }
  }

  // ---- adaptive retention (FH-082, ADR-0022 §2) ----------------------------------------------

  /**
   * Purges the four adaptive audit tables in one transaction, child-first, honouring the hard
   * exemptions in SQL. Never touches episodes, evidence, artifacts or the filesystem. Returns the
   * deleted counts.
   *
   * The exemptions: proposals in `proposed` (awaiting review) or `promoted` (the on-disk sidecar's
   * provenance) and jobs in `pending` never leave; a row a surviving row references is kept. The
   * order is child-first, so deleting the terminal jobs unprotects only the rows reachable through
   * them — a decision referenced solely by a terminal job goes with it. With retention off the
   * caller never reaches this method; a cutoff is still exclusive, so a row exactly on its boundary
   * is kept.
   */
  purgeAdaptive(input: RetentionCutoffs): RetentionPurge {
    return this.db.transaction(() => {
      const reflectionJobs = this.db
        .query(
          `DELETE FROM reflection_job
           WHERE status IN ('done', 'skipped', 'failed') AND updated_at < ?1`,
        )
        .run(input.reflectionBefore).changes
      const proposals = this.db
        .query(
          `DELETE FROM skill_proposals
           WHERE status = 'rejected' AND updated_at < ?1
             AND NOT EXISTS (SELECT 1 FROM reflection_job j WHERE j.proposal_id = skill_proposals.id)`,
        )
        .run(input.proposalsBefore).changes
      const plans = this.db
        .query(
          `DELETE FROM adaptive_plan
           WHERE (applied = 1 AND updated_at < ?1) OR (applied = 0 AND updated_at < ?2)`,
        )
        .run(input.appliedPlansBefore, input.plansBefore).changes
      const decisions = this.db
        .query(
          `DELETE FROM adaptive_decision
           WHERE shadow = 1 AND updated_at < ?1
             AND NOT EXISTS (SELECT 1 FROM adaptive_plan p WHERE p.decision_id = adaptive_decision.id)
             AND NOT EXISTS (SELECT 1 FROM reflection_job j WHERE j.decision_id = adaptive_decision.id)
             AND NOT EXISTS (SELECT 1 FROM skill_proposals s WHERE s.decision_id = adaptive_decision.id)`,
        )
        .run(input.decisionsBefore).changes
      const actingDecisions = this.db
        .query(
          `DELETE FROM adaptive_decision
           WHERE shadow = 0 AND updated_at < ?1
             AND NOT EXISTS (SELECT 1 FROM adaptive_plan p WHERE p.decision_id = adaptive_decision.id)
             AND NOT EXISTS (SELECT 1 FROM reflection_job j WHERE j.decision_id = adaptive_decision.id)
             AND NOT EXISTS (SELECT 1 FROM skill_proposals s WHERE s.decision_id = adaptive_decision.id)`,
        )
        .run(input.actingBefore).changes
      return { decisions, actingDecisions, plans, reflectionJobs, proposals }
    })()
  }

  // ---- session metrics (AH-B01) ----------------------------------------------------------------

  /**
   * Folds one plugin observation into its turn, once. Returns false when the observation was seen
   * before and nothing changed. A new turn takes the next ordinal of its session.
   */
  recordSessionMetric(
    input: {
      sessionID: string
      projectID?: string
      arms?: Record<HoldoutCapability, Arm>
      observation: MetricObservation
    },
    now = Date.now(),
  ): boolean {
    return this.db.transaction(() => {
      const fresh = this.db
        .query("INSERT OR IGNORE INTO session_metric_seen (id, at) VALUES (?1, ?2)")
        .run(`${input.sessionID}:${input.observation.kind}:${input.observation.id}`, now).changes
      if (fresh === 0) return false
      const row = this.db
        .query("SELECT * FROM session_metrics WHERE session_id = ?1 AND turn_id = ?2")
        .get(input.sessionID, input.observation.turnID) as SessionMetricRow | null
      const turn = row
        ? sessionMetricFromRow(row)
        : emptyTurn({
            sessionID: input.sessionID,
            turnID: input.observation.turnID,
            turn: this.nextSessionTurn(input.sessionID),
            ...(input.projectID ? { projectID: input.projectID } : {}),
            ...(input.arms ? { arms: input.arms } : {}),
            now,
          })
      const next = applyObservation(turn, input.observation, now)
      this.db
        .query(
          `INSERT OR REPLACE INTO session_metrics (
             session_id, turn_id, turn, project_id, provider_id, model_id, agent, requests,
             input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
             cost, model_ms, first_token_ms, tool_calls, tool_errors, tool_output_bytes, tools_json,
             compactions, skills_json, started_at, ended_at, arms_json, rereads_after_compaction,
             summary_tokens
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27)`,
        )
        .run(
          next.sessionID,
          next.turnID,
          next.turn,
          next.projectID ?? null,
          next.providerID ?? null,
          next.modelID ?? null,
          next.agent ?? null,
          next.requests,
          next.tokens.input,
          next.tokens.output,
          next.tokens.reasoning,
          next.tokens.cacheRead,
          next.tokens.cacheWrite,
          next.cost,
          next.modelMs,
          next.firstTokenMs ?? null,
          next.toolCalls,
          next.toolErrors,
          next.toolOutputBytes,
          JSON.stringify(next.tools),
          next.compactions,
          JSON.stringify(next.skills),
          next.startedAt,
          next.endedAt,
          next.arms ? JSON.stringify(next.arms) : null,
          next.rereadsAfterCompaction,
          next.summaryTokens,
        )
      return true
    })()
  }

  /** One session's turns, in the order they were first heard of. */
  listSessionMetrics(sessionID: string): SessionMetricTurn[] {
    const rows = this.db
      .query("SELECT * FROM session_metrics WHERE session_id = ?1 ORDER BY turn")
      .all(sessionID) as SessionMetricRow[]
    return rows.map(sessionMetricFromRow)
  }

  /**
   * Every session's turns in a window, for the cost screen's summary (AH-B02). The newest turns are
   * kept when there are more than the cap, so one read can never pull the whole table into memory.
   */
  listSessionMetricTurns(filter: { since?: number; projectID?: string } = {}): SessionMetricTurn[] {
    const rows = this.db
      .query(
        `SELECT * FROM session_metrics
         WHERE (?1 IS NULL OR ended_at >= ?1) AND (?2 IS NULL OR project_id = ?2)
         ORDER BY ended_at DESC LIMIT ?3`,
      )
      .all(filter.since ?? null, filter.projectID ?? null, SESSION_METRIC_TURN_CAP) as SessionMetricRow[]
    return rows.map(sessionMetricFromRow)
  }

  /** The dedupe ledger only has to outlive a redelivery, so old entries are dropped. */
  pruneSessionMetricSeen(before: number): number {
    return this.db.query("DELETE FROM session_metric_seen WHERE at < ?1").run(before).changes
  }

  private nextSessionTurn(sessionID: string) {
    const row = this.db.query("SELECT MAX(turn) AS turn FROM session_metrics WHERE session_id = ?1").get(sessionID) as {
      turn: number | null
    }
    return (row.turn ?? 0) + 1
  }

  // ---- action credentials (WA-5) ---------------------------------------------------------------

  /**
   * One row per credential name, replaced wholesale on write.
   *
   * The vault produces every column, so there is nothing to merge: re-saving a name is a new IV and
   * a new ciphertext, and keeping the old ciphertext around would only be a second copy to leak.
   */
  upsertActionCredential(
    input: { name: string; origin: string; iv: string; tag: string; ciphertext: string },
    now = Date.now(),
  ) {
    this.db
      .query(
        `INSERT INTO action_credentials (name, origin, iv, tag, ciphertext, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT(name) DO UPDATE SET origin = ?2, iv = ?3, tag = ?4, ciphertext = ?5, updated_at = ?6`,
      )
      .run(input.name, input.origin, input.iv, input.tag, input.ciphertext, now)
  }

  /** The names and where they belong. Never the sealed value: a listing has no use for it. */
  listActionCredentials() {
    const rows = this.db
      .query("SELECT name, origin, updated_at FROM action_credentials ORDER BY updated_at DESC, name ASC")
      .all() as Array<{ name: string; origin: string; updated_at: number }>
    return rows.map((row) => ({ name: row.name, origin: row.origin, updatedAt: row.updated_at }))
  }

  getActionCredential(
    name: string,
  ): Pick<ActionCredentialRow, "name" | "origin" | "iv" | "tag" | "ciphertext"> | undefined {
    const row = this.db.query("SELECT * FROM action_credentials WHERE name = ?1").get(name) as ActionCredentialRow | null
    if (!row) return undefined
    return { name: row.name, origin: row.origin, iv: row.iv, tag: row.tag, ciphertext: row.ciphertext }
  }

  removeActionCredential(name: string) {
    return this.db.query("DELETE FROM action_credentials WHERE name = ?1").run(name).changes > 0
  }

  // ---- locks ----------------------------------------------------------------------------------

  acquire(key: string, owner: string, now: number, ttl: number) {
    return this.db.transaction(() => {
      this.db.query("DELETE FROM locks WHERE key = ?1 AND expires_at <= ?2").run(key, now)
      return (
        this.db
          .query("INSERT OR IGNORE INTO locks (key, owner, acquired_at, expires_at) VALUES (?1, ?2, ?3, ?4)")
          .run(key, owner, now, now + ttl).changes > 0
      )
    })()
  }

  renew(key: string, owner: string, now: number, ttl: number) {
    this.db
      .query("UPDATE locks SET acquired_at = ?1, expires_at = ?2 WHERE key = ?3 AND owner = ?4")
      .run(now, now + ttl, key, owner)
  }

  release(key: string, owner: string) {
    this.db.query("DELETE FROM locks WHERE key = ?1 AND owner = ?2").run(key, owner)
  }

  // ---- events ---------------------------------------------------------------------------------

  /**
   * Everything that changes the store goes through here, which is what makes one subscription
   * enough: a listener sees the same sequence a reader would get from `listEvents`, so a client can
   * catch up from the database and then follow the stream without a gap in between.
   */
  subscribe(listener: (entry: StoredEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  append(event: ServerEvent, now = Date.now()): StoredEvent {
    const result = this.db
      .query("INSERT INTO events (created_at, payload_json) VALUES (?1, ?2)")
      .run(now, JSON.stringify(safeEvent(event)))
    const entry: StoredEvent = { seq: Number(result.lastInsertRowid), createdAt: now, event }
    for (const listener of this.listeners) {
      // One slow listener must not take the writer down with it.
      try {
        listener(entry)
      } catch {
        this.listeners.delete(listener)
      }
    }
    return entry
  }

  /** The sequence the log is at, so a client with nothing to catch up on starts at the end. */
  lastSeq(): number {
    const row = this.db.query("SELECT MAX(seq) as seq FROM events").get() as { seq: number | null } | null
    return row?.seq ?? 0
  }

  /** The oldest sequence still in the log, or 0 when it is empty. */
  firstSeq(): number {
    const row = this.db.query("SELECT MIN(seq) as seq FROM events").get() as { seq: number | null } | null
    return row?.seq ?? 0
  }

  /**
   * Bounds the log (RP-02): the newest `keep` events, none older than `maxAgeMs`. Nothing a live
   * client needs is lost — it is sent each event as it is written — and a client catching up past
   * what was pruned is told it has a gap. Answers how many were dropped.
   */
  pruneEvents(bounds: { keep: number; maxAgeMs: number }, now = Date.now()) {
    return this.db
      .query("DELETE FROM events WHERE seq <= (SELECT MAX(seq) FROM events) - ?1 OR created_at < ?2")
      .run(bounds.keep, now - bounds.maxAgeMs).changes
  }

  listEvents(afterSeq: number, limit = 200): StoredEvent[] {
    const rows = this.db
      .query("SELECT * FROM events WHERE seq > ?1 ORDER BY seq ASC LIMIT ?2")
      .all(afterSeq, limit) as EventRow[]
    return rows.map((row) => ({ seq: row.seq, createdAt: row.created_at, event: JSON.parse(row.payload_json) }))
  }

  close() {
    this.db.close()
  }
}

/** How many of a routine's newest runs come with it, in the list as in `get` (`listRuns`' default). */
const ROUTINE_RUNS_LISTED = 50

/** How much of the event log is kept (RP-02): enough for any reconnect, bounded whatever the history. */
export const EVENTS_KEPT = { keep: 10_000, maxAgeMs: 7 * 24 * 60 * 60 * 1000 }

/** One routine runs one at a time; the key says which. */
export const routineLockKey = (routineID: string) => `routine:${routineID}`

export function defaultDatabasePath() {
  const base = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share")
  return join(base, "flupcode", "harness.sqlite")
}

type SessionMetricRow = {
  session_id: string
  turn_id: string
  turn: number
  project_id: string | null
  provider_id: string | null
  model_id: string | null
  agent: string | null
  requests: number
  input_tokens: number
  output_tokens: number
  reasoning_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  cost: number
  model_ms: number
  first_token_ms: number | null
  tool_calls: number
  tool_errors: number
  tool_output_bytes: number
  tools_json: string
  compactions: number
  skills_json: string
  started_at: number
  ended_at: number
  arms_json: string | null
  rereads_after_compaction: number
  summary_tokens: number
}

function sessionMetricFromRow(row: SessionMetricRow): SessionMetricTurn {
  return {
    sessionID: row.session_id,
    turnID: row.turn_id,
    turn: row.turn,
    ...(row.project_id ? { projectID: row.project_id } : {}),
    ...(row.provider_id ? { providerID: row.provider_id } : {}),
    ...(row.model_id ? { modelID: row.model_id } : {}),
    ...(row.agent ? { agent: row.agent } : {}),
    requests: row.requests,
    tokens: {
      input: row.input_tokens,
      output: row.output_tokens,
      reasoning: row.reasoning_tokens,
      cacheRead: row.cache_read_tokens,
      cacheWrite: row.cache_write_tokens,
    },
    cost: row.cost,
    modelMs: row.model_ms,
    ...(row.first_token_ms !== null ? { firstTokenMs: row.first_token_ms } : {}),
    toolCalls: row.tool_calls,
    toolErrors: row.tool_errors,
    toolOutputBytes: row.tool_output_bytes,
    tools: JSON.parse(row.tools_json),
    compactions: row.compactions,
    rereadsAfterCompaction: row.rereads_after_compaction,
    summaryTokens: row.summary_tokens,
    skills: JSON.parse(row.skills_json),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...(row.arms_json ? { arms: JSON.parse(row.arms_json) } : {}),
  }
}

type UsageEventRow = {
  id: string
  kind: UsageEvent["kind"]
  session_id: string
  parent_session_id: string | null
  root_session_id: string | null
  message_id: string | null
  turn_id: string | null
  engine_seq: number | null
  agent: string | null
  provider_id: string | null
  model_id: string | null
  variant: string | null
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
  tokens_cache_write: number
  cost_usd: number | null
  cost_basis: UsageEvent["costBasis"]
  billing: UsageEvent["billing"]
  started_at: number | null
  ended_at: number | null
  first_token_ms: number | null
  finish: string | null
  error_type: string | null
  retry_attempt: number | null
  directory: string | null
  engine_project_id: string | null
  run_id: string | null
  task_id: string | null
  attempt: number | null
  routine_id: string | null
  workflow_name: string | null
  workflow_hash: string | null
  purpose: UsagePurpose | null
  tags_json: string | null
}

type AttributionRow = {
  session_id: string
  parent_session_id: string | null
  source: "server" | "engine"
  run_id: string | null
  task_id: string | null
  attempt: number | null
  routine_id: string | null
  workflow_name: string | null
  workflow_hash: string | null
  purpose: UsagePurpose | null
  directory: string | null
  created_at: number
}

type ToolEventRow = {
  id: string
  session_id: string
  message_id: string | null
  tool: string
  started_at: number | null
  ms: number
  error: number
  bytes: number
}

function ledgerEventFromRow(row: UsageEventRow): LedgerEvent {
  const present = <K extends string, V>(key: K, value: V | null) =>
    (value === null ? {} : { [key]: value }) as Partial<Record<K, V>>
  return {
    id: row.id,
    kind: row.kind,
    sessionID: row.session_id,
    ...present("parentSessionID", row.parent_session_id),
    ...present("rootSessionID", row.root_session_id),
    ...present("messageID", row.message_id),
    ...present("turnID", row.turn_id),
    ...present("engineSeq", row.engine_seq),
    ...present("agent", row.agent),
    ...present("providerID", row.provider_id),
    ...present("modelID", row.model_id),
    ...present("variant", row.variant),
    tokens: {
      input: row.tokens_input,
      output: row.tokens_output,
      reasoning: row.tokens_reasoning,
      cacheRead: row.tokens_cache_read,
      cacheWrite: row.tokens_cache_write,
    },
    ...present("costUSD", row.cost_usd),
    costBasis: row.cost_basis,
    billing: row.billing,
    ...present("startedAt", row.started_at),
    ...present("endedAt", row.ended_at),
    ...present("firstTokenMs", row.first_token_ms),
    ...present("finish", row.finish),
    ...present("errorType", row.error_type),
    ...present("retryAttempt", row.retry_attempt),
    ...present("directory", row.directory),
    ...present("engineProjectID", row.engine_project_id),
    ...present("runID", row.run_id),
    ...present("taskID", row.task_id),
    ...present("attempt", row.attempt),
    ...present("routineID", row.routine_id),
    ...present("workflowName", row.workflow_name),
    ...present("workflowHash", row.workflow_hash),
    ...present("purpose", row.purpose),
    ...(row.tags_json === null ? {} : { tags: JSON.parse(row.tags_json) as Record<string, string> }),
  }
}
