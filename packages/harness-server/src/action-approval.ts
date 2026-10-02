import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ActionListInput, ActionRunner } from "./action-runner"
import type { ActionProfile } from "./actions"

/**
 * A web action's approval on OpenCode 2 (V2-31).
 *
 * On 1.x the actions plugin asks the engine's own permission prompt before every call. 2.x gives a
 * plugin's tool no such prompt (a tool's `permission` option is not enforced for plugin tools, and the
 * tool context has no `ask`), so the plugin asks here first and this server asks the reader in the
 * session, as a form the app shows like any question. What is asked is decided from the profile this
 * server loaded, never from the plugin's request: an action that types, clicks, uploads, submits or
 * signs in is sensitive and is approved per action; any other only per origin, as on 1.x. "Always"
 * answers are kept in a file beside the database, so they outlive a restart.
 *
 * The run route trusts only this decision (TI-09): a yes is a single-use approval id, bound to the
 * action, the session, the project and the inputs it was asked for, that the run must present.
 */
export function createActionApprover(input: {
  actions: Pick<ActionRunner, "list">
  /** Asks the reader in the session: the value of the option picked (`APPROVAL_OPTIONS`), if any. */
  ask: (request: {
    sessionID: string
    title: string
    description: string
    timeoutMs: number
  }) => Promise<string | undefined>
  file: string
  timeoutMs?: number
}) {
  const grants = new Map<string, { key: string; expires: number }>()
  const grant = (request: ApprovalScope) => {
    const now = Date.now()
    for (const [id, entry] of grants) if (entry.expires <= now) grants.delete(id)
    const id = randomUUID()
    grants.set(id, { key: scopeKey(request), expires: now + GRANT_TTL_MS })
    return id
  }
  return {
    /** Spends an approval id: true once, for the run it was granted for, and never again. */
    consume(id: string, request: ApprovalScope) {
      const entry = grants.get(id)
      grants.delete(id)
      return !!entry && entry.expires > Date.now() && entry.key === scopeKey(request)
    },
    async approve(request: ApprovalScope) {
      const profile = input.actions
        .list({
          ...(request.directory ? { directory: request.directory } : {}),
          ...(request.project ? { project: request.project } : {}),
        })
        .profiles.find((entry) => entry.id === request.action)
      if (!profile) return { approved: false as const, reason: "unknown_action" as const }
      const sensitive = isSensitive(profile)
      const resource = sensitive ? `${profile.origin}:${profile.id}` : profile.origin
      if (readAlways(input.file).includes(resource))
        return { approved: true as const, remembered: true, approval: grant(request) }
      const decision = await input.ask({
        sessionID: request.sessionID,
        title: sensitive
          ? `Allow the web action "${profile.id}" on ${profile.origin}?`
          : `Allow web actions on ${profile.origin}?`,
        description: describe(profile, sensitive),
        timeoutMs: input.timeoutMs ?? 10 * 60 * 1000,
      })
      if (decision === "always") writeAlways(input.file, [...readAlways(input.file), resource])
      if (decision === "once" || decision === "always")
        return { approved: true as const, remembered: false, approval: grant(request) }
      return { approved: false as const, reason: decision === "deny" ? ("denied" as const) : ("unanswered" as const) }
    },
  }
}

/** What an approval is for: the run that presents its id must match it exactly. */
type ApprovalScope = { action: string; sessionID: string; inputs?: Record<string, unknown> } & ActionListInput

/** Long enough for the plugin to start the run it asked for, short enough not to linger. */
const GRANT_TTL_MS = 5 * 60 * 1000

const scopeKey = (request: ApprovalScope) =>
  JSON.stringify([
    request.action,
    request.sessionID,
    request.project ?? "",
    request.directory ?? "",
    createHash("sha256")
      .update(canonical(request.inputs ?? {}))
      .digest("hex"),
  ])

/** JSON with sorted keys, so the same inputs hash the same however they were written. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

/** The step kinds that change a page or sign in, as the 1.x plugin counts them. */
const EFFECTS = ["fill", "click", "upload", "submit"]

function isSensitive(profile: ActionProfile) {
  return (
    profile.sensitive ||
    !!profile.credential ||
    profile.steps.some((step) => EFFECTS.some((kind) => kind in (step as Record<string, unknown>)))
  )
}

function describe(profile: ActionProfile, sensitive: boolean) {
  const effects = profile.steps.flatMap((step) => EFFECTS.filter((kind) => kind in (step as Record<string, unknown>)))
  return [
    profile.description,
    sensitive && effects.length > 0 ? `It will ${[...new Set(effects)].join(", ")} on the page.` : "",
    profile.credential ? `It signs in with the saved credential "${profile.credential}".` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

function readAlways(file: string): string[] {
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { always?: unknown }
  return Array.isArray(parsed.always) ? parsed.always.filter((entry): entry is string => typeof entry === "string") : []
}

function writeAlways(file: string, always: string[]) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ always: [...new Set(always)] }, null, 2), { mode: 0o600 })
}

export type ActionApprover = ReturnType<typeof createActionApprover>

/** The answers an approval offers, in the order the reader sees them. */
export const APPROVAL_OPTIONS = [
  { value: "once", label: "Allow once" },
  { value: "always", label: "Always allow" },
  { value: "deny", label: "Deny" },
]
