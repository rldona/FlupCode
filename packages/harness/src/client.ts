import { createV2Domains, reachabilityUrl } from "./engine/v2"
import type { EngineClient } from "./engine/contract"
import { subscribeEvents } from "./event-stream"
import { readStorage, STORAGE_KEYS } from "./storage"
import { anonymousFetch, engineFetch, harnessBrowserToken } from "./transport"
import type {
  ActionCatalog,
  BrowserGrant,
  ActionPreview,
  ActionProfileFile,
  ActionProfileScope,
  Artifact,
  ArtifactKind,
  BranchState,
  CheckLog,
  Checkpoint,
  AgentFile,
  ContextReport,
  CapturedPrompt,
  ToolUses,
  SkillFile,
  CommandFile,
  ContextPack,
  ConfigFileEntry,
  ConfigFileExport,
  FileText,
  ProjectMemory,
  Finding,
  GitCommit,
  PullRequest,
  RestorePlan,
  ResumePlan,
  Routine,
  RoutineInput,
  RoutineRun,
  Run,
  RunPolicy,
  SelectorCapture,
  SessionPrefs,
  StashedPrompt,
  Task,
  TaskActivity,
  TaskTools,
  TouchedFiles,
  UsageDimension,
  UsageRunReport,
  UsageSessionReport,
  UsageSummary,
  SessionMetricTurn,
  Workflow,
  WorkflowFile,
  AdaptiveConfigView,
  AdaptiveModelKeyStatus,
  AdaptiveRuntimeAlert,
  DecisionExplanation,
  GuardrailStatus,
  SessionAdaptiveOverride,
  SessionTurnSummary,
  LearnedSkill,
  SkillProposal,
  StoredDecision,
  ValueGateSnapshot,
  StoredPlan,
} from "./types"

type RoutineCreateRequest = RoutineInput & Partial<Pick<Routine, "id" | "enabled" | "createdAt" | "lastRunAt" | "runs">>

const DEFAULT_SERVER_URL = "http://localhost:4096"

export function resolveServerUrl() {
  const configured = import.meta.env.VITE_OPENCODE_SERVER_URL
  if (typeof configured === "string" && configured.length > 0) return configured
  return DEFAULT_SERVER_URL
}

declare const __FLUPCODE_ENGINE_VERSION__: string | undefined

/**
 * The OpenCode 2 version this build is pinned to (ADR-0027), injected by Vite from the
 * `@opencode/client` pin. Undefined outside a Vite build (tests), where nothing is compared.
 */
export const engineTargetVersion =
  typeof __FLUPCODE_ENGINE_VERSION__ === "string" ? __FLUPCODE_ENGINE_VERSION__ : undefined

/** Why the engine is unreachable, as far as the browser can tell. */
export type ServerStatus = "online" | "offline" | "blocked" | "unauthorized"

/**
 * A request the browser blocks (CORS, mixed content, Local Network Access) rejects exactly like a
 * server that is not running, so `no-cors` tells them apart: it needs no permission to send, so an
 * opaque success means the engine is listening and something else withheld the response.
 *
 * A `401`/`403` resolves like any other response, so the engine reads as reachable; it is named
 * separately because the fix is neither starting a server nor allowing an origin, but the
 * credentials the browser has no way to send (see `transport.ts`).
 */
export async function probeServer(baseUrl: string): Promise<ServerStatus> {
  const health = reachabilityUrl(baseUrl)
  const response = await engineFetch(health, { signal: AbortSignal.timeout(2000) }).catch(() => undefined)
  if (response) {
    if (response.status === 401 || response.status === 403) return "unauthorized"
    void response.body?.cancel()
    return "online"
  }
  const listening = await engineFetch(health, { mode: "no-cors", signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  )
  return listening ? "blocked" : "offline"
}



export { EngineError, isSessionGone } from "./engine/error"
export type { EngineClient, HistoryImportStatus, InboxPrompt } from "./engine/contract"
export { subscribeEvents }

const clients = new Map<string, EngineClient>()

/**
 * The engine client the app talks through: the OpenCode 2 adapter. It is kept per address because it
 * remembers sign-ins in flight (the integration an OAuth attempt belongs to), which a fresh one would
 * lose.
 */
export function createClient(baseUrl = resolveServerUrl()): EngineClient {
  const key = baseUrl.replace(/\/+$/, "")
  const known = clients.get(key)
  if (known) return known
  // 2.x no longer writes its own config files, so they are saved through the harness server: the one
  // the reader configured, as every other harness call in the app uses.
  const client = createV2Domains(baseUrl, {
    configStore: createHarnessClient(readStorage(STORAGE_KEYS.harnessServerUrl, resolveHarnessServerUrl()))
      .engineConfig,
  })
  clients.set(key, client)
  return client
}

export function resolveHarnessServerUrl() {
  const configured = import.meta.env.VITE_FLUPCODE_HARNESS_SERVER_URL
  if (typeof configured === "string" && configured.length > 0) return configured
  return "http://localhost:4097"
}

/**
 * One JSON call to the harness. It carries the loopback bearer the desktop handed the renderer,
 * because with a token configured the server refuses every route but its health and a share link
 * without it (AH-A05). Without a token — a plain browser tab — the request goes out as it always did.
 */
async function harnessRequest<T>(baseUrl: string, path: string, init?: RequestInit) {
  const response = await anonymousFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: harnessHeaders(init),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { data?: T; error?: string; code?: string }
    | undefined
  if (!response.ok) throw new HarnessError(response.status, body)
  return body?.data as T
}

/**
 * The same request, keeping the warnings the server sent beside the data.
 *
 * A routine can be saved and still carry something the reader should know — an edit that is ignored
 * because an action drives the run, for instance (WA-7). Refusing it would be wrong; staying quiet
 * would be worse, so the notes travel with the answer.
 */
async function harnessRequestEnvelope<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ data: T; warnings: string[] }> {
  const response = await anonymousFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: harnessHeaders(init),
  })
  const body = (await response.json().catch(() => undefined)) as
    | { data?: T; error?: string; code?: string; warnings?: unknown }
    | undefined
  if (!response.ok) throw new HarnessError(response.status, body)
  const warnings = Array.isArray(body?.warnings)
    ? body.warnings.filter((entry): entry is string => typeof entry === "string")
    : []
  return { data: body?.data as T, warnings }
}

