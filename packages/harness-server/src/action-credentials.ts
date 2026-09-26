/**
 * Where a web action's credential comes from, and how its value stays out of the record (WA-2).
 *
 * The vault (WA-5) is the resolver that can actually open a credential; the one here is the fallback
 * a build without a vault gets, so a profile that names a credential does not run rather than run
 * with an empty field. Collecting the names here lets the runner and the UI know what a recipe needs
 * without ever holding a value.
 */

import type { ActionProfile } from "./actions"

export type ActionCredentialResolver = { resolve(input: { name: string; origin: string }): Promise<string | undefined> }

/** The resolver a build without a vault has: every lookup is a miss, never an empty string. */
export const unavailableActionCredentialResolver: ActionCredentialResolver = {
  async resolve(): Promise<string | undefined> {
    return undefined
  },
}

export function collectCredentialNames(profile: ActionProfile): string[] {
  const names = new Set<string>()
  if (profile.credential) names.add(profile.credential)
  for (const step of profile.steps) {
    if (!("fill" in step)) continue
    const value = step.fill.credential
    if (!value) continue
    names.add(value === "{{credential}}" ? profile.credential ?? value : value)
  }
  return [...names]
}

// Kept here so callers that know this module do not have to reach for the redaction one.
export { redactSecrets } from "./redact"
