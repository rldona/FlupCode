/**
 * Where a web action's credential comes from, and how its value stays out of the record (WA-2).
 *
 * The vault lands in WA-5. Until then the resolver is unavailable and fails closed: a profile that
 * names a credential does not run rather than run with an empty field. Collecting the names here lets
 * the runner and the UI know what a recipe needs without ever holding a value.
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

/** A value is replaced wherever it appears; the longest first, so one secret inside another still goes. */
export function redactSecrets(text: string, secrets: string[]): string {
  return [...secrets]
    .filter((secret) => secret !== "")
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join("[redacted]"), text)
}
