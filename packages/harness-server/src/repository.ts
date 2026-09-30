import { Database } from "bun:sqlite"
import type { UsageRow } from "./usage"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, sep } from "node:path"
import {
  normalizeEpisodeLimit,
  normalizeOutcome,
  parseFailures,
  parseStringList,
  parseVerifications,
  RUN_EPISODE_PREFIX,
} from "./adaptive/episode"
import {
  EVIDENCE_TOTAL_LIMIT,
  evidenceHash,
  isEvidenceHash,
  sliceEvidence,
} from "./adaptive/evidence"
import type {
  EvidenceInput,
  EvidenceKind,
  EvidenceLink,
  EvidenceSlice,
} from "./adaptive/evidence"
import type {
  ActionTaskInput,
  BrowserAllowRule,
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
} from "./types"
import { decisionFromRow, decisionRowFrom } from "./adaptive/decision-record"
import type { DecisionRow } from "./adaptive/decision-record"
import { planFromRow, planRowFrom } from "./adaptive/context-record"
import type { PlanRow } from "./adaptive/context-record"
import { reflectionJobFromRow, reflectionJobRowFrom } from "./adaptive/learning/reflection-job"
import type { ReflectionRow } from "./adaptive/learning/reflection-job"
import { proposalFromRow, proposalRowFrom } from "./adaptive/learning/proposal-record"
import type { SkillProposalRow } from "./adaptive/learning/proposal-record"
import type { RetentionCutoffs, RetentionPurge } from "./adaptive/retention"
import type { DecisionKind } from "./adaptive/decision"
import { applyObservation, emptyTurn } from "./adaptive/session-metrics"
import type { MetricObservation, SessionMetricTurn } from "./adaptive/session-metrics"

/** How much text an artifact keeps inline (§12.1). Anything past it is cut, and says it was. */
export const ARTIFACT_LIMIT = 1_000_000

/** Mirrors `documents.ts`; duplicated rather than imported to avoid a reverse dependency. */
const DOCUMENTS_DIRECTORY = join(".flupcode", "artifacts")

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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS adaptive_decision_episode ON adaptive_decision(episode_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_decision_session ON adaptive_decision(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adaptive_decision_kind ON adaptive_decision(kind, created_at DESC);
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
})

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

type EpisodeRow = {
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
const decodeEpisode = (row: EpisodeRow): SessionEpisode => {
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
})

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

  constructor(path = process.env.FLUPCODE_HARNESS_DB ?? defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
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
    this.migrateDocumentPaths()
    this.migrateEvidenceSize()
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
    const runs = this.db
      .query("SELECT * FROM runs WHERE source_type = 'routine' ORDER BY started_at DESC")
      .all() as RunRow[]
    const byRoutine = new Map<string, Run[]>()
    for (const run of runs) {
      const key = run.source_id ?? ""
      byRoutine.set(key, [...(byRoutine.get(key) ?? []), decodeRun(run)])
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
           (id, source_type, source_id, session_id, status, started_at, finished_at, error, directory, options)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
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
      )
  }

  startRun(
    source: RunSource,
    now: number,
    directory?: string,
    options: Pick<Run, "toolLimitMs" | "outside" | "shell" | "packs" | "worktrees" | "policy" | "allow"> = {},
  ) {
    const run: Run = { id: crypto.randomUUID(), source, status: "running", startedAt: now, directory, ...options }
    this.db.transaction(() => {
      this.insertRun(run)
      if (source.type === "routine") this.markRun(source.routineID, now)
    })()
    this.append({ type: "run.started", run })
    return run
  }

  getRun(runID: string) {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?1").get(runID) as RunRow | null
    return row ? decodeRun(row) : undefined
  }

  listRuns(source?: RunSource, limit = 50) {
    const rows = source
      ? (this.db
          .query("SELECT * FROM runs WHERE source_type = ?1 AND source_id IS ?2 ORDER BY started_at DESC LIMIT ?3")
          .all(source.type, sourceKey(source), limit) as RunRow[])
      : (this.db.query("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?1").all(limit) as RunRow[])
    return rows.map(decodeRun)
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
    return rows.map(decodeRun)
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
    return rows.map(decodeRun)
  }

  attachSession(runID: string, sessionID: string) {
    this.db.query("UPDATE runs SET session_id = ?1 WHERE id = ?2").run(sessionID, runID)
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
    return rows.map((row) => ({
      id: row.id,
      directory: row.directory,
      sha: row.sha,
      title: row.title,
      ...(row.summary ? { summary: row.summary } : {}),
      ...(row.run_id ? { runID: row.run_id } : {}),
      ...(row.task_id ? { taskID: row.task_id } : {}),
      createdAt: row.created_at,
    }))
  }

  getCheckpoint(id: string) {
    return this.listCheckpoints().find((checkpoint) => checkpoint.id === id)
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
        `SELECT tasks.*, runs.directory AS run_directory
         FROM tasks JOIN runs ON runs.id = tasks.run_id
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`,
      )
      .all(...(values as never[])) as Array<TaskRow & { run_directory: string | null }>
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
        ...(row.tokens !== null ? { tokens: row.tokens } : {}),
        ...(row.cost !== null ? { cost: row.cost } : {}),
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
               (id, run_id, position, name, prompt, kind, command, action_json, attempt, retries, retry_of, gate, agent, model_json, depends_on, when_json, foreach_source, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, 'queued')`,
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
    try {
      if (!input.content) return undefined
      const sliced = sliceEvidence(input)
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
  evidenceFor(episode: SessionEpisode, now = Date.now()): EvidenceSlice[] {
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
          this.db.query("DELETE FROM evidence WHERE hash = ?1").run(hash)
        }
        return doomed.length
      })()
    } catch {
      return 0
    }
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
             model_version, source, degraded, degraded_reason, latency_ms, policy_json, shadow, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)
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
    const limit = normalizeEpisodeLimit(filter.limit)
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : ""
    const tail = limit !== undefined ? ` LIMIT ?${values.length + 1}` : ""
    if (limit !== undefined) values.push(limit)
    try {
      const rows = this.db
        .query(`SELECT * FROM adaptive_decision${where} ORDER BY created_at DESC, id DESC${tail}`)
        .all(...values) as DecisionRow[]
      // A row whose JSON is corrupt is decoded defensively by `decisionFromRow`, never thrown.
      return rows.flatMap((row) => {
        const decision = decisionFromRow(row)
        return decision ? [decision] : []
      })
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
             applied, tokens_before, tokens_after, decision_id, truncated, created_at, updated_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)
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
      // A row whose JSON is corrupt is decoded defensively by `planFromRow`, never thrown.
      return rows.flatMap((row) => {
        const plan = planFromRow(row)
        return plan ? [plan] : []
      })
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
    input: { sessionID: string; projectID?: string; observation: MetricObservation },
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
            now,
          })
      const next = applyObservation(turn, input.observation, now)
      this.db
        .query(
          `INSERT OR REPLACE INTO session_metrics (
             session_id, turn_id, turn, project_id, provider_id, model_id, agent, requests,
             input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
             cost, model_ms, first_token_ms, tool_calls, tool_errors, tool_output_bytes, tools_json,
             compactions, skills_json, started_at, ended_at
           ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
             ?19, ?20, ?21, ?22, ?23, ?24)`,
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
      .run(now, JSON.stringify(event))
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

/** One routine runs one at a time; the key says which. */
export const routineLockKey = (routineID: string) => `routine:${routineID}`

function defaultDatabasePath() {
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
    skills: JSON.parse(row.skills_json),
    startedAt: row.started_at,
    endedAt: row.ended_at,
  }
}
