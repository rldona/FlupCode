/**
 * Deterministic redaction for state on its way out (FH-014).
 *
 * Modelled on the http-recorder's redaction — the same idea, kept local because that package is not a
 * dependency of `harness-server`; the credential shapes live in `@flupcode/remote/secret-patterns`,
 * which the engine's memory plugin checks too. Two passes, both conservative: known secret values (the ones the
 * process already holds, plus whatever the caller names) are removed literally, and a small set of
 * well-known credential shapes is swept by pattern. Anything not matched is left untouched, so
 * ordinary technical text — paths, commands, source — is not mangled into uselessness.
 */

import { REDACTED, SECRET_PATTERNS } from "@flupcode/remote/secret-patterns"
import { secretForms } from "../redact"

export { REDACTED }

const ENV_SECRET_NAMES = /(?:API|AUTH|BEARER|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/i
const SAFE_ENV_VALUES = new Set(["fixture", "test", "test-key"])

/** Values never worth redacting literally: too short to be a secret, and split-joining them mangles text. */
const MIN_KNOWN_SECRET_LENGTH = 6

/**
 * The environment's own secrets: a value whose name looks sensitive, long enough to be one, and not a
 * known test placeholder. This is the same rule http-recorder uses, so the two never disagree about
 * which env value is a secret.
 */
export function environmentSecrets(env: NodeJS.ProcessEnv = process.env): Array<{ name: string; value: string }> {
  return Object.entries(env).flatMap(([name, value]) => {
    if (!value) return []
    if (!ENV_SECRET_NAMES.test(name)) return []
    if (value.length < 12) return []
    if (SAFE_ENV_VALUES.has(value.toLowerCase())) return []
    return [{ name, value }]
  })
}

/**
 * Removes each known value wherever it appears, raw or in the escaped and encoded shapes the browser
 * redactor also covers; empty and very short values are ignored.
 */
export function redactKnownSecrets(text: string, secrets: readonly string[] = []): string {
  const values = [...secrets, ...environmentSecrets().map((secret) => secret.value)].filter(
    (secret) => secret.length >= MIN_KNOWN_SECRET_LENGTH,
  )
  return secretForms(values).reduce((current, secret) => current.split(secret).join(REDACTED), text)
}

/** Sweeps the credential shapes, whatever the caller knows. */
export function redactPatterns(text: string): string {
  return SECRET_PATTERNS.reduce(
    (current, secret) => current.replace(secret.pattern, secret.replacement ?? REDACTED),
    text,
  )
}

/** Known values first, then patterns: a secret the caller names is gone even if no pattern matches it. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  return redactPatterns(redactKnownSecrets(text, secrets))
}
