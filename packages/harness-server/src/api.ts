import { normalizeRoutineRetry, normalizeRoutineSchedule } from "./validation"
import { scheduleProblem } from "./schedule"
import { ARTIFACT_KINDS } from "./types"
import type {
  ActionTaskInput,
  ArtifactInput,
  ArtifactKind,
  BrowserAllowRule,
  RoutineCreateOptions,
  RoutineInput,
  RunPolicy,
  RunStatus,
  TaskCondition,
  TaskInput,
} from "./types"
import type { SqliteRoutineRepository } from "./repository"
import { readFileSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import { confinedPath, projectRoots, type ProjectRoots } from "./project-roots"
import { InvalidModelError, MissingInputsError, UnknownWorkflowError, RoutineBusyError, RoutineScheduler } from "./scheduler"
import { UnknownTaskError } from "./workflow"
import { externalActivity } from "./runner"
import { eventStream, resumeFrom } from "./stream"
import { handleBrowserRequest } from "./browser-routes"
import type { RecipeDriver } from "./browser"
import { bearerFrom, tokenMatches } from "./browser-token"
import { allowedHarnessHost, allowedHarnessOrigin, applyHarnessCors, hostedWebOrigin, preflightResponse } from "./cors"
import { pairCookie, pairCookieFrom, type Pairing, type PairingGrant, type PairingRefusal } from "./pairing"
import type { ActionApprover } from "./action-approval"
import type { BrowserPolicy } from "./browser-policy"
import { readBrowserMcpCall, type BrowserMcpGate } from "./browser-mcp"
import { handleActionRequest } from "./action-routes"
import type { ActionRunner } from "./action-runner"
import { handleActionProfileRequest } from "./action-profile-routes"
import { actionInputProblem, allowRulesFrom, missingAllowRules } from "./action-allow"
import { handleCredentialRequest } from "./credential-routes"
import type { CredentialVault } from "./vault"
import type { RuntimeProbe } from "./adaptive/runtime"
import { handleDecisionRequest } from "./adaptive/decision-routes"
import { handleLabelCoverageRead } from "./adaptive/labeler"
import type { DecisionService } from "./adaptive/decision-service"
import { handleValueGateRead } from "./adaptive/value-gate"
import type { ValueGate } from "./adaptive/value-gate"
import { handleContextPlanRequest } from "./adaptive/context-routes"
import type { ContextManager } from "./adaptive/context-manager"
import {
  handleLearnedSkillAction,
  handleLearnedSkillRequest,
  handleProposalRequest,
  handleProposalReviewRequest,
} from "./adaptive/learning-routes"
import type { ProposalReview } from "./adaptive/learning/review"
import type { LearnedSkillActions, LearnedSkillReader, ProposalReader } from "./adaptive/learning-routes"
import { handleRelevanceRequest } from "./adaptive/relevance-routes"
import type { RelevanceService } from "./adaptive/relevance"
import { handleGuardrailsRequest, handleGuardrailsStatusRequest } from "./adaptive/guardrails-routes"
import { handleEvidenceReadRequest, handleToolTrimRequest } from "./adaptive/tool-trim-routes"
import type { GuardrailService } from "./adaptive/guardrails"
import { handleCompactionAnchorsRequest } from "./adaptive/compaction-anchors"
import { handleSessionMetricsRead, handleSessionMetricsRequest } from "./adaptive/session-metrics"
import { armFor, armsFor } from "./adaptive/holdout"
import { handleAdaptiveConfigRequest } from "./adaptive/config-routes"
import { handleModelKeyRequest } from "./adaptive/model-key-routes"
import type { ModelKey } from "./adaptive/model-key"
import { handleSessionOverrideRequest } from "./adaptive/session-override"
import type { SessionOverrides } from "./adaptive/session-override"
import type { AdaptiveConfigSurface } from "./adaptive/config-surface"
import type { AdaptiveConfig, SelectionConfig } from "./adaptive/config"

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  })

const error = (message: string, status: number) => json({ error: message }, status)

/** A folder a caller named that is not inside a project the engine knows (TI-11). */
const notAProject = () => error("That folder is not a project FlupCode knows", 403)

const inputFrom = (value: unknown): RoutineInput | undefined => {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  if (typeof input.name !== "string" || !input.name.trim()) return undefined
  const action = actionFrom(input.action)
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : ""
  // A routine says something: a prompt for a model turn, or an action for a deterministic run.
  // An action task has nothing to say to a model, so it is allowed to leave the prompt empty (WA-7).
  if (!prompt && !action) return undefined
  const retry = normalizeRoutineRetry(input.retry)
  return {
    name: input.name.trim(),
    description: typeof input.description === "string" ? input.description.trim() : "",
    prompt,
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
    workflow: workflowFrom(input.workflow),
    policy: policyFrom((input as Record<string, unknown>).policy),
    ...(action ? { action } : {}),
    allow: allowFrom(input.allow),
    ...(input.missed === "skip" ? { missed: "skip" as const } : {}),
    ...(retry ? { retry } : {}),
  }
}

/** A web action a routine or task runs (WA-7): the profile id and the values it was given. */
const actionFrom = (value: unknown): ActionTaskInput | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || !record.id.trim()) return undefined
  const inputs =
    record.inputs && typeof record.inputs === "object" && !Array.isArray(record.inputs)
      ? (record.inputs as Record<string, unknown>)
      : undefined
  return { id: record.id.trim(), ...(inputs ? { inputs } : {}) }
}

/** The allow rules a caller sent (WA-7), or nothing when there are none worth keeping. */
const allowFrom = (value: unknown): BrowserAllowRule[] | undefined => {
  const rules = allowRulesFrom(value)
  return rules.length > 0 ? rules : undefined
}

/** A routine's workflow, or nothing when it runs a single prompt (HF-8). */
const workflowFrom = (value: unknown): RoutineInput["workflow"] => {
  if (!value || typeof value !== "object") return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== "string" || !record.name.trim()) return undefined
  const inputs: Record<string, string> = {}
  if (record.inputs && typeof record.inputs === "object" && !Array.isArray(record.inputs)) {
    for (const [name, entry] of Object.entries(record.inputs as Record<string, unknown>)) {
      if (typeof entry === "string") inputs[name] = entry
    }
  }
  return { name: record.name.trim(), ...(Object.keys(inputs).length > 0 ? { inputs } : {}) }
}

/**
 * A routine that names a workflow it cannot run (HF-8).
 *
 * Checked when the routine is written and when it is run on demand, so a typo fails at the
 * form with its reason instead of as a failed run at 2am. A file deleted afterwards still
 * fails loudly in history via `begin`.
 */
const routineWorkflowProblem = async (
  input: RoutineInput,
  overrides: Record<string, string> = {},
): Promise<{ message: string; status: number } | undefined> => {
  if (!input.workflow) return undefined
  const workflow = await findWorkflow(input.workflow.name, input.projectDirectory)
  if (!workflow) return { message: `No workflow called ${input.workflow.name}`, status: 404 }
  const filled = { ...(workflow.inputDefaults ?? {}), ...(input.workflow.inputs ?? {}), ...overrides }
  const missing = workflow.inputs.filter((name) => !filled[name]?.trim())
  if (missing.length > 0) return { message: `This workflow needs ${missing.join(", ")}`, status: 400 }
  return undefined
}

/**
 * A routine that drives a web action it could never run (WA-7).
 *
 * The interactive path asks `ctx.ask` for one approval before the recipe runs; a scheduled run has
 * nobody to answer it, so the consent is written on the routine as allow rules. Without one covering
 * the profile the routine is refused here, with the resource it is missing, rather than hanging at
 * 2am on a question nobody can see.
 */