/**
 * A harness route that answered with an error, keeping its status and closed `code`. A `403
 * invalid_token` means this page has no loopback token to send, which reads very differently from a
 * server that failed (TI-14).
 */
export class HarnessError extends Error {
  readonly code?: string
  constructor(
    readonly status: number,
    body?: { error?: string; code?: string },
  ) {
    super(body?.error ?? `Harness request failed (${status})`)
    this.name = "HarnessError"
    this.code = body?.code
  }
}

/** The JSON content type and, when the desktop handed one over, the loopback bearer. */
function harnessHeaders(init?: RequestInit) {
  const token = harnessBrowserToken()
  return {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...init?.headers,
  }
}

/**
 * A call to the artifact surface (WA-9). It carries the loopback bearer the desktop handed the
 * renderer, so neither the listing nor the bytes of an image are readable by any page that happens
 * to reach the port. Without a token — a plain browser tab — the request goes out as it always did.
 */
async function harnessAuthorizedRequest(baseUrl: string, path: string, init?: RequestInit) {
  const token = harnessBrowserToken()
  return anonymousFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  })
}

/** The same call, unwrapped the way the harness answers every JSON route. */
async function harnessAuthorizedJson<T>(baseUrl: string, path: string, init?: RequestInit) {
  const response = await harnessAuthorizedRequest(baseUrl, path, init)
  const body = (await response.json().catch(() => undefined)) as
    | { data?: T; error?: string; code?: string }
    | undefined
  if (!response.ok) throw new HarnessError(response.status, body)
  return body?.data as T
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined

/**
 * A config write the server refused (FH-070).
 *
 * The `422` carries closed codes the panel turns into messages, and the fields it blames. Losing
 * them behind the message alone would leave the reader with "this change needs confirmation" and no
 * way to tell which control asked for it.
 */
export class AdaptiveConfigError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fields?: string[],
    readonly missing?: string[],
  ) {
    super(message)
    this.name = "AdaptiveConfigError"
  }
}

/** The same call as `harnessAuthorizedJson`, keeping the warnings a config write travels with. */
async function harnessAuthorizedEnvelope<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit,
): Promise<{ data: T; warnings: string[] }> {
  const response = await harnessAuthorizedRequest(baseUrl, path, init)
  const body = (await response.json().catch(() => undefined)) as
    | { data?: T; error?: string; code?: string; fields?: unknown; missing?: unknown; warnings?: unknown }
    | undefined
  if (!response.ok)
    throw new AdaptiveConfigError(
      body?.error ?? `Harness request failed (${response.status})`,
      body?.code ?? "unknown",
      stringList(body?.fields),
      stringList(body?.missing),
    )
  return { data: body?.data as T, warnings: stringList(body?.warnings) ?? [] }
}

/**
 * Which adaptive surfaces a server says it has (FH-070).
 *
 * The cockpit asks only for the routes `/harness/health` lists: an older sidecar without them is a
 * 404 in every console, and a panel that knows better leaves the toggle out instead.
 */
export type AdaptiveSurfaces = {
  config: boolean
  decisions: boolean
  plans: boolean
  proposals: boolean
  learnedSkills: boolean
  guardrails: boolean
  /** Approving and rejecting staged proposals (AH-A04); announced only when the writer's bearer exists. */
  review: boolean
  /** Disabling, enabling and archiving installed learned skills (AH-E04); the same bearer rule. */
  manageSkills: boolean
  /** The per-turn cost baseline (AH-B01) and its per-session summary (AH-B02). */
  metrics: boolean
  /** The value-of-information gate's status per kind (AH-C05). */
  voi: boolean
  /** Dismissing the runtime probe's change alerts (AH-D05); announced only with the writer's bearer. */
  runtimeAlerts: boolean
  /** The per-session override and turn summary behind the composer's chip (AH-E02); writer's bearer only. */
  session: boolean
  /** Saving and removing the predictive model's key; announced only with the writer's bearer. */
  modelKey: boolean
}

export function adaptiveSurfaces(capabilities: readonly string[]): AdaptiveSurfaces {
  return {
    config: capabilities.includes("adaptive-config"),
    decisions: capabilities.includes("adaptive-decisions"),
    plans: capabilities.includes("adaptive-context"),
    proposals: capabilities.includes("adaptive-proposals"),
    learnedSkills: capabilities.includes("adaptive-skills"),
    guardrails: capabilities.includes("adaptive-guardrails"),
    review: capabilities.includes("adaptive-proposals-review"),
    manageSkills: capabilities.includes("adaptive-skills-manage"),
    metrics: capabilities.includes("adaptive-metrics"),
    voi: capabilities.includes("adaptive-voi"),
    runtimeAlerts: capabilities.includes("adaptive-runtime-alerts"),
    session: capabilities.includes("adaptive-session"),
    modelKey: capabilities.includes("adaptive-model-key"),
  }
}

/** What the live view watches (WA-6): the status a session's browser run is in. */
export type AgentBrowserSession = {
  id: string
  project: string
  headed: boolean
  paused: boolean
  stopped: boolean
  url: string
  title: string
  /** The page's current viewport, so the panel knows whether its own size was applied. */
  viewport?: { width: number; height: number }
}

/**
 * One browser call: the loopback bearer and the session header the routes compare. Without the
 * desktop's token the call is refused, and the live view only watches.
 */
async function agentBrowserRequest<T>(baseUrl: string, sessionID: string, path: string, init?: RequestInit) {
  const token = harnessBrowserToken()
  const response = await anonymousFetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "x-flupcode-session": sessionID,
      ...init?.headers,
    },
  })
  const body = (await response.json().catch(() => undefined)) as
    | { data?: T; error?: string; code?: string }
    | undefined
  if (!response.ok) throw new HarnessError(response.status, body)
  return body?.data as T
}

