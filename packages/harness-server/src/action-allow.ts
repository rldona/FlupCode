/**
 * The approval a web action runs under when nobody is there to answer it (WA-7).
 *
 * Pure by design, like `actions.ts`: the rules a profile needs, whether a routine's declared rules
 * cover them, and whether the values a routine carries can even fill the profile. The plugin asks
 * `ctx.ask` for an interactive run; a scheduled one has nobody to ask, so the consent is written
 * down on the routine and checked here — and again before the browser opens.
 */

import type { ActionProfile } from "./actions"
import type { BrowserAllowRule } from "./types"

/**
 * The allow rule a profile needs, in the plugin's own grammar.
 *
 * Same resource as the `ctx.ask` the interactive path makes: an origin for `browser`, and
 * `origin:action` for `browser_sensitive`. A profile that acts asks for the strong permission only,
 * which is what the plugin does too.
 */
export function requiredAllowRules(profile: ActionProfile): BrowserAllowRule[] {
  return [
    {
      permission: profile.sensitive ? "browser_sensitive" : "browser",
      pattern: profile.sensitive ? `${profile.origin}:${profile.id}` : profile.origin,
      action: "allow",
    },
  ]
}

/** The rules a profile needs that the declared ones do not cover. Empty means it may run. */
export function missingAllowRules(allow: BrowserAllowRule[], profile: ActionProfile): BrowserAllowRule[] {
  const have = new Set(allow.map((rule) => `${rule.permission} ${rule.pattern}`))
  return requiredAllowRules(profile).filter((rule) => !have.has(`${rule.permission} ${rule.pattern}`))
}

/**
 * The rules a caller sent, read as allow rules or not at all.
 *
 * Only `browser` and `browser_sensitive` with `allow` survive: a `deny` or a `bash` rule is not a
 * consent a scheduled action can hold, so it is dropped rather than honoured.
 */
export function allowRulesFrom(value: unknown): BrowserAllowRule[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!isPlainObject(entry)) return []
    const permission = entry.permission
    if (permission !== "browser" && permission !== "browser_sensitive") return []
    if (entry.action !== "allow") return []
    if (typeof entry.pattern !== "string" || !entry.pattern.trim()) return []
    return [{ permission, pattern: entry.pattern.trim(), action: "allow" as const }]
  })
}

/**
 * What is wrong with the values a routine carries for this profile, or nothing.
 *
 * The runtime materializes images and checks types for real; this is the creation-time answer, so a
 * routine that could never run says so at the form instead of failing at 2am.
 */
export function actionInputProblem(profile: ActionProfile, inputs: Record<string, unknown> | undefined): string | undefined {
  const provided = inputs ?? {}
  for (const [name, kind] of Object.entries(profile.inputs)) {
    const value = provided[name]
    if (value === undefined || value === null) return `This action needs input "${name}"`
    if (kind === "string" && typeof value !== "string") return `Input "${name}" must be a string`
    // The runner's template substitution treats an empty string as a missing input, so a routine
    // saved with one would fail at 2am instead of at the form.
    if (kind === "string" && value === "") return `Input "${name}" cannot be empty`
    if (kind === "image" && !isImageInput(value)) return `Input "${name}" must be an image artifact or data URL`
  }
  for (const name of Object.keys(provided)) {
    if (!(name in profile.inputs)) return `Input "${name}" is not declared by this action`
  }
  return undefined
}

const isImageInput = (value: unknown): boolean => {
  if (typeof value === "string") return value.startsWith("data:")
  if (isPlainObject(value)) return typeof value.dataUrl === "string" || typeof value.artifactId === "string"
  return false
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
