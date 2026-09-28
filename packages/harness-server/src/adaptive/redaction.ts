/**
 * Deterministic redaction for state on its way out (FH-014).
 *
 * Modelled on the http-recorder's redaction — the same idea, kept local because that package is not a
 * dependency of `harness-server`. Two passes, both conservative: known secret values (the ones the
 * process already holds, plus whatever the caller names) are removed literally, and a small set of
 * well-known credential shapes is swept by pattern. Anything not matched is left untouched, so
 * ordinary technical text — paths, commands, source — is not mangled into uselessness.
 */

export const REDACTED = "[REDACTED]"

export type SecretPattern = { label: string; pattern: RegExp }

/** Credential shapes worth a sweep. Private-key blocks are matched whole, not just their header. */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { label: "URL secret", pattern: /[?&#](?:password|passwd|api[_-]?key|apikey|access_token|token|secret)=[^&\s#]+/gi },
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
]

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

/** Removes each known value wherever it appears; empty and very short values are ignored. */
export function redactKnownSecrets(text: string, secrets: readonly string[] = []): string {
  const values = [...secrets, ...environmentSecrets().map((secret) => secret.value)].filter(
    (secret) => secret.length >= MIN_KNOWN_SECRET_LENGTH,
  )
  return values.reduce((current, secret) => current.split(secret).join(REDACTED), text)
}

/** Sweeps the credential shapes, whatever the caller knows. */
export function redactPatterns(text: string): string {
  return SECRET_PATTERNS.reduce((current, secret) => current.replace(secret.pattern, REDACTED), text)
}

/** Known values first, then patterns: a secret the caller names is gone even if no pattern matches it. */
export function redactText(text: string, secrets: readonly string[] = []): string {
  return redactPatterns(redactKnownSecrets(text, secrets))
}
