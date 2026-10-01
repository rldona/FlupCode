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
 */
export function createActionApprover(input: {
  actions: Pick<ActionRunner, "list">
  ask: (request: {
    sessionID: string
    title: string
    description: string
    timeoutMs: number
  }) => Promise<"once" | "always" | "deny" | undefined>
  file: string
  timeoutMs?: number
}) {
  return {
    async approve(request: { action: string; sessionID: string } & ActionListInput) {
      const profile = input.actions
        .list({
          ...(request.directory ? { directory: request.directory } : {}),
          ...(request.project ? { project: request.project } : {}),
        })
        .profiles.find((entry) => entry.id === request.action)
      if (!profile) return { approved: false as const, reason: "unknown_action" as const }
      const sensitive = isSensitive(profile)
      const resource = sensitive ? `${profile.origin}:${profile.id}` : profile.origin
      if (readAlways(input.file).includes(resource)) return { approved: true as const, remembered: true }
      const decision = await input.ask({
        sessionID: request.sessionID,
        title: sensitive
          ? `Allow the web action "${profile.id}" on ${profile.origin}?`
          : `Allow web actions on ${profile.origin}?`,
        description: describe(profile, sensitive),
        timeoutMs: input.timeoutMs ?? 10 * 60 * 1000,
      })
      if (decision === "always") writeAlways(input.file, [...readAlways(input.file), resource])
      if (decision === "once" || decision === "always") return { approved: true as const, remembered: false }
      return { approved: false as const, reason: decision === "deny" ? ("denied" as const) : ("unanswered" as const) }
    },
  }
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