export function createHarnessClient(baseUrl = resolveHarnessServerUrl()) {
  return {
    /**
     * The one harness route answered bare, `{ healthy, capabilities }`, not inside `data`: the desktop
     * main process reads it that way too. Reading only `data` left every capability unannounced.
     */
    health: async () => {
      const response = await anonymousFetch(`${baseUrl.replace(/\/$/, "")}/harness/health`)
      if (!response.ok) throw new Error(`Harness request failed (${response.status})`)
      const body = (await response.json()) as
        | { healthy?: boolean; capabilities?: string[]; data?: { healthy?: boolean; capabilities?: string[] } }
        | undefined
      const health = body?.data ?? body
      return { healthy: health?.healthy ?? true, capabilities: health?.capabilities }
    },
    /**
     * What the server changed, as it changes it. A different origin from the engine, so the
     * connection it holds does not come out of the handful the browser allows for talking to it.
     *
     * No cursor is sent on purpose: every connection re-reads the lists first, so the server's
     * backlog would only describe runs and routines that have since been deleted.
     */
    events: (options?: { signal?: AbortSignal }) => {
      // The stream carries prompts and outputs, so it presents the loopback bearer like every
      // other sensitive surface; without one (a plain browser tab) the server answers as before.
      const token = harnessBrowserToken()
      return subscribeEvents(baseUrl, options?.signal, "/harness/events", undefined, true, {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      })
    },
    runs: {
      list: () => harnessAuthorizedJson<Run[]>(baseUrl, "/harness/runs"),
      /**
       * The same task once per model (H-44), one run each, so the comparison reads runs as it always
       * has. Answers with them in the order they were asked for.
       */
      bestOfN: (input: {
        prompt: string
        models: string[]
        directory?: string
        packs?: string[]
        worktrees?: boolean
        policy?: RunPolicy
      }) =>
        harnessRequest<Run[]>(baseUrl, "/harness/best-of-n", { method: "POST", body: JSON.stringify(input) }),
      /** A run with the tasks it is made of; the list leaves them out. */
      get: (id: string) => harnessAuthorizedJson<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}`),
      /**
       * Pick up a run that failed, was stopped or lost its process (HF-5, RP-04): from a task, or from
       * where it broke. Only what had not succeeded runs, after the folder is put back.
       */
      resume: (id: string, input: { fromTask?: string } = {}) =>
        harnessAuthorizedJson<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/resume`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** What resuming would do, before it does it: what runs, and what restoring the folder writes and deletes. */
      resumePlan: (id: string, fromTask?: string) =>
        harnessAuthorizedJson<ResumePlan>(
          baseUrl,
          `/harness/runs/${encodeURIComponent(id)}/resume${fromTask ? `?fromTask=${encodeURIComponent(fromTask)}` : ""}`,
        ),
      tasks: (id: string) => harnessAuthorizedJson<Task[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/tasks`),
      /** What its running tasks are doing right now. Polled while somebody watches, never stored. */
      activity: (id: string) =>
        harnessAuthorizedJson<TaskActivity[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/activity`),
      /** What each task changed on disk, from the checkpoints taken around it. */
      files: (id: string) => harnessAuthorizedJson<TouchedFiles[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/files`),
      /** What each task spent its time on, from the tool calls the engine plugin timed (H-16). */
      tools: (id: string) => harnessAuthorizedJson<TaskTools[]>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/tools`),
      /** Do a task again as a new task of the same run, optionally on another model (H-12). */
      retry: (taskID: string, input: { model?: Task["model"] } = {}) =>
        harnessRequest<Task>(baseUrl, `/harness/tasks/${encodeURIComponent(taskID)}/retry`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** Take a queued task off the run; running work is stopped with the run (HF-4). */
      cancelTask: (taskID: string) =>
        harnessRequest<Task>(baseUrl, `/harness/tasks/${encodeURIComponent(taskID)}/cancel`, { method: "POST" }),
      /** Merge the worktrees this run's tasks wrote in, back into its folder (H-29). */
      mergeWorktrees: (id: string) =>
        harnessAuthorizedJson<{ merged: Array<{ taskID: string; branch: string; sha: string }> }>(
          baseUrl,
          `/harness/runs/${encodeURIComponent(id)}/worktrees/merge`,
          { method: "POST" },
        ),
      /** Remove the worktrees this run's tasks wrote in (H-29). */
      cleanupWorktrees: (id: string) =>
        harnessAuthorizedJson<{ removed: string[] }>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/worktrees/cleanup`, {
          method: "POST",
        }),
      /** Ask the server to interrupt what the run is doing; it finishes as stopped. */
      stop: (id: string) => harnessAuthorizedJson<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/stop`, { method: "POST" }),
      /** Let a run through the gate it stopped at. Refusing it is stopping it. */
      approve: (id: string) => harnessAuthorizedJson<Run>(baseUrl, `/harness/runs/${encodeURIComponent(id)}/approve`, { method: "POST" }),
      /** Interrupt every run still going. */
      stopAll: () => harnessAuthorizedJson<{ stopped: number }>(baseUrl, "/harness/runs/stop", { method: "POST" }),
      /** Forget every run that has finished. Running ones stay. */
      clear: () => harnessAuthorizedJson<{ removed: number }>(baseUrl, "/harness/runs", { method: "DELETE" }),
      /** Forget a run and its tasks. The server refuses while it is still going. */
      remove: (id: string) => harnessAuthorizedJson<boolean>(baseUrl, `/harness/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    artifacts: {
      list: (filter: { directory?: string; runID?: string; kind?: ArtifactKind; q?: string } = {}) => {
        const query = new URLSearchParams()
        for (const [name, value] of Object.entries(filter)) if (value) query.set(name, value)
        const search = query.toString()
        return harnessAuthorizedJson<Artifact[]>(baseUrl, `/harness/artifacts${search ? `?${search}` : ""}`)
      },
      /**
       * One page of a folder's documents, one row each (RP-03), and where the next page starts. No
       * `next` means this was the last page.
       */
      page: async (filter: { directory?: string; offset?: number } = {}) => {
        const query = new URLSearchParams()
        if (filter.directory) query.set("directory", filter.directory)
        if (filter.offset) query.set("offset", String(filter.offset))
        const search = query.toString()
        const response = await harnessAuthorizedRequest(baseUrl, `/harness/artifacts${search ? `?${search}` : ""}`)
        const body = (await response.json().catch(() => undefined)) as
          | { data?: Artifact[]; next?: number; error?: string; code?: string }
          | undefined
        if (!response.ok) throw new HarnessError(response.status, body)
        return { data: body?.data, next: typeof body?.next === "number" ? body.next : undefined }
      },
      get: (id: string) => harnessAuthorizedJson<Artifact>(baseUrl, `/harness/artifacts/${encodeURIComponent(id)}`),
      /** Every version of the document an artifact belongs to, newest first, without their text (RP-03). */
      versions: (id: string) =>
        harnessAuthorizedJson<Artifact[]>(baseUrl, `/harness/artifacts/${encodeURIComponent(id)}/versions`),
      /** Keep one in front, or say when it may be forgotten (H-14). `expiresAt` null clears it. */
      update: (id: string, input: { pinned?: boolean; expiresAt?: number | null }) =>
        harnessAuthorizedJson<Artifact>(baseUrl, `/harness/artifacts/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      /**
       * The bytes as they are, for a viewer that draws rather than reads (H-14), as a blob URL the
       * caller revokes when its viewer goes away. A blob keeps the bearer out of the `<img>` and off
       * the page's own HTML surface.
       */
      raw: async (id: string) => {
        const response = await harnessAuthorizedRequest(baseUrl, `/harness/artifacts/${encodeURIComponent(id)}/raw`)
        if (!response.ok) throw new Error(`Harness request failed (${response.status})`)
        return URL.createObjectURL(await response.blob())
      },
      /** Forgets a document: every version of it (RP-03). */
      remove: (id: string) =>
        harnessAuthorizedJson<boolean>(baseUrl, `/harness/artifacts/${encodeURIComponent(id)}?document=1`, {
          method: "DELETE",
        }),
    },
    /**
     * The live view and its takeover (WA-6). Every call carries the session the window belongs to;
     * the frame is the latest PNG as a blob, with the stored artifact id when one was announced.
     */
    agentBrowser: {
      session: (sessionID: string) => agentBrowserRequest<AgentBrowserSession>(baseUrl, sessionID, "/harness/browser/session"),
      pause: (sessionID: string) =>
        agentBrowserRequest<AgentBrowserSession>(baseUrl, sessionID, "/harness/browser/pause", { method: "POST" }),
      resume: (sessionID: string) =>
        agentBrowserRequest<AgentBrowserSession>(baseUrl, sessionID, "/harness/browser/resume", { method: "POST" }),
      takeOver: (sessionID: string) =>
        agentBrowserRequest<AgentBrowserSession>(baseUrl, sessionID, "/harness/browser/takeover", { method: "POST" }),
      /** Resizes the headless page to the panel the live view measured (WA-6). */
      setViewport: (sessionID: string, viewport: { width: number; height: number }) =>
        agentBrowserRequest<AgentBrowserSession>(baseUrl, sessionID, "/harness/browser/viewport", {
          method: "POST",
          body: JSON.stringify(viewport),
        }),
      stop: (sessionID: string) =>
        agentBrowserRequest<{ stopped: boolean }>(baseUrl, sessionID, "/harness/browser/stop", { method: "POST" }),
      /** What is at a point the reader clicked in the live frame, a 0..1 fraction of it (WA-8). */
      pick: (sessionID: string, point: { x: number; y: number }) =>
        agentBrowserRequest<SelectorCapture>(baseUrl, sessionID, "/harness/browser/capture", {
          method: "POST",
          body: JSON.stringify(point),
        }),
      /**
       * The latest frame as a PNG. `store: false` asks the server not to file it as an artifact,
       * which is what a polling viewer wants: a PNG per tick would grow the disk for nobody (WA-6,
       * WA-8). The default still stores one for a caller that asked for the frame itself.
       */
      frame: async (sessionID: string, options?: { store?: boolean }) => {
        const token = harnessBrowserToken()
        const query = options?.store === false ? "?store=0" : ""
        const response = await anonymousFetch(`${baseUrl.replace(/\/$/, "")}/harness/browser/frame${query}`, {
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "x-flupcode-session": sessionID,
          },
        })
        if (!response.ok) throw new Error(`Harness request failed (${response.status})`)
        return {
          blob: await response.blob(),
          artifactId: response.headers.get("x-flupcode-artifact") ?? undefined,
        }
      },
    },
    // The browser policy's standing grants (BU-01): listed and revoked from the settings.
    browserPolicy: {
      grants: () => harnessAuthorizedJson<BrowserGrant[]>(baseUrl, "/harness/browser-policy/grants"),
      revoke: (id: string) =>
        harnessAuthorizedJson<{ revoked: boolean }>(baseUrl, `/harness/browser-policy/grants/${encodeURIComponent(id)}`, {
          method: "DELETE",
        }),
    },
    // What a reader keeps about a session (H-18). On the server, so it travels to the phone.
    sessionPrefs: {
      list: () => harnessRequest<SessionPrefs[]>(baseUrl, "/harness/session-prefs"),
      update: (sessionID: string, input: { pinned?: boolean; tags?: string[] }) =>
        harnessRequest<SessionPrefs>(baseUrl, `/harness/session-prefs/${encodeURIComponent(sessionID)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
    },
    // Prompts set aside, on the server so any device sees them (H-18).
    stash: {
      list: () => harnessRequest<StashedPrompt[]>(baseUrl, "/harness/stash"),
      add: (text: string) =>
        harnessRequest<StashedPrompt>(baseUrl, "/harness/stash", { method: "POST", body: JSON.stringify({ text }) }),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/stash/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    /** Context packs (H-26): named sets of references the composer can pull back into a prompt. */
    packs: {
      list: (directory?: string) =>
        harnessRequest<ContextPack[]>(
          baseUrl,
          directory ? `/harness/packs?directory=${encodeURIComponent(directory)}` : "/harness/packs",
        ),
      save: (input: { name: string; refs: string[]; directory?: string }) =>
        harnessRequest<ContextPack>(baseUrl, "/harness/packs", { method: "POST", body: JSON.stringify(input) }),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/packs/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    /** One file's text to look at (H-19), confined to the folder and capped by the server. */
    files: {
      read: (input: { directory: string; path: string }) => {
        const search = new URLSearchParams({ directory: input.directory, path: input.path })
        return harnessRequest<FileText>(baseUrl, `/harness/files/read?${search}`)
      },
    },
    /** A conversation kept on this server so it can be read at a link (H-35). */
    shares: {
      create: (input: { title: string; markdown: string }) =>
        harnessRequest<{ id: string; title: string; url: string }>(baseUrl, "/harness/shares", {
          method: "POST",
          body: JSON.stringify(input),
        }),
    },
    /** A project's notes, kept here and handed to every turn (H-37). */
    memory: {
      list: (directory: string) =>
        harnessRequest<ProjectMemory[]>(baseUrl, `/harness/memory?directory=${encodeURIComponent(directory)}`),
      add: (input: { directory: string; text: string }) =>
        harnessRequest<ProjectMemory>(baseUrl, "/harness/memory", { method: "POST", body: JSON.stringify(input) }),
      remove: (id: string) => harnessRequest<boolean>(baseUrl, `/harness/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    workflows: {
      /** What this project can run. A project's own win over the ones shared across projects. */
      list: (directory?: string) =>
        harnessRequest<Workflow[]>(
          baseUrl,
          directory ? `/harness/workflows?directory=${encodeURIComponent(directory)}` : "/harness/workflows",
        ),
      run: (name: string, input: { inputs?: Record<string, string>; directory?: string; packs?: string[]; worktrees?: boolean; policy?: unknown; until?: string }) =>
        harnessRequest<Run>(baseUrl, `/harness/workflows/${encodeURIComponent(name)}/runs`, {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** A workflow's runs, newest first (RP-01); in this folder when it names one. */
      runs: (name: string, directory?: string) =>
        harnessRequest<Run[]>(
          baseUrl,
          `/harness/workflows/${encodeURIComponent(name)}/runs${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
        ),
      /** The file as written, for the editor (H-28). */
      get: (name: string, directory?: string) =>
        harnessRequest<WorkflowFile>(
          baseUrl,
          `/harness/workflows/${encodeURIComponent(name)}${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
        ),
      /** Writes it back, validated by the server: what would not run cannot be saved as a workflow. */
      save: (name: string, input: { source: string; directory?: string; scope?: "project" | "global" }) =>
        harnessRequest<WorkflowFile>(baseUrl, `/harness/workflows/${encodeURIComponent(name)}`, {
          method: "PUT",
          body: JSON.stringify(input),
        }),
      remove: (name: string, directory?: string) =>
        harnessRequest<boolean>(
          baseUrl,
          `/harness/workflows/${encodeURIComponent(name)}${directory ? `?directory=${encodeURIComponent(directory)}` : ""}`,
          { method: "DELETE" },
        ),
    },
    /**
     * Git (H-20), which only the harness server can run.
     *
     * The engine's `/vcs` routes read the working tree and never write to it, and a browser cannot
     * run anything. Before this, committing meant asking a model to do it — a whole turn, paid for,
     * to run two commands.
     */
    git: {
      commit: (input: { directory: string; message: string; paths: string[]; hunks?: Record<string, number[]> }) =>
        harnessRequest<GitCommit>(baseUrl, "/harness/git/commit", { method: "POST", body: JSON.stringify(input) }),
      /** Throws away a change, or the named hunks of one (H-20). */
      discard: (input: { directory: string; path: string; hunks?: number[] }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/git/discard", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** A commit message for the picked change, written by the engine (H-20). */
      message: (input: { directory: string; paths: string[]; hunks?: Record<string, number[]> }) =>
        harnessRequest<{ message: string }>(baseUrl, "/harness/git/message", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      branch: (input: { directory: string; name: string }) =>
        harnessRequest<{ branch: string }>(baseUrl, "/harness/git/branch", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      /** Where the branch stands on GitHub. One `gh` call behind it, so poll it, do not spam it. */
      state: (directory: string) =>
        harnessRequest<BranchState>(baseUrl, `/harness/git/pr?directory=${encodeURIComponent(directory)}`),
      /**
       * What one failing check printed. Asked for rather than polled: it is a network call per job.
       */
      checkLog: (directory: string, job: string) =>
        harnessRequest<CheckLog>(
          baseUrl,
          `/harness/git/pr/log?directory=${encodeURIComponent(directory)}&job=${encodeURIComponent(job)}`,
        ),
      /** Pushes the branch if it has never been pushed, then opens the pull request. */
      openPullRequest: (input: { directory: string; title: string; body?: string; base?: string }) =>
        harnessRequest<PullRequest>(baseUrl, "/harness/git/pr", { method: "POST", body: JSON.stringify(input) }),
    },
    /**
     * What the model was given (H-17).
     *
     * Read from disk by the engine's own rules, because the engine reports the agent's blurb and
     * not the prompt it actually assembles.
     */
    context: {
      get: (input: { directory: string; project?: string }) => {
        const search = new URLSearchParams({ directory: input.directory })
        if (input.project) search.set("project", input.project)
        return harnessRequest<ContextReport>(baseUrl, `/harness/context?${search}`)
      },
      file: (input: { directory: string; path: string; project?: string }) => {
        const search = new URLSearchParams({ directory: input.directory, path: input.path })
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ content: string }>(baseUrl, `/harness/context/file?${search}`)
      },
      /**
       * The system prompt the engine assembled, which no engine endpoint reports: FlupCode's engine
       * plugin records it as the request goes out. A session has more than one recording — the turn,
       * its title, a compaction — so this is a list, newest first.
       */
      systemPrompt: (input: { sessionID: string }) =>
        harnessRequest<CapturedPrompt[]>(
          baseUrl,
          `/harness/context/system-prompt?${new URLSearchParams({ sessionID: input.sessionID })}`,
        ),
      /** What tools this session ran, which is as much as the engine can tell about MCP servers: it
       *  reports no list of what one offers. */
      toolUses: (input: { sessionID: string }) =>
        harnessRequest<ToolUses>(baseUrl, `/harness/context/tool-uses?${new URLSearchParams({ sessionID: input.sessionID })}`),
    },
    /** Agents you can edit (H-13): the markdown files behind the agents the engine reports. */
    agents: {
      list: (input: { directory?: string; project?: string }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<AgentFile[]>(baseUrl, `/harness/agents${search.size ? `?${search}` : ""}`)
      },
      save: (input: {
        name: string
        scope: "global" | "project"
        fields: Record<string, unknown>
        prompt: string
        /** The file being edited, so an edit writes back to it instead of a new one. */
        path?: string
        directory?: string
        project?: string
      }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/agents", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      remove: (input: { path: string; directory?: string; project?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ removed: boolean }>(baseUrl, `/harness/agents?${search}`, { method: "DELETE" })
      },
    },
    /** Skills (H-27): what is on disk, and what the engine would not load, and why. */
    skills: {
      list: (input: { directory?: string; project?: string }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<SkillFile[]>(baseUrl, `/harness/skills${search.size ? `?${search}` : ""}`)
      },
      file: (input: { path: string; directory?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        return harnessRequest<{ content: string }>(baseUrl, `/harness/skills/file?${search}`)
      },
      save: (input: { name: string; scope: "global" | "project"; description: string; body: string; directory?: string }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/skills", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      remove: (input: { path: string; directory?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        return harnessRequest<{ removed: boolean }>(baseUrl, `/harness/skills?${search}`, { method: "DELETE" })
      },
    },
    /** Commands you can edit (H-25): the markdown files behind the engine's slash commands. */
    commands: {
      list: (input: { directory?: string; project?: string }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<CommandFile[]>(baseUrl, `/harness/commands${search.size ? `?${search}` : ""}`)
      },
      save: (input: {
        name: string
        scope: "global" | "project"
        fields: Record<string, unknown>
        template: string
        directory?: string
        project?: string
      }) =>
        harnessRequest<{ path: string }>(baseUrl, "/harness/commands", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      remove: (input: { path: string; directory?: string; project?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ removed: boolean }>(baseUrl, `/harness/commands?${search}`, { method: "DELETE" })
      },
    },
    /**
     * The rest of the engine's configuration: the tool modules it scans, the guards a delivery
     * profile names, and the global config files. Export copies the chosen global ones into the
     * repository the global config names, previewed first and never by running anything.
     */
    configFiles: {
      list: (input: { directory?: string; project?: string } = {}) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<ConfigFileEntry[]>(baseUrl, `/harness/config-files${search.size ? `?${search}` : ""}`)
      },
      read: (input: { path: string; directory?: string; project?: string }) => {
        const search = new URLSearchParams({ path: input.path })
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ path: string; text: string }>(baseUrl, `/harness/config-files/read?${search}`)
      },
      /** `confirm` omitted or false only plans: nothing is written until it is true. */
      export: (input: { directory?: string; project?: string; paths: string[]; confirm?: boolean }) =>
        harnessRequest<ConfigFileExport>(baseUrl, "/harness/config-files/export", {
          method: "POST",
          body: JSON.stringify(input),
        }),
    },
    /**
     * The engine's own config files, in the 1.x shape both engine lines load (V2-24). OpenCode 2 does
     * not write its config, so its adapter reads and patches it here (`EngineConfigStore`).
     */
    engineConfig: {
      read: (scope: "global" | "project", directory?: string) => {
        const search = new URLSearchParams({ scope })
        if (directory) search.set("directory", directory)
        return harnessRequest<{ path: string; config: Record<string, unknown> }>(
          baseUrl,
          `/harness/engine-config?${search}`,
        )
      },
      patch: (scope: "global" | "project", patch: Record<string, unknown>, directory?: string) =>
        harnessRequest<{ path: string; changed: boolean }>(baseUrl, "/harness/engine-config", {
          method: "PATCH",
          body: JSON.stringify({ scope, patch, ...(directory ? { directory } : {}) }),
        }),
    },
    /** Findings (H-32): a review's points, anchored to a file and a line. */
    findings: {
      list: (input: { directory?: string; runID?: string; open?: boolean }) => {
        const search = new URLSearchParams()
        if (input.directory) search.set("directory", input.directory)
        if (input.runID) search.set("runID", input.runID)
        if (input.open) search.set("open", "1")
        return harnessRequest<Finding[]>(baseUrl, `/harness/findings${search.size ? `?${search}` : ""}`)
      },
      resolve: (id: string, resolved: boolean) =>
        harnessRequest<Finding>(baseUrl, `/harness/findings/${encodeURIComponent(id)}/resolved`, {
          method: "PATCH",
          body: JSON.stringify({ resolved }),
        }),
    },
    /**
     * The usage ledger added up (UL-05): the total for a period and a folder, grouped by one
     * dimension. `from` and `to` are milliseconds, `[from, to)`.
     */
    usageSummary: (
      input: { groupBy?: UsageDimension; tag?: string; from?: number; to?: number; directory?: string; limit?: number } = {},
    ) => {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(input)) if (value !== undefined && value !== "") search.set(key, String(value))
      return harnessRequest<UsageSummary>(baseUrl, `/harness/usage/summary${search.size ? `?${search}` : ""}`)
    },
    /**
     * A session's cost with every subagent under it (UL-05); with `from`, also what the tree spent
     * since then (`since`), which is how the composer reads the turn in progress (UL-06).
     */
    sessionUsage: (sessionID: string, input: { from?: number } = {}) =>
      harnessRequest<UsageSessionReport>(
        baseUrl,
        `/harness/usage/sessions/${encodeURIComponent(sessionID)}${input.from !== undefined ? `?from=${input.from}` : ""}`,
      ),
    /** A run's cost by task, purpose, agent and model (UL-05). */
    runUsage: (runID: string) =>
      harnessRequest<UsageRunReport>(baseUrl, `/harness/usage/runs/${encodeURIComponent(runID)}`),
    /**
     * Checkpoints (H-15): a way back from what a run did.
     *
     * `plan` before `restore`, always. Restoring overwrites files and deletes others, and nothing
     * here does that without saying which ones first.
     */
    checkpoints: {
      list: (directory: string) =>
        harnessRequest<Checkpoint[]>(baseUrl, `/harness/checkpoints?directory=${encodeURIComponent(directory)}`),
      take: (input: { directory: string; title: string }) =>
        harnessRequest<Checkpoint>(baseUrl, "/harness/checkpoints", { method: "POST", body: JSON.stringify(input) }),
      plan: (id: string) => harnessRequest<RestorePlan>(baseUrl, `/harness/checkpoints/${encodeURIComponent(id)}/plan`),
      restore: (id: string) =>
        harnessRequest<{ plan: RestorePlan; safety: Checkpoint }>(
          baseUrl,
          `/harness/checkpoints/${encodeURIComponent(id)}/restore`,
          { method: "POST" },
        ),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/checkpoints/${encodeURIComponent(id)}`, { method: "DELETE" }),
    },
    routines: {
      list: () => harnessRequest<Routine[]>(baseUrl, "/harness/routines"),
      get: (id: string) => harnessRequest<Routine>(baseUrl, `/harness/routines/${encodeURIComponent(id)}`),
      create: (input: RoutineCreateRequest) =>
        harnessRequestEnvelope<Routine>(baseUrl, "/harness/routines", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      update: (id: string, input: RoutineInput) =>
        harnessRequestEnvelope<Routine>(baseUrl, `/harness/routines/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(input),
        }),
      setEnabled: (id: string, enabled: boolean) =>
        harnessRequest<Routine>(baseUrl, `/harness/routines/${encodeURIComponent(id)}/enabled`, {
          method: "PATCH",
          body: JSON.stringify({ enabled }),
        }),
      remove: (id: string) =>
        harnessRequest<boolean>(baseUrl, `/harness/routines/${encodeURIComponent(id)}`, { method: "DELETE" }),
      run: (id: string, inputs?: Record<string, string>) =>
        harnessRequest<RoutineRun>(baseUrl, `/harness/routines/${encodeURIComponent(id)}/runs`, {
          method: "POST",
          ...(inputs ? { body: JSON.stringify({ inputs }) } : {}),
        }),
      stop: (id: string, runID: string) =>
        harnessRequest<RoutineRun | undefined>(
          baseUrl,
          `/harness/routines/${encodeURIComponent(id)}/runs/${encodeURIComponent(runID)}/stop`,
          { method: "POST" },
        ),
    },
    /**
     * The web actions this server knows (WA-7). The routine editor lists them, and the chosen
     * profile decides which inputs to ask for and what consent the routine must carry. The Actions
     * editor (WA-8) writes them: `list` is scope-aware when a folder is given, and `save`/`remove`
     * edit `flupcode.actions[id]` in the config file the server derives.
     */
    actions: {
      /** No folder is the plugin's own catalogue: the global config alone (WA-2, WA-7). */
      list: (input: { directory?: string; project?: string } = {}) =>
        harnessRequest<ActionCatalog>(baseUrl, `/harness/actions${actionQuery(input)}`),
      /** The same catalogue, named for the editor that shows the scope of each profile (WA-8). */
      profiles: (input: { directory?: string; project?: string } = {}) =>
        harnessRequest<ActionCatalog>(baseUrl, `/harness/actions${actionQuery(input)}`),
      /** Where each profile is written, for the editor's scope badges (WA-8). */
      files: (input: { directory?: string; project?: string } = {}) =>
        harnessRequest<ActionProfileFile[]>(baseUrl, `/harness/action-profiles${actionQuery(input)}`),
      /** The schema check behind the editor's inline error (WA-8). */
      validate: (input: { id: string; profile: unknown }) =>
        harnessRequest<{ ok: true }>(baseUrl, "/harness/actions/validate", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      save: (input: {
        id: string
        scope: ActionProfileScope
        profile: unknown
        directory?: string
        project?: string
      }) =>
        harnessRequest<{ path: string; scope: ActionProfileScope; id: string }>(
          baseUrl,
          `/harness/action-profiles/${encodeURIComponent(input.id)}`,
          {
            method: "PUT",
            body: JSON.stringify({
              scope: input.scope,
              profile: input.profile,
              ...(input.directory ? { directory: input.directory } : {}),
              ...(input.project ? { project: input.project } : {}),
            }),
          },
        ),
      remove: (input: { id: string; scope: ActionProfileScope; directory?: string; project?: string }) => {
        const search = new URLSearchParams({ scope: input.scope })
        if (input.directory) search.set("directory", input.directory)
        if (input.project) search.set("project", input.project)
        return harnessRequest<{ removed: boolean; path: string }>(
          baseUrl,
          `/harness/action-profiles/${encodeURIComponent(input.id)}?${search}`,
          { method: "DELETE" },
        )
      },
      /** Plan a saved profile's steps without opening a browser (WA-8). */
      dryRun: (input: { action: string; inputs?: Record<string, unknown>; sessionID?: string; project?: string }) =>
        harnessRequest<unknown>(baseUrl, "/harness/actions/run", {
          method: "POST",
          body: JSON.stringify({
            action: input.action,
            inputs: input.inputs ?? {},
            sessionID: input.sessionID ?? "editor",
            project: input.project ?? "editor",
            dryRun: true,
          }),
        }),
      /** Run the read part of a recipe for real and stop before the first side effect (WA-8). */
      preview: (input: {
        action?: string
        profile?: unknown
        directory?: string
        project: string
        sessionID: string
        headed?: boolean
      }) =>
        harnessRequest<ActionPreview>(baseUrl, "/harness/actions/run", {
          method: "POST",
          body: JSON.stringify({
            ...(input.action ? { action: input.action } : {}),
            ...(input.profile !== undefined ? { profile: input.profile } : {}),
            ...(input.directory ? { directory: input.directory } : {}),
            project: input.project,
            sessionID: input.sessionID,
            ...(input.headed === true ? { headed: true } : {}),
            preview: true,
          }),
        }),
    },
    /**
     * The adaptive surfaces (FH-070/071/072/073): the settings writer and the read audits behind it.
     *
     * They carry the loopback bearer like the artifacts, because what a session was observed doing is
     * as sensitive as what a run left behind. The client does not decide which of them exist — the
     * cockpit's `adaptiveSurfaces(capabilities)` does — so an older server is never asked for a route
     * it does not have.
     */
    adaptive: {
      config: {
        get: () => harnessAuthorizedJson<AdaptiveConfigView>(baseUrl, "/harness/adaptive/config"),
        patch: (input: { patch: Record<string, unknown>; confirm?: boolean }) =>
          harnessAuthorizedEnvelope<AdaptiveConfigView>(baseUrl, "/harness/adaptive/config", {
            method: "PATCH",
            body: JSON.stringify({ patch: input.patch, confirm: input.confirm === true }),
          }),
      },
      /**
       * The predictive model's key: written, removed, never read back. Both writes are sent only
       * after a person confirmed them, so `confirm` travels with them.
       */
      modelKey: {
        set: (key: string) =>
          harnessAuthorizedEnvelope<AdaptiveModelKeyStatus>(baseUrl, "/harness/adaptive/model-key", {
            method: "PUT",
            body: JSON.stringify({ key, confirm: true }),
          }),
        remove: () =>
          harnessAuthorizedEnvelope<AdaptiveModelKeyStatus>(baseUrl, "/harness/adaptive/model-key", {
            method: "DELETE",
            body: JSON.stringify({ confirm: true }),
          }),
      },
      runtime: {
        acknowledge: () =>
          harnessAuthorizedJson<{ alerts: AdaptiveRuntimeAlert[] }>(baseUrl, "/harness/adaptive/runtime/acknowledge", {
            method: "POST",
          }),
      },
      decisions: {
        list: (filter: { sessionID?: string; episodeID?: string; kind?: string; limit?: number } = {}) =>
          harnessAuthorizedJson<StoredDecision[]>(baseUrl, `/harness/adaptive/decisions${adaptiveQuery(filter)}`),
        /**
         * One page of the audit (AH-E05): newest first, with the cursor of the next page when there is
         * one. An older server ignores `limit`/`before`/`acted`, answers the whole list and no cursor.
         */
        page: async (filter: DecisionPageFilter) => {
          const response = await harnessAuthorizedRequest(
            baseUrl,
            `/harness/adaptive/decisions${adaptiveQuery({
              ...filter,
              acted: filter.acted === undefined ? undefined : String(filter.acted),
            })}`,
          )
          const body = (await response.json().catch(() => undefined)) as
            | { data?: StoredDecision[]; nextCursor?: string; error?: string }
            | undefined
          if (!response.ok) throw new Error(body?.error ?? `Harness request failed (${response.status})`)
          return { data: body?.data ?? [], nextCursor: body?.nextCursor }
        },
        explain: (id: string) =>
          harnessAuthorizedJson<DecisionExplanation>(baseUrl, `/harness/adaptive/decisions/${encodeURIComponent(id)}`),
      },
      voi: {
        get: () => harnessAuthorizedJson<ValueGateSnapshot>(baseUrl, "/harness/adaptive/voi"),
      },
      plans: {
        list: (
          filter: { runID?: string; taskID?: string; episodeID?: string; sessionID?: string; projectID?: string; limit?: number } = {},
        ) => harnessAuthorizedJson<StoredPlan[]>(baseUrl, `/harness/adaptive/plans${adaptiveQuery(filter)}`),
        explain: (id: string) => harnessAuthorizedJson<StoredPlan>(baseUrl, `/harness/adaptive/plans/${encodeURIComponent(id)}`),
      },
      proposals: {
        list: (filter: { episodeID?: string; projectID?: string; status?: string; limit?: number } = {}) =>
          harnessAuthorizedJson<SkillProposal[]>(baseUrl, `/harness/adaptive/proposals${adaptiveQuery(filter)}`),
        get: (id: string) =>
          harnessAuthorizedJson<SkillProposal>(baseUrl, `/harness/adaptive/proposals/${encodeURIComponent(id)}`),
        /** Installs a staged proposal (AH-A04); called only after a person confirmed it, so `confirm` is sent. */
        approve: (id: string) =>
          harnessAuthorizedJson<SkillProposal>(baseUrl, `/harness/adaptive/proposals/${encodeURIComponent(id)}/approve`, {
            method: "POST",
            body: JSON.stringify({ confirm: true }),
          }),
        reject: (id: string) =>
          harnessAuthorizedJson<SkillProposal>(baseUrl, `/harness/adaptive/proposals/${encodeURIComponent(id)}/reject`, {
            method: "POST",
            body: JSON.stringify({}),
          }),
      },
      learnedSkills: {
        list: (filter: { projectID?: string } = {}) =>
          harnessAuthorizedJson<LearnedSkill[]>(baseUrl, `/harness/adaptive/learned-skills${adaptiveQuery(filter)}`),
        get: (name: string, filter: { projectID?: string } = {}) =>
          harnessAuthorizedJson<LearnedSkill>(
            baseUrl,
            `/harness/adaptive/learned-skills/${encodeURIComponent(name)}${adaptiveQuery(filter)}`,
          ),
        /**
         * Disables, enables or archives an installed learned skill (AH-E04); called only after a person
         * confirmed the consequence, so `confirm` is sent.
         */
        act: (name: string, action: "disable" | "enable" | "archive", projectID: string) =>
          harnessAuthorizedJson<{ name: string; status: "learned" | "disabled" | "archived" }>(
            baseUrl,
            `/harness/adaptive/learned-skills/${encodeURIComponent(name)}/${action}`,
            { method: "POST", body: JSON.stringify({ projectID, confirm: true }) },
          ),
      },
      /** The adaptive baseline (AH-B01): one session's turns. Costs come from the usage ledger (UL-06). */
      metrics: {
        session: (sessionID: string) =>
          harnessAuthorizedJson<SessionMetricTurn[]>(
            baseUrl,
            `/harness/adaptive/metrics?sessionID=${encodeURIComponent(sessionID)}`,
          ),
      },
      /** The composer chip's session (AH-E02): its latest turn, and the pause and exclusions a person set. */
      sessions: {
        turn: (sessionID: string) =>
          harnessAuthorizedJson<SessionTurnSummary>(
            baseUrl,
            `/harness/adaptive/sessions/${encodeURIComponent(sessionID)}/turn`,
          ),
        setOverride: (sessionID: string, patch: Partial<SessionAdaptiveOverride>) =>
          harnessAuthorizedJson<SessionAdaptiveOverride>(
            baseUrl,
            `/harness/adaptive/sessions/${encodeURIComponent(sessionID)}/override`,
            { method: "PUT", body: JSON.stringify(patch) },
          ),
      },
      guardrails: {
        status: (sessionID: string) =>
          harnessAuthorizedJson<GuardrailStatus | null>(
            baseUrl,
            `/harness/adaptive/guardrails/status?sessionID=${encodeURIComponent(sessionID)}`,
          ),
      },
    },
  }
}

/** A filter as a query string, with the empty ones left out rather than sent as "undefined". */
/** What a page of the decision audit is filtered by (AH-E05); an absent field is not a filter. */
export type DecisionPageFilter = {
  id?: string
  sessionID?: string
  kind?: string
  acted?: boolean
  before?: string
  limit?: number
}

function adaptiveQuery(filter: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(filter)) {
    if (typeof value === "string" && value) search.set(key, value)
    if (typeof value === "number") search.set(key, String(value))
  }
  return search.size ? `?${search}` : ""
}

/** `?directory=&project=` when either is set, and nothing when neither is (WA-8). */
function actionQuery(input: { directory?: string; project?: string }): string {
  const search = new URLSearchParams()
  if (input.directory) search.set("directory", input.directory)
  if (input.project) search.set("project", input.project)
  return search.size ? `?${search}` : ""
}