const routineActionProblem = (
  input: RoutineInput,
  actions?: ActionRunner,
): { message: string; status: number } | undefined => {
  if (!input.action) return undefined
  if (!actions) return { message: "Web actions are not available on this server", status: 409 }
  // The same folder the scheduled run resolves from, so a routine that names a project profile is
  // not refused with a 404 at the form while the run itself would have found it (WA-8).
  const profile = actions
    .list(input.projectDirectory ? { directory: input.projectDirectory } : {})
    .profiles.find((entry) => entry.id === input.action!.id)
  if (!profile) return { message: `No action called "${input.action.id}"`, status: 404 }
  const missing = missingAllowRules(input.allow ?? [], profile)
  if (missing.length > 0)
    return {
      message: `"${profile.id}" runs unattended, so it cannot ask for approval. Allow ${missing
        .map((rule) => rule.pattern)
        .join(", ")} first.`,
      status: 422,
    }
  const problem = actionInputProblem(profile, input.action.inputs)
  if (problem) return { message: problem, status: 422 }
  return undefined
}

/**
 * Advisory notes on a routine that are not reasons to refuse it (WA-7).
 *
 * An action drives the run, so instructions saved beside it are never read; saying so beats a
 * routine that looks like it prompts and does not.
 */
const routineWarnings = (input: RoutineInput): string[] =>
  input.action && input.prompt.trim() ? ["This routine runs a web action, so its instructions are ignored."] : []

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
  const kind =
    input.kind === "verify"
      ? "verify"
      : input.kind === "external"
        ? "external"
        : input.kind === "action"
          ? "action"
          : "agent"
  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : ""
  const command = typeof input.command === "string" ? input.command.trim() : ""
  const action = actionFrom(input.action)
  // A verify task has nothing to say to a model, an external one runs a command instead, and an
  // action runs a recipe (WA-7). A prompt requirement for any of them would only make callers
  // invent one.
  if (kind === "agent" && !prompt) return undefined
  if (kind === "external" && !command) return undefined
  if (kind === "action" && !action) return undefined
  const model = modelFrom(input.model)
  return {
    name: input.name.trim(),
    prompt,
    kind,
    ...(kind === "external" && command ? { command } : {}),
    ...(kind === "action" && action ? { action } : {}),
    agent: typeof input.agent === "string" && input.agent ? input.agent : undefined,
    ...(model ? { model } : {}),
    ...(kind === "verify" ? { retries: retriesFrom(input.retries) } : {}),
    // The graph (H-28), when a caller builds one by hand rather than from a workflow file.
    ...(Array.isArray(input.dependsOn)
      ? { dependsOn: input.dependsOn.filter((entry): entry is string => typeof entry === "string" && !!entry.trim()) }
      : {}),
    ...(conditionFrom(input.when) ? { when: conditionFrom(input.when) } : {}),
    ...(typeof input.foreach === "string" && input.foreach.trim() ? { foreach: input.foreach.trim() } : {}),
    // Wait for verified work (RP-06); anything else is not a requirement this server knows.
    ...(input.require === "verified" ? { require: "verified" as const } : {}),
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
  const input = value as { models?: unknown; fallback?: unknown; budget?: unknown; unattended?: unknown }
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
    ...(input.unattended === "deny" || input.unattended === "gate" ? { unattended: input.unattended } : {}),
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

const KINDS: ArtifactKind[] = [...ARTIFACT_KINDS]

/** How many documents one page of the artifacts list holds, unless the caller asks for fewer. */
const ARTIFACT_PAGE = 100
const MAX_ARTIFACT_PAGE = 500

/** What `artifact_write` reports (RP-03). Anything naming a run or a task is ignored: that is ours. */
const documentWriteFrom = (value: unknown): DocumentWrite | undefined => {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  const text = (name: string) => (typeof input[name] === "string" && input[name] ? (input[name] as string) : undefined)
  const sessionID = text("sessionID")
  const directory = text("directory")
  const path = text("path")
  if (!sessionID || !directory || !path || (input.kind !== undefined && input.kind !== "document")) return undefined
  return {
    sessionID,
    directory,
    path,
    ...(text("messageID") ? { messageID: text("messageID")! } : {}),
    ...(text("title") ? { title: text("title")! } : {}),
  }
}

/** Two spellings of one folder, as the engine and a plugin may give them (macOS `/var` → `/private/var`). */
const sameFolder = (left: string, right: string) => {
  const real = (path: string) => {
    try {
      return realpathSync(path)
    } catch {
      return resolve(path)
    }
  }
  return real(left) === real(right)
}

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
import { duration, findWorkflow, listWorkflows, readWorkflow, removeWorkflow, saveWorkflow } from "./workflow"
import { AgentError, deleteAgentFile, listAgentFiles, writeAgentFile } from "./agents"
import { SkillError, deleteSkill, readSkill, skillReport, writeSkill } from "./skills"
import { CommandError, deleteCommandFile, listCommandFiles, writeCommandFile } from "./commands"
import { ConfigFileError, exportConfigFiles, listConfigFiles, readConfigFile } from "./config-files"
import { handleEngineConfigRequest } from "./engine-config-routes"
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
import { drop, dropAll, planRestore, restore, take } from "./checkpoint"
import { filesPerTask } from "./touched"
import { registerPlans } from "./plans"
import { indexDocument, registerDocuments, type DocumentWrite } from "./documents"
import { handleUsageRead } from "./usage"
import { handleUsageIngest, learnSession } from "./usage-ledger"
import type { createUsagePricing } from "./usage-pricing"
import { FINDINGS_INSTRUCTION } from "./findings"
import { capturedPrompts, instructionsFor, readInstruction, usedTools } from "./context"

const splitPath = (request: Request) => new URL(request.url).pathname.split("/").filter(Boolean)

/**
 * The routes the blanket bearer check leaves alone (AH-A05). A share link is read at a plain link,
 * so its unguessable id is the secret. `/harness/adaptive/*` is answered above, each surface under
 * its own guard — the acting line's dedicated token, or the browser bearer — and a surface that was
 * not built must stay an ordinary 404 there rather than turn into a 403 here.
 */
const openToAnyCaller = (request: Request, path: string[]) =>
  path[1] === "adaptive" || (request.method === "GET" && path[1] === "shares" && path.length === 3)

export type HarnessHandlerOptions = {
  browser?: RecipeDriver
  /** The UI's bearer: every guarded route. */
  token?: string
  /**
   * The engine plugins' bearer (TI-10): the action catalogue, approval and run, the evidence
   * screenshots a run returns, and the plan's hand-off. It cannot commit, push, write config or read
   * anything else, so what an agent can find in the engine's reach is not the UI's key.
   */
  pluginToken?: string
  actions?: ActionRunner
  /** A web action's approval asked in the session, for the OpenCode 2 actions plugin (V2-31). */
  actionApprover?: ActionApprover
  /** The browser policy (BU-01): its standing grants, revoked from the settings, and its audit. */
  browserPolicy?: BrowserPolicy
  /**
   * Calls to the user's own browser through an MCP preset (BU-02): the engine plugin asks it before
   * each call runs and reports what each returned. Behind the plugins' bearer only.
   */
  browserMcp?: BrowserMcpGate
  /** The plan's hand-off to build asked in the session, for the OpenCode 2 `plan_exit` tool (V2-33). */
  planExit?: (sessionID: string) => Promise<{ approved: boolean }>
  credentials?: CredentialVault
  runtimeProbe?: RuntimeProbe
  decisions?: DecisionService
  /** The value-of-information gate (AH-C05): read-only status per assigned kind. */
  valueGate?: ValueGate
  context?: ContextManager
  /** The learning audit (FH-034): the drafted proposals and the learned-skill roster. */
  proposals?: ProposalReader
  learnedSkills?: LearnedSkillReader
  /** The human review of a staged proposal (AH-A04): the only route that installs a learned skill. */
  proposalReview?: ProposalReview
  /** Disabling, enabling and archiving an installed learned skill (AH-E04); needs the artifacts bearer. */
  learnedSkillActions?: LearnedSkillActions
  /** The acting relevance line (FH-04): the only adaptive route a live turn calls. */
  relevance?: RelevanceService
  /** The failure/loop guardrails (FH-060–063): an advisory loopback route fed by opaque digests. */
  guardrails?: GuardrailService
  /** Whether the compaction anchors are on (AH-D04): `compaction.anchors` and the kill switch. */
  compactionAnchors?: () => boolean
  /** The live adaptive config the tool-output trim reads its switch and bounds from (AH-D02). */
  toolTrimConfig?: () => AdaptiveConfig
  /** The effective per-step selection policy (AH-D03): its switch already folds in the kill switch and the probe gate. */
  selectionPolicy?: () => SelectionConfig
  /** The live holdout share, so a metrics row records the session's arms (AH-B05). */
  holdoutFraction?: () => number
  /** The dedicated loopback bearer of the acting line; the route is closed without it (ADR-0022). */
  adaptiveToken?: string
  /** The adaptive settings surface (FH-070): reads the settings and writes the switches. */
  adaptiveConfig?: AdaptiveConfigSurface
  /** The predictive model's key (ADR-0017, amended): saved to the vault, never read back. */
  modelKey?: ModelKey
  /** The per-session override (AH-E02): the pause and exclusions the composer's chip writes. */
  overrides?: SessionOverrides
  /** The address the server listens on, so a `Host` naming it is accepted (AH-A05). */
  hostname?: string
  /** The basis and billing the server can tell for a ledger row before it is stored (UL-05). */
  usagePricing?: Pick<ReturnType<typeof createUsagePricing>, "classify">
  /** The folders a caller may name (TI-11); the engine's projects and worktrees when absent. */
  projectRoots?: ProjectRoots
  /**
   * Browser tabs paired with a one-time code (HE-01). Their token is the UI's scope, used only from
   * the origin that paired; without it `/harness/pair/*` is an ordinary 404.
   */
  pairing?: Pairing
}

export const createHarnessHandler = (
  repository: SqliteRoutineRepository,
  scheduler: RoutineScheduler,
  options: HarnessHandlerOptions = {},
) => {
  const roots = options.projectRoots ?? projectRoots(() => scheduler.engine.projectRoots())
  const pluginCaller = (request: Request) =>
    !!options.pluginToken && tokenMatches(options.pluginToken, bearerFrom(request))
  // A paired tab's token, from the origin it paired on (HE-01).
  const pairedCaller = (request: Request) =>
    !!options.pairing && options.pairing.verify(bearerFrom(request), request.headers.get("origin") ?? undefined)
  // The UI's scope (TI-10): the token the desktop hands its window, or a paired tab's.
  const uiCaller = (request: Request) => tokenMatches(options.token ?? "", bearerFrom(request)) || pairedCaller(request)
  // FlupCode's web app served from elsewhere (HE-01): only pairing, until it holds a paired token.
  const hostedCaller = (request: Request) => {
    const origin = request.headers.get("origin") ?? undefined
    return !!options.pairing && hostedWebOrigin(origin) && !allowedHarnessOrigin(origin)
  }
  // The one artifact read a plugin makes: a run's evidence screenshot, shown back in the chat.
  const evidenceRead = (request: Request, path: string[]) =>
    request.method === "GET" &&
    path[1] === "artifacts" &&
    path[3] === "raw" &&
    path.length === 4 &&
    repository.getArtifact(path[2] ?? "")?.kind === "screenshot"
  const handle = async (request: Request) => {
    const path = splitPath(request)
    if (path[0] !== "harness") return error("Not found", 404)
    // A DNS-rebinding page is same-origin with the harness, so neither CORS nor the origin check
    // below stops it reading; only its `Host`, which still names the attacker's domain, gives it away.
    if (!allowedHarnessHost(request.headers.get("host") ?? undefined, options.hostname ?? "127.0.0.1"))
      return json({ error: "Forbidden", code: "invalid_host" }, 403)
    if (path[1] === "pair" && options.pairing) return handlePairRequest(request, path, options.pairing)
    // The hosted web app reads nothing but the health check until it pairs (HE-01). Decided here, not
    // by CORS alone: a request CORS hides the answer of still runs.
    if (hostedCaller(request) && !(path[1] === "health" && request.method === "GET") && !pairedCaller(request))
      return json({ error: "This tab is not paired with this computer", code: "invalid_token" }, 403)
    // CSRF is not stopped by CORS: a simple cross-origin request still runs server-side while only
    // hiding its answer. So a mutating request that names an origin has to name an allowed one —
    // callers without an origin (curl, the plugin, node) are unaffected. A paired hosted tab got here.
    if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
      const origin = request.headers.get("origin") ?? undefined
      if (origin !== undefined && !allowedHarnessOrigin(origin) && !hostedCaller(request)) return error("Forbidden", 403)
    }
    // The browser runtime is the one surface a page can reach from outside the process, so it is
    // behind its own bearer token rather than the loopback address alone (WA-1).
    if (path[1] === "browser" && options.browser) {
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleBrowserRequest(request, path.slice(2), options.browser)
    }
    // The runner drives the browser on the user's machine, so it sits behind the same bearer as
    // `/harness/browser/*` (WA-2). Without a runner the path is an ordinary 404.
    if (path[1] === "actions" && options.actions) {
      if (!uiCaller(request) && !pluginCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      const caller = uiCaller(request) ? "ui" : "plugin"
      return handleActionRequest(request, path.slice(2), options.actions, options.actionApprover, caller)
    }
    // The browser policy's grants and audit (BU-01). Revoking is the reader's, and so is reading what
    // the agent did: the app's bearer only, never the plugins'.
    if (path[1] === "browser-policy" && options.browserPolicy && options.token) {
      if (!uiCaller(request)) return json({ error: "Forbidden", code: "invalid_token" }, 403)
      if (path[2] === "grants" && path.length === 3 && request.method === "GET")
        return json({ data: options.browserPolicy.grants() })
      if (path[2] === "grants" && path[3] && path.length === 4 && request.method === "DELETE")
        return options.browserPolicy.revoke(path[3]) ? json({ data: { revoked: true } }) : error("No such grant", 404)
      if (path[2] === "audit" && path.length === 3 && request.method === "GET") {
        const params = new URL(request.url).searchParams
        return json({
          data: repository.listBrowserAudit({
            ...(params.get("runID") ? { runID: params.get("runID")! } : {}),
            ...(params.get("sessionID") ? { sessionID: params.get("sessionID")! } : {}),
            limit: Math.min(Number(params.get("limit")) || 100, 500),
          }),
        })
      }
      return error("Not found", 404)
    }
    // What a web action signs in with (WA-5). Stored secrets are the most sensitive thing here, so
    // the vault is behind the same bearer rather than the loopback address alone, and it is only a
    // route at all when a key was resolved.
    if (path[1] === "credentials" && options.credentials) {
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleCredentialRequest(request, path.slice(2), options.credentials)
    }
    // The plan's hand-off (V2-33): OpenCode 2's `plan_exit` tool has no way to ask, so it asks here,
    // behind the bearer the engine's plugins hold.
    if (path[1] === "plan-exit" && request.method === "POST" && options.planExit) {
      if (!uiCaller(request) && !pluginCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      const body = (await request.json().catch(() => ({}))) as { sessionID?: unknown }
      if (typeof body.sessionID !== "string" || !body.sessionID) return error("A session is required", 400)
      return json({ data: await options.planExit(body.sessionID) })
    }
    // The user's browser through an MCP preset (BU-02): the engine's permission hook asks here before
    // each call, and reports what it returned. Only the plugins make these calls, so only their bearer
    // is taken; without one the route is an ordinary 404.
    if (path[1] === "browser-mcp" && path.length === 3 && request.method === "POST" && options.browserMcp && options.pluginToken) {
      if (!pluginCaller(request)) return json({ error: "Forbidden", code: "invalid_token" }, 403)
      const call = readBrowserMcpCall(await request.json().catch(() => undefined))
      if (!call) return error("A session, a server, its kind and a tool are required", 400)
      if (path[2] === "decide") return json({ data: await options.browserMcp.decide(call) })
      if (path[2] !== "observe") return error("Not found", 404)
      options.browserMcp.observe(call)
      return json({ data: { observed: true } })
    }
    // The usage ledger's ingest (UL-01): only the engine's plugins report what the engine spent, so
    // the route takes their token and not the app's. Without a plugin token it is an ordinary 404.
    if (path[1] === "usage" && path[2] === "events" && path.length === 3 && request.method === "POST" && options.pluginToken) {
      if (!pluginCaller(request)) return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleUsageIngest(
        request,
        repository,
        (sessionID) => scheduler.engine.describeSession(sessionID),
        options.usagePricing?.classify,
      )
    }
    // A document the agent just kept with `artifact_write` (RP-03): the engine's plugin reports which
    // file, which session and which message, and the server reads the file and works out the run and
    // task from the session's attribution (UL-04) — never from the caller (P7). Only the plugins
    // report writes, so only their bearer is taken; without one the route is an ordinary 404.
    if (path[1] === "artifacts" && path[2] === "index" && path.length === 3 && request.method === "POST" && options.pluginToken) {
      if (!pluginCaller(request)) return json({ error: "Forbidden", code: "invalid_token" }, 403)
      const write = documentWriteFrom(await readJSON(request))
      if (!write) return error("A session, a project folder and a path are required", 400)
      if (!(await roots.within(write.directory))) return notAProject()
      const describe = (sessionID: string) => scheduler.engine.describeSession(sessionID)
      // The session has to be the engine's, in that folder: a write reported for another project's
      // session would borrow that session's run.
      const session = await describe(write.sessionID).catch(() => undefined)
      if (!session || !sameFolder(session.directory, write.directory))
        return error("No such session in that folder", 404)
      await learnSession(write.sessionID, repository, describe)
      // Attribution outlives a deleted run; an artifact can only name a run and a task that exist.
      const attribution = repository.sessionAttribution(write.sessionID)
      const runID = attribution?.runID && repository.getRun(attribution.runID) ? attribution.runID : undefined
      const taskID = runID && attribution?.taskID && repository.getTask(attribution.taskID) ? attribution.taskID : undefined
      const kept = indexDocument(repository, write, { runID, taskID })
      if (!kept) return error("No such document", 404)
      return json({ data: kept.artifact, added: kept.added }, kept.added ? 201 : 200)
    }
    // Writing an action profile into a config file (WA-8). It edits the user's own config, so it
    // needs the profile id and the shape the form wrote.
    if (path[1] === "action-profiles") {
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleActionProfileRequest(request, path.slice(2))
    }
    // The engine's own config files (V2-24): OpenCode 2 no longer writes its config, so FlupCode does,
    // in the 1.x shape both lines load. Reading takes the bearer when one is configured; writing edits
    // the user's own file, so it requires that bearer, and without one the route is an ordinary 404.
    if (path[1] === "engine-config" && path.length === 2) {
      if (request.method === "PATCH" && !options.token) return json({ error: "Not found", code: "not_found" }, 404)
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleEngineConfigRequest(request)
    }
    // Which runtime the engine is on, so a gate never assumes the legacy hooks (FH-000). Only a
    // route when a probe was built; without one it falls through to the ordinary 404. The probe
    // refreshes within its own TTL, so a reader that asks twice does not double the engine calls.
    if (path[1] === "adaptive" && path[2] === "capabilities" && request.method === "GET" && options.runtimeProbe) {
      const state = await options.runtimeProbe.refresh()
      return json({ data: { ...state, capabilities: options.runtimeProbe.capabilities() } })
    }
    // Dismissing the runtime alerts (AH-D05) writes the probe's watch, so it takes the writer bearer
    // like the settings PATCH; without that bearer the route does not exist.
    if (
      path[1] === "adaptive" &&
      path[2] === "runtime" &&
      path[3] === "acknowledge" &&
      path.length === 4 &&
      request.method === "POST" &&
      options.runtimeProbe &&
      options.token
    ) {
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      await options.runtimeProbe.acknowledge()
      return json({ data: { alerts: options.runtimeProbe.alerts() } })
    }
    // The decision audit (FH-015) is as sensitive as `/harness/artifacts`: it carries what a session
    // was observed to be doing, so it takes the same bearer when one is configured. Reading only —
    // there is no route that makes a decision.
    if (path[1] === "adaptive" && path[2] === "decisions" && options.decisions) {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleDecisionRequest(request, path.slice(2), options.decisions)
    }
    // The labeling coverage (AH-C06): how many decisions per kind carry an outcome label. It is
    // derived from the decision audit, so it takes the same bearer; reading only.
    if (
      path[1] === "adaptive" &&
      path[2] === "labels" &&
      path[3] === "coverage" &&
      path.length === 4 &&
      request.method === "GET" &&
      options.decisions
    ) {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleLabelCoverageRead(request, repository)
    }
    // The value-of-information gate (AH-C05): whether each assigned model is asked, warming up,
    // exploring or paused, from the decision audit's labels. Same bearer; reading only.
    if (path[1] === "adaptive" && path[2] === "voi" && path.length === 3 && request.method === "GET" && options.valueGate) {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleValueGateRead(options.valueGate)
    }
    // The context plan audit (FH-022) is as sensitive as the decision audit: it says what a run or
    // an episode was observed to carry. Same bearer, reading only — there is no route that plans.
    if (path[1] === "adaptive" && path[2] === "plans" && options.context) {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleContextPlanRequest(request, path.slice(2), options.context)
    }
    // The learning audit (FH-034): the proposed skills a reflection drafted, and the learned skills
    // the curator installed. Same bearer as the decision audit; reading only.
    // The human review (AH-A04) installs a skill the engine loads in every later session, so like the
    // config writer it requires the artifacts bearer: with none configured it is an ordinary 404, never
    // an open loopback writer. Reading stays on the audit route below.
    if (path[1] === "adaptive" && path[2] === "proposals" && request.method === "POST" && options.proposalReview) {
      if (!options.token) return json({ error: "Not found", code: "not_found" }, 404)
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleProposalReviewRequest(request, path.slice(2), options.proposalReview)
    }
    if (path[1] === "adaptive" && path[2] === "proposals" && options.proposals) {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleProposalRequest(request, path.slice(2), options.proposals)
    }
    // A person's actions on an installed learned skill (AH-E04) change what every later session loads,
    // so like the review they require the artifacts bearer and are an ordinary 404 without one.
    if (
      path[1] === "adaptive" &&
      path[2] === "learned-skills" &&
      request.method === "POST" &&
      options.learnedSkills &&
      options.learnedSkillActions
    ) {
      if (!options.token) return json({ error: "Not found", code: "not_found" }, 404)
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleLearnedSkillAction(request, path.slice(2), options.learnedSkills, options.learnedSkillActions)
    }
    if (path[1] === "adaptive" && path[2] === "learned-skills" && options.learnedSkills) {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleLearnedSkillRequest(request, path.slice(2), options.learnedSkills)
    }
    // The adaptive settings surface (FH-070). Reading is as sensitive as the other adaptive audits,
    // so it takes the artifacts bearer when one is configured. Writing edits the user's own config
    // file, so it requires that bearer: with none configured the route is an ordinary 404, never an
    // open loopback writer.
    if (path[1] === "adaptive" && path[2] === "config" && path.length === 3 && options.adaptiveConfig) {
      if (request.method === "PATCH" && !options.token) return json({ error: "Not found", code: "not_found" }, 404)
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleAdaptiveConfigRequest(request, options.adaptiveConfig)
    }
    // The predictive model's key (ADR-0017, amended). It sits beside the settings writer and takes the
    // same bearer, obligatorily for every method: the status says where a key comes from, the writes
    // store or remove one, and no answer ever carries the key. Without the bearer it is a 404.
    if (path[1] === "adaptive" && path[2] === "model-key" && path.length === 3 && options.modelKey) {
      if (!options.token) return json({ error: "Not found", code: "not_found" }, 404)
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleModelKeyRequest(request, options.modelKey)
    }
    // The per-session override and the turn the composer's chip describes (AH-E02). Both are a
    // browser's, so they take the artifacts bearer. Like the settings writer, the override writes only
    // behind that bearer: with none configured the routes are an ordinary 404 and not announced.
    if (path[1] === "adaptive" && path[2] === "sessions" && options.overrides) {
      if (!options.token) return json({ error: "Not found", code: "not_found" }, 404)
      if (!uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleSessionOverrideRequest(request, path.slice(2), {
        overrides: options.overrides,
        ...(options.decisions ? { decisions: options.decisions } : {}),
        ...(options.context ? { plans: options.context } : {}),
      })
    }
    // The acting line (FH-04): a live turn's plugin calls it on the loopback with its own bearer,
    // never the browser/artifacts/actions one (ADR-0022). It is a POST because it decides, and the
    // route exists only when both the service and the dedicated token were resolved: without a token
    // it is an ordinary 404 and the capability is not announced, so there is no open-loopback
    // fallback. The exact path and method are required before delegating: a POST to a deeper path is
    // not this route and must not answer through it.
    if (
      path[1] === "adaptive" &&
      path[2] === "relevance" &&
      path.length === 3 &&
      request.method === "POST" &&
      options.relevance &&
      options.adaptiveToken
    ) {
      if (!tokenMatches(options.adaptiveToken, bearerFrom(request)))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleRelevanceRequest(request, options.relevance)
    }
    // The failure/loop guardrails (FH-060–063): the plugin's hooks call it on the loopback with the
    // same dedicated bearer as the relevance line. It is a POST because it decides, and it exists only
    // when both the service and the token were resolved — without a token it is an ordinary 404 and
    // the capability is not announced (ADR-0023 §2).
    if (
      path[1] === "adaptive" &&
      path[2] === "guardrails" &&
      path.length === 3 &&
      request.method === "POST" &&
      options.guardrails &&
      options.adaptiveToken
    ) {
      if (!tokenMatches(options.adaptiveToken, bearerFrom(request)))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleGuardrailsRequest(request, options.guardrails)
    }
    // The per-turn cost baseline (AH-B01): the metrics plugin posts each observation on the loopback
    // with the dedicated bearer, never the browser one. Numbers only; without a token it is a 404.
    if (
      path[1] === "adaptive" &&
      path[2] === "metrics" &&
      path.length === 3 &&
      request.method === "POST" &&
      options.adaptiveToken
    ) {
      if (!tokenMatches(options.adaptiveToken, bearerFrom(request)))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      const fraction = options.holdoutFraction
      return handleSessionMetricsRequest(
        request,
        repository,
        fraction ? (sessionID) => armsFor(sessionID, fraction()) : undefined,
      )
    }
    // The compaction anchors (AH-D04): the plugin asks for them in the engine's `.compacting` hook with
    // the dedicated bearer. A POST because the goal it carries is the user's words; without a token it
    // is a 404, and the plugin then adds nothing.
    if (
      path[1] === "adaptive" &&
      path[2] === "anchors" &&
      path.length === 3 &&
      request.method === "POST" &&
      options.adaptiveToken
    ) {
      if (!tokenMatches(options.adaptiveToken, bearerFrom(request)))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      const holdout = options.holdoutFraction
      return handleCompactionAnchorsRequest(request, {
        enabled: options.compactionAnchors ?? (() => false),
        ...(options.overrides ? { paused: options.overrides.paused } : {}),
        ...(holdout ? { control: (sessionID: string) => armFor(sessionID, "anchors", holdout()) === "control" } : {}),
        objective: (sessionID) => {
          const objective = repository.listEpisodes({ sessionID, limit: 1 })[0]?.objective
          // The coordinator's generic placeholder says nothing about the goal.
          return objective && objective !== "Interactive session" ? objective : undefined
        },
      })
    }
    // Per-step selection (AH-D03): the plugin reads its policy on a timer, outside the engine hook, with
    // the dedicated bearer. A GET because it carries nothing; without a token it is a 404 and the plugin
    // stays off.
    if (
      path[1] === "adaptive" &&
      path[2] === "selection" &&
      path.length === 3 &&
      request.method === "GET" &&
      options.selectionPolicy &&
      options.adaptiveToken
    ) {
      if (!tokenMatches(options.adaptiveToken, bearerFrom(request)))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      // The plugin latches its policy per session, so a pause travels as the list of paused sessions
      // and takes effect at that session's next cold step (AH-E02, docs/ADAPTIVE.md).
      // The holdout share travels too: the plugin draws each session's arm with the same hash as
      // `armFor`, so a control session stays on the off policy for its whole life (AH-B05, AH-G01).
      return json({
        data: {
          ...options.selectionPolicy(),
          pausedSessions: options.overrides?.pausedSessions() ?? [],
          holdoutFraction: options.holdoutFraction?.() ?? 0,
        },
      })
    }
    // The recoverable tool-output trim (AH-D02): the plugin posts a finished output and the
    // `evidence_read` tool reads a stored one back, both on the loopback with the dedicated bearer.
    // Without a token neither route exists and the capability is not announced.
    if (
      path[1] === "adaptive" &&
      ((path[2] === "tool-trim" && path.length === 3) ||
        (path[2] === "evidence" && path[3] === "read" && path.length === 4)) &&
      request.method === "POST" &&
      options.toolTrimConfig &&
      options.adaptiveToken
    ) {
      if (!tokenMatches(options.adaptiveToken, bearerFrom(request)))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      const deps = {
        store: repository,
        config: options.toolTrimConfig,
        ...(options.overrides ? { paused: options.overrides.paused } : {}),
      }
      return path[2] === "tool-trim" ? handleToolTrimRequest(request, deps) : handleEvidenceReadRequest(request, deps)
    }
    // Its read side takes the artifacts bearer, like the other adaptive audits a browser reads.
    if (path[1] === "adaptive" && path[2] === "metrics" && path.length === 3 && request.method === "GET") {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleSessionMetricsRead(request, repository)
    }
    // The read side of the guardrails (FH-062): only a browser reads the live advisory, so it takes
    // the artifacts bearer like `/harness/adaptive/decisions`, never the acting token. Reading only —
    // there is no route that makes a guardrail act.
    if (
      path[1] === "adaptive" &&
      path[2] === "guardrails" &&
      path[3] === "status" &&
      path.length === 4 &&
      request.method === "GET" &&
      options.guardrails
    ) {
      if (options.token && !uiCaller(request))
        return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return handleGuardrailsStatusRequest(request, options.guardrails)
    }
    // Says what this server can answer, so a newer client does not ask an older one for routes it
    // does not have and leave a 404 in the console (H-18). `browser` is only here when the runtime
    // was actually built: the kill switch and a missing token leave it out (WA-1).
    if (path[1] === "health" && request.method === "GET")
      return json({
        healthy: true,
        capabilities: [
          ...CAPABILITIES,
          ...(options.browser ? (["browser"] as const) : []),
          ...(options.actions ? (["web-actions"] as const) : []),
          // Its grants are revoked with the browser's bearer, so it is announced only when that exists.
          ...(options.browserPolicy && options.token ? (["browser-policy"] as const) : []),
          ...(options.credentials ? (["credentials"] as const) : []),
          // The writer shares the browser's bearer, so it is only announced when that secret exists.
          ...(options.token ? (["action-profiles"] as const) : []),
          // So does the engine config writer (V2-24).
          ...(options.token ? (["engine-config"] as const) : []),
          // The probe is built with the server, so it is announced whenever the route is (FH-000).
          ...(options.runtimeProbe ? (["adaptive"] as const) : []),
          // Dismissing its alerts writes, so it is announced only when the writer bearer exists (AH-D05).
          ...(options.runtimeProbe && options.token ? (["adaptive-runtime-alerts"] as const) : []),
          // The settings surface is its own capability: a client must not read it as the runtime
          // probe's (FH-070). It is announced whenever the service was built, token or not.
          ...(options.adaptiveConfig ? (["adaptive-config"] as const) : []),
          // The model key's routes need the writer's bearer, so they are announced only with it.
          ...(options.modelKey && options.token ? (["adaptive-model-key"] as const) : []),
          // The decision audit is announced apart from the probe: a client must not read it as the
          // runtime probe's own capability (FH-015).
          ...(options.decisions ? (["adaptive-decisions"] as const) : []),
          // The value gate's status is its own surface, so an older server is never asked for it.
          ...(options.valueGate ? (["adaptive-voi"] as const) : []),
          // The context plan audit is its own surface too: announced only when it was built (FH-022).
          ...(options.context ? (["adaptive-context"] as const) : []),
          // The learning audit is two surfaces: proposals and learned skills (FH-034).
          ...(options.proposals ? (["adaptive-proposals"] as const) : []),
          ...(options.learnedSkills ? (["adaptive-skills"] as const) : []),
          // The review writes, so it is announced only when its bearer exists (AH-A04).
          ...(options.proposalReview && options.token ? (["adaptive-proposals-review"] as const) : []),
          // So are the actions on an installed learned skill (AH-E04).
          ...(options.learnedSkills && options.learnedSkillActions && options.token
            ? (["adaptive-skills-manage"] as const)
            : []),
          // The acting relevance line (FH-04): announced only when the service was built and its
          // dedicated bearer was resolved, so an unauthenticated route is never advertised.
          ...(options.relevance && options.adaptiveToken ? (["adaptive-relevance"] as const) : []),
          // The failure/loop guardrails (FH-060–063): the same dedicated bearer and the same rule.
          ...(options.guardrails && options.adaptiveToken ? (["adaptive-guardrails"] as const) : []),
          // The per-turn cost baseline (AH-B01): the plugin's POST needs the dedicated bearer too.
          ...(options.adaptiveToken ? (["adaptive-metrics"] as const) : []),
          // The tool-output trim (AH-D02): both routes need the dedicated bearer and the config reader.
          ...(options.toolTrimConfig && options.adaptiveToken ? (["adaptive-tool-trim"] as const) : []),
          // Per-step selection (AH-D03): the policy route needs the dedicated bearer too.
          ...(options.selectionPolicy && options.adaptiveToken ? (["adaptive-selection"] as const) : []),
          // The session override (AH-E02) writes, so it is announced only when its bearer exists.
          ...(options.overrides && options.token ? (["adaptive-session"] as const) : []),
        ],
      })
    // The `Origin` check above accepts any loopback port, so it cannot tell this app from another
    // page on `localhost`. Every route below starts work (runs, best-of-n, retries, workflows,
    // routines, git), writes the user's files or reads their prompts and artifacts, so with a token
    // configured each one asks for the bearer that guards the browser (WA-9, AH-A05): a page that is
    // not this app cannot read the token, so it can neither read what the runs left behind nor start
    // one. Without a token nothing is compared and every route answers as before.
    if (
      options.token &&
      !openToAnyCaller(request, path) &&
      !uiCaller(request) &&
      !(pluginCaller(request) && evidenceRead(request, path))
    )
      return json({ error: "Forbidden", code: "invalid_token" }, 403)
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
        return error("A run needs at least one task with a name, and a prompt or a command unless it is a verify or action task", 400)
      }
      // An action task runs unattended and needs the allow rule a routine carries, which this path
      // has no way to accept: starting one here would only fail closed. Point at the routine form.
      if (tasks.some((task) => task.kind === "action"))
        return error(
          "An action task needs the allow rule a routine carries, so start it from a routine instead of /harness/runs",
          400,
        )
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
            const doing = await scheduler.engine.activity(task.sessionID).catch(() => undefined)
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
      // Held for a request mid-turn (RP-05): the answer goes to the request, which is what lets it on.
      if (run.paused === "request") return error("This run waits for an answer to its task's request", 409)
      const resumed = scheduler.approve(run.id)
      return resumed ? json({ data: resumed }) : error("This run is not waiting at a gate", 409)
    }
    // What a project's runs do when a task needs a person mid-turn (RP-05), unless the run, its routine
    // or its workflow says: read for the run card, and picked by the reader there.
    if (path[1] === "projects" && path[2] === "unattended" && !path[3]) {
      if (request.method === "GET") {
        const directory = new URL(request.url).searchParams.get("directory")
        if (!directory) return error("A project directory is required", 400)
        return json({ data: { unattended: repository.projectUnattended(directory) ?? "gate" } })
      }
      if (request.method === "PUT") {
        const body = (await readJSON(request)) as { directory?: unknown; unattended?: unknown } | undefined
        if (typeof body?.directory !== "string" || !body.directory) return error("A project directory is required", 400)
        if (body.unattended !== "deny" && body.unattended !== "gate") return error("unattended is deny or gate", 400)
        repository.setProjectUnattended(body.directory, body.unattended)
        return json({ data: { unattended: body.unattended } })
      }
    }
    // Picking up a run that failed, was stopped or lost its process (HF-5, RP-04), from a task or
    // from where it broke. What it would do is asked first (GET), because it restores the folder.
    if (path[1] === "runs" && path[2] && path[3] === "resume" && (request.method === "GET" || request.method === "POST")) {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      const given =
        request.method === "GET"
          ? (new URL(request.url).searchParams.get("fromTask") ?? undefined)
          : ((await readJSON(request)) as { fromTask?: unknown } | undefined)?.fromTask
      if (given !== undefined && typeof given !== "string") return error("fromTask is a task id", 400)
      const fromTask = given || undefined
      if (fromTask && repository.getTask(fromTask)?.runID !== run.id) return error("Task not found in this run", 404)
      try {
        if (request.method === "GET") return json({ data: await scheduler.resumePlan(run.id, fromTask) })
        const resumed = await scheduler.resume(run.id, { fromTask })
        return resumed ? json({ data: resumed }, 202) : error("Run not found", 404)
      } catch (cause) {
        if (cause instanceof GitError) return error(cause.message, cause.status)
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
      const removed = repository.removeFinishedRuns()
      // Their checkpoints go with them, refs and all (TI-15): nothing could reach them any more.
      await dropAll(repository.removeStaleCheckpoints())
      return json({ data: { removed: removed.length } })
    }
    if (path[1] === "runs" && request.method === "DELETE" && path[2] && !path[3]) {
      const run = repository.getRun(path[2])
      if (!run) return error("Run not found", 404)
      // A running run is still being written to, and its lock still held: stop it first, then it
      // can go. Deleting it underneath the runner would leave tasks pointing at nothing. One held
      // at a gate is not finished either — it is waiting for an answer.
      if (run.status === "running" || run.status === "awaiting") return error("Stop the run before deleting it", 409)
      const removed = repository.removeRun(run.id)
      await dropAll(repository.removeStaleCheckpoints())
      return json({ data: removed })
    }
    // Artifacts (H-14): what runs left behind, and what a person kept.
    if (path[1] === "artifacts" && request.method === "GET" && !path[2]) {
      const query = new URL(request.url).searchParams
      const directory = query.get("directory") ?? undefined
      // Plans the agent wrote live on disk and the harness never produced; index them while
      // somebody is looking at this folder's artifacts, which is when it is worth doing (H-14). The
      // same lazy pass indexes the documents the agent produced, including the ones it declared with
      // `artifact_write`, since those are written into the same folder.
      if (directory && (await roots.within(directory))) {
        try {
          registerPlans(repository, directory)
          registerDocuments(repository, directory)
        } catch {
          // An unreadable folder is not a reason to fail the list.
        }
      }
      // A page at a time (RP-03): `next` is where the following page starts, absent on the last one.
      const limit = Math.min(Math.max(Math.floor(Number(query.get("limit")) || ARTIFACT_PAGE), 1), MAX_ARTIFACT_PAGE)
      const offset = Math.max(Math.floor(Number(query.get("offset")) || 0), 0)
      const page = repository.listArtifacts(
        {
          directory,
          runID: query.get("runID") ?? undefined,
          kind: (query.get("kind") as ArtifactKind | null) ?? undefined,
          q: query.get("q") ?? undefined,
          offset,
        },
        limit + 1,
      )
      return json({ data: page.slice(0, limit), ...(page.length > limit ? { next: offset + limit } : {}) })
    }
    // Every version of a document, newest first and without their text: the viewer reads the one it
    // shows by its id (RP-03).
    if (path[1] === "artifacts" && request.method === "GET" && path[2] && path[3] === "versions" && path.length === 4) {
      const versions = repository.listArtifactVersions(path[2])
      if (versions.length === 0) return error("Artifact not found", 404)
      return json({ data: versions.map(({ content: _content, ...version }) => version) })
    }
    if (path[1] === "artifacts" && request.method === "POST" && !path[2]) {
      const input = artifactFrom(await readJSON(request))
      if (!input) return error("An artifact needs a kind, a title, and content or a path", 400)
      // One kept by its path is served from disk later, so its folder has to be a project now.
      if (input.path && !(input.directory && (await roots.within(input.directory)))) return notAProject()
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
    // One artifact's bytes as they are, for a viewer that draws rather than reads (H-14): an image,
    // a PDF, a page. Confined to the folder the artifact names, exactly like `files/read`.
    if (path[1] === "artifacts" && request.method === "GET" && path[2] && path[3] === "raw") {
      const artifact = repository.getArtifact(path[2])
      if (!artifact) return error("Artifact not found", 404)
      if (artifact.path && artifact.directory) {
        // A caller's own artifact names a folder of its choosing, so it is held to the projects; the
        // harness's own (a browser frame in its data folder) only to the folder it wrote (TI-11).
        if (artifact.producer === "user" && !(await roots.within(artifact.directory))) return notAProject()
        const full = confinedPath(artifact.directory, artifact.path)
        if (!full) return error("That path is outside the folder", 400)
        try {
          return new Response(readFileSync(full), {
            headers: {
              "content-type": artifact.mime,
              "content-disposition": "inline",
              "x-content-type-options": "nosniff",
              "access-control-expose-headers": "x-flupcode-artifact",
            },
          })
        } catch {
          return error("No such file", 404)
        }
      }
      if (artifact.content !== undefined) {
        const type = /^(text\/|application\/(json|xml))/.test(artifact.mime)
          ? `${artifact.mime}; charset=utf-8`
          : artifact.mime
        return new Response(artifact.content, { headers: { "content-type": type } })
      }
      return error("This artifact has nothing to show", 404)
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
    // One version, or with `?document=1` the whole document: every version of it (RP-03).
    if (path[1] === "artifacts" && request.method === "DELETE" && path[2] && !path[3]) {
      const document = new URL(request.url).searchParams.get("document") === "1"
      return repository.removeArtifact(path[2], { document }) ? json({ data: true }) : error("Artifact not found", 404)
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
    // The usage ledger read back (UL-05): the summary by any dimension, a session with its subagents
    // and a run, every figure with its basis. The UI's bearer, never the plugins'.
    const usage = handleUsageRead(request, path, repository)
    if (usage) return usage

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
        | {
            name?: unknown
            scope?: unknown
            fields?: unknown
            prompt?: unknown
            path?: unknown
            directory?: unknown
            project?: unknown
          }
        | undefined
      const name = typeof body?.name === "string" ? body.name.trim() : ""
      const scope = body?.scope === "global" ? "global" : "project"
      const fields = body?.fields && typeof body.fields === "object" && !Array.isArray(body.fields)
        ? (body.fields as Record<string, unknown>)
        : {}
      const prompt = typeof body?.prompt === "string" ? body.prompt : ""
      // An edit names the file it came from; a new agent has none and gets a path computed for it.
      const path = typeof body?.path === "string" && body.path ? body.path : undefined
      const directory = typeof body?.directory === "string" ? body.directory : undefined
      const project = typeof body?.project === "string" ? body.project : undefined
      try {
        const written = writeAgentFile({ name, scope, fields, prompt, ...(path ? { path } : {}) }, directory, project)
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

    // Config files you can look at and hand to your own config repository. The tools the engine
    // scans, the guards a delivery profile names, and the global config files: the listing mirrors
    // what the engine would actually load, and export copies a global one into the repository the
    // global config names — confined, previewed first, and never by running anything.
    if (path[1] === "config-files" && request.method === "GET" && !path[2]) {
      const params = new URL(request.url).searchParams
      return json({
        data: listConfigFiles({
          directory: params.get("directory") ?? undefined,
          project: params.get("project") ?? undefined,
        }),
      })
    }
    if (path[1] === "config-files" && path[2] === "read" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const wanted = params.get("path") ?? ""
      if (!wanted) return error("A path is required", 400)
      try {
        return json({
          data: readConfigFile(wanted, {
            directory: params.get("directory") ?? undefined,
            project: params.get("project") ?? undefined,
          }),
        })
      } catch (cause) {
        if (cause instanceof ConfigFileError) return error(cause.message, cause.status)
        throw cause
      }
    }
    if (path[1] === "config-files" && path[2] === "export" && request.method === "POST") {
      const body = (await readJSON(request)) as
        | { directory?: unknown; project?: unknown; paths?: unknown; confirm?: unknown }
        | undefined
      const paths = Array.isArray(body?.paths)
        ? body.paths.filter((entry): entry is string => typeof entry === "string" && !!entry)
        : []
      if (paths.length === 0) return error("Which config files to export is required", 400)
      try {
        return json({
          data: await exportConfigFiles({
            ...(typeof body?.directory === "string" ? { directory: body.directory } : {}),
            ...(typeof body?.project === "string" ? { project: body.project } : {}),
            paths,
            ...(body?.confirm === true ? { confirm: true } : {}),
          }),
        })
      } catch (cause) {
        if (cause instanceof ConfigFileError) return error(cause.message, cause.status)
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
      if (!(await roots.within(directory))) return notAProject()
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
      if (!(await roots.within(directory))) return notAProject()
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
      if (!(await roots.within(directory))) return notAProject()
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
      if (!(await roots.within(directory))) return notAProject()
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
      if (!(await roots.within(directory))) return notAProject()
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
          onSession: (sessionID) => repository.attributeSession(sessionID, { purpose: "commit-message", directory }),
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
      if (!(await roots.within(directory))) return notAProject()
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
      if (!(await roots.within(directory))) return notAProject()
      return json({ data: await branchState(directory) })
    }
    // Why a check failed. A network call per job, so it is asked for rather than polled with the
    // rest: the chip says how many failed, and this says what they printed.
    if (path[1] === "git" && path[2] === "pr" && path[3] === "log" && request.method === "GET") {
      const params = new URL(request.url).searchParams
      const directory = params.get("directory") ?? ""
      const job = params.get("job") ?? ""
      if (!directory) return error("A folder is required", 400)
      if (!(await roots.within(directory))) return notAProject()
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
      if (!(await roots.within(directory))) return notAProject()
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
      if (!(await roots.within(directory))) return notAProject()
      return json({ data: { branch: await currentBranch(directory) } })
    }

    // Workflows (H-21): the processes written down, and starting a run from one.
    if (path[1] === "workflows" && request.method === "GET" && !path[2]) {
      const directory = new URL(request.url).searchParams.get("directory") ?? undefined
      return json({ data: await listWorkflows(directory || undefined) })
    }
    // A workflow's runs (RP-01), for the Workflows screen: in one folder when it names one, since a
    // project's `feature` is not another project's.
    if (path[1] === "workflows" && request.method === "GET" && path[2] && path[3] === "runs") {
      const directory = new URL(request.url).searchParams.get("directory") || undefined
      return json({ data: repository.listWorkflowRuns(decodeURIComponent(path[2]), directory) })
    }
    // The file a past run executed, as it was then (RP-01).
    if (path[1] === "workflow-versions" && request.method === "GET" && path[2] && !path[3]) {
      const version = repository.getWorkflowVersion(path[2])
      return version ? json({ data: version }) : error("No workflow version with that hash", 404)
    }
    // One workflow, as it is written on disk, for the editor (H-28).
    if (path[1] === "workflows" && request.method === "GET" && path[2] && !path[3]) {
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
        | { inputs?: unknown; directory?: unknown; packs?: unknown; worktrees?: unknown; policy?: unknown; until?: unknown }
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
        })
        return json({ data: run }, 202)
      } catch (cause) {
        if (cause instanceof UnknownWorkflowError) return error(cause.message, 404)
        if (cause instanceof MissingInputsError) return error(cause.message, 400)
        if (cause instanceof UnknownTaskError) return error(cause.message, 400)
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
      // A schedule that cannot fire is refused here with its reason, not left to never run (RP-07).
      const scheduling = scheduleProblem(input.schedule)
      if (scheduling) return error(scheduling, 400)
      const problem = await routineWorkflowProblem(input)
      if (problem) return error(problem.message, problem.status)
      const actionProblem = routineActionProblem(input, options.actions)
      if (actionProblem) return error(actionProblem.message, actionProblem.status)
      return json({ data: repository.create(input, createOptionsFrom(body)), warnings: routineWarnings(input) }, 201)
    }
    if (!routineID) return error("Not found", 404)

    const routine = repository.get(routineID)
    if (!routine) return error("Routine not found", 404)

    if (action === "runs" && request.method === "GET") return json({ data: repository.listRuns({ type: "routine", routineID }) })
    if (action === "runs" && request.method === "POST" && !runID) {
      const body = (await readJSON(request)) as { inputs?: unknown } | undefined
      const overrides: Record<string, string> = {}
      if (body?.inputs && typeof body.inputs === "object" && !Array.isArray(body.inputs)) {
        for (const [name, value] of Object.entries(body.inputs as Record<string, unknown>)) {
          if (typeof value === "string") overrides[name] = value
        }
      }
      const problem = await routineWorkflowProblem(routine, overrides)
      if (problem) return error(problem.message, problem.status)
      try {
        return json({ data: await scheduler.runNow(routineID, overrides) }, 202)
      } catch (cause) {
        if (cause instanceof RoutineBusyError) return error(cause.message, 409)
        if (cause instanceof UnknownWorkflowError) return error(cause.message, 404)
        if (cause instanceof MissingInputsError) return error(cause.message, 400)
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
      // A schedule that cannot fire is refused here with its reason, not left to never run (RP-07).
      const scheduling = scheduleProblem(input.schedule)
      if (scheduling) return error(scheduling, 400)
      const problem = await routineWorkflowProblem(input)
      if (problem) return error(problem.message, problem.status)
      const actionProblem = routineActionProblem(input, options.actions)
      if (actionProblem) return error(actionProblem.message, actionProblem.status)
      return json({ data: repository.update(routineID, input), warnings: routineWarnings(input) })
    }
    if (request.method === "DELETE") {
      // Its run goes with it (TI-01): a run left going under a deleted routine keeps spending with
      // nothing in the list to stop it from.
      await Promise.all(
        repository
          .listRunning()
          .filter((run) => run.source.type === "routine" && run.source.routineID === routineID)
          .map((run) => scheduler.stopRun(run.id).catch(() => undefined)),
      )
      repository.remove(routineID)
      await dropAll(repository.removeStaleCheckpoints())
      return json({ data: true })
    }
    if (request.method === "GET") return json({ data: routine })
    return error("Not found", 404)
  }

  /**
   * Every answer passes through here so the origin is decided in one place: the handler no longer
   * sets `access-control-allow-origin` itself, and a response can never carry the blanket `*` it
   * used to (WA-9).
   */
  /**
   * `/harness/pair/*` (HE-01). A code is asked for by `flupcode` with the UI's token and no origin, so
   * no page can ask for one; a tab trades it once for a token bound to its origin, and refreshes that
   * token with the cookie the trade set. Every other route then checks the token and the origin.
   */
  const handlePairRequest = async (request: Request, path: string[], pairing: Pairing) => {
    const origin = request.headers.get("origin") ?? undefined
    const local = origin === undefined && !!options.token && tokenMatches(options.token, bearerFrom(request))
    if (path[2] === "codes" && path.length === 3 && request.method === "POST") {
      if (!local) return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return json({ data: pairing.issueCode() })
    }
    if (path[2] === "tabs" && path.length === 3 && request.method === "DELETE") {
      if (!local) return json({ error: "Forbidden", code: "invalid_token" }, 403)
      return json({ data: { revoked: pairing.revokeAll() } })
    }
    const page = origin !== undefined && (allowedHarnessOrigin(origin) || hostedWebOrigin(origin))
    if (path.length === 2 && request.method === "POST") {
      if (!page) return error("Pairing is for a FlupCode web page", 403)
      const body = (await request.json().catch(() => ({}))) as { code?: unknown }
      if (typeof body.code !== "string" || !body.code.trim()) return error("A code is required", 400)
      return paired(pairing.exchange(body.code, origin))
    }
    if (path[2] === "refresh" && path.length === 3 && request.method === "POST") {
      if (!page) return error("Pairing is for a FlupCode web page", 403)
      return paired(pairing.refresh(pairCookieFrom(request), origin))
    }
    return error("Not found", 404)
  }

  /**
   * Every answer passes through here so the origin is decided in one place: the handler no longer
   * sets `access-control-allow-origin` itself, and a response can never carry the blanket `*` it
   * used to (WA-9). The hosted web app reads pairing, the health check and the refusal that tells it
   * to pair; anything else only with a paired token (HE-01).
   */
  return async (request: Request) => {
    const path = splitPath(request)
    const pairRoute = path[0] === "harness" && path[1] === "pair"
    if (request.method === "OPTIONS")
      return applyHarnessCors(preflightResponse(), request, { origin: hostedCaller(request), credentials: pairRoute })
    const response = await handle(request)
    const readable =
      hostedCaller(request) &&
      (pairRoute ||
        (path[1] === "health" && request.method === "GET") ||
        pairedCaller(request) ||
        response.status === 403)
    return applyHarnessCors(response, request, { origin: readable, credentials: pairRoute })
  }
}

/** A pairing answer: the tab's token in the body, the refresh token in the cookie, or why not. */
function paired(result: PairingGrant | PairingRefusal) {
  if ("refused" in result) {
    if (result.refused === "rate_limited")
      return new Response(JSON.stringify({ error: "Too many wrong codes; wait a minute", code: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(result.retryAfter ?? 60) },
      })
    const response = json(
      result.refused === "invalid_code"
        ? { error: "That code is wrong, used or expired", code: "invalid_code" }
        : { error: "This tab is not paired with this computer", code: "not_paired" },
      403,
    )
    // A refresh token that no longer works is dropped, so the tab stops sending it.
    if (result.refused === "not_paired") response.headers.set("set-cookie", pairCookie("", 0))
    return response
  }
  const response = json({ data: { token: result.token, expiresAt: result.expiresAt } })
  response.headers.set("set-cookie", pairCookie(result.refresh, result.refreshExpiresAt))
  response.headers.set("cache-control", "no-store")
  return response
}
