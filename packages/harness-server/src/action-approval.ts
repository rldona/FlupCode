import { createHash, randomUUID } from "node:crypto"
import type { ActionListInput, ActionRunner } from "./action-runner"
import type { ActionProfile } from "./actions"
import { TIER_WORDS, profileTier } from "./browser-policy"
import type { BrowserAnswer, BrowserPermit, BrowserPolicy, BrowserTier } from "./browser-policy"

/**
 * A web action's approval on OpenCode 2 (V2-31), decided by the browser policy (BU-01).
 *
 * 2.x gives a plugin's tool no permission prompt, so the actions plugin asks here first. What is
 * asked is decided from the profile this server loaded, never from the plugin's request: its origin
 * and the tier of what its steps do go to `BrowserPolicy.decide`. A standing grant or a blocked site
 * answers without asking; otherwise the reader in the session is asked, as a form the app shows as a
 * browser approval: the site, what the action does in plain words, and how long a yes lasts.
 *
 * The run route trusts only this decision (TI-09): a yes is a single-use approval id, bound to the
 * action, the session, the project and the inputs it was asked for, that the run must present. The
 * id carries the policy's permit, which the runner spends before the browser opens.
 */
export function createActionApprover(input: {
  actions: Pick<ActionRunner, "list">
  policy: BrowserPolicy
  /** Asks the reader in the session: the value of the option picked, if any. */
  ask: (request: {
    sessionID: string
    title: string
    description: string
    options: Array<{ value: string; label: string }>
    metadata: BrowserApprovalMetadata
    timeoutMs: number
  }) => Promise<string | undefined>
  timeoutMs?: number
}) {
  const grants = new Map<string, { key: string; expires: number; permit: BrowserPermit }>()
  const grant = (request: ApprovalScope, permit: BrowserPermit) => {
    const now = Date.now()
    for (const [id, entry] of grants) if (entry.expires <= now) grants.delete(id)
    const id = randomUUID()
    grants.set(id, { key: scopeKey(request), expires: now + GRANT_TTL_MS, permit })
    return id
  }
  return {
    /** Spends an approval id: its permit once, for the run it was granted for, and never again. */
    consume(id: string, request: ApprovalScope) {
      const entry = grants.get(id)
      grants.delete(id)
      return entry && entry.expires > Date.now() && entry.key === scopeKey(request) ? entry.permit : undefined
    },
    async approve(request: ApprovalScope) {
      const profile = input.actions
        .list({
          ...(request.directory ? { directory: request.directory } : {}),
          ...(request.project ? { project: request.project } : {}),
        })
        .profiles.find((entry) => entry.id === request.action)
      if (!profile) return { approved: false as const, reason: "unknown_action" as const }
      const tier = profileTier(profile)
      const question = { origin: profile.origin, tier, sessionId: request.sessionID, action: profile.id }
      const verdict = input.policy.decide(question)
      if (verdict.decision === "deny")
        return { approved: false as const, reason: "blocked" as const, message: verdict.reason }
      if (verdict.decision === "allow" && verdict.permit)
        return { approved: true as const, remembered: true, approval: grant(request, verdict.permit) }
      const site = new URL(profile.origin).host
      const answer = await input.ask({
        sessionID: request.sessionID,
        title: `Allow the agent to ${TIER_WORDS[tier]} on ${site}?`,
        description: describe(profile),
        options: approvalOptions(tier, site),
        metadata: { flupcode: "browser-approval", origin: profile.origin, site, tier, action: profile.id },
        timeoutMs: input.timeoutMs ?? 10 * 60 * 1000,
      })
      const permit = input.policy.answer(question, readAnswer(answer))
      if (permit) return { approved: true as const, remembered: false, approval: grant(request, permit) }
      return { approved: false as const, reason: answer === "deny" ? ("denied" as const) : ("unanswered" as const) }
    },
  }
}

/** What the app reads off the approval form to show it as a browser approval rather than a question. */
export type BrowserApprovalMetadata = {
  flupcode: "browser-approval"
  origin: string
  site: string
  tier: BrowserTier
  action: string
}

/**
 * The answers an approval offers, in the order the reader sees them. A sensitive action is allowed
 * once or denied; anything else may also be allowed for the session or always, at the tier it asked
 * for, so "always allow reading" a site is one click.
 */
export function approvalOptions(tier: BrowserTier, site: string) {
  return [
    { value: "once", label: "Allow once" },
    ...(tier === "sensitive"
      ? []
      : [
          { value: "session", label: "Allow for this session" },
          { value: "always", label: `Always allow to ${TIER_WORDS[tier]} on ${site}` },
        ]),
    { value: "deny", label: "Deny" },
  ]
}

const readAnswer = (value: string | undefined): BrowserAnswer =>
  value === "once" || value === "session" || value === "always" || value === "deny" ? value : undefined

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

/** The step kinds that change a page or send something, in the words the approval uses. */
const EFFECTS: Record<string, string> = { fill: "type", click: "click", upload: "upload a file", submit: "submit a form" }

function describe(profile: ActionProfile) {
  const effects = [
    ...new Set(
      profile.steps.flatMap((step) =>
        Object.keys(EFFECTS)
          .filter((kind) => kind in (step as Record<string, unknown>))
          .map((kind) => EFFECTS[kind]!),
      ),
    ),
  ]
  return [
    /[.!?]$/.test(profile.description.trim()) ? profile.description.trim() : `${profile.description.trim()}.`,
    effects.length > 0 ? `It will ${effects.length > 1 ? `${effects.slice(0, -1).join(", ")} and ${effects.at(-1)}` : effects[0]} on the page.` : "",
    profile.credential ? `It signs in with the saved credential "${profile.credential}".` : "",
  ]
    .filter(Boolean)
    .join(" ")
}

export type ActionApprover = ReturnType<typeof createActionApprover>
