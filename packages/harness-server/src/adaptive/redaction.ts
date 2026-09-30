/**
 * Deterministic redaction for state on its way out (FH-014).
 *
 * Modelled on the http-recorder's redaction — the same idea, kept local because that package is not a
 * dependency of `harness-server`. Two passes, both conservative: known secret values (the ones the
 * process already holds, plus whatever the caller names) are removed literally, and a small set of
 * well-known credential shapes is swept by pattern. Anything not matched is left untouched, so
 * ordinary technical text — paths, commands, source — is not mangled into uselessness.
 */

import { secretForms } from "../redact"

export const REDACTED = "[REDACTED]"

/** A credential shape; `replacement` keeps the non-secret parts (a key name, a URL scheme) when set. */
export type SecretPattern = { label: string; pattern: RegExp; replacement?: string }

/**
 * A key whose value is a secret, as `.env`, YAML or a shell writes it: the whole key, or its last
 * segment after `_`, `-` or `.`, is one of these words. `maxInputTokens` or `tokens` do not qualify,
 * so ordinary settings keep their numbers.
 */
const SECRET_KEY =
  "(?:[A-Za-z0-9]+[_.-])*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?token)"

/**
 * Credential shapes worth a sweep. Private-key blocks are matched whole, not just their header.
 *
 * The generic sweep is deliberately narrow: 40+ characters mixing upper case, lower case and at
 * least three digits.
 * Git SHAs, sha256 digests and the adaptive layer's HMAC ids are lower-case hex, and UUIDs and engine
 * ids are shorter or single-case, so the hashes other code relies on are never touched.
 */
export const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  { label: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { label: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi },
  {
    label: "basic auth",
    pattern: /\b(Authorization\s*:\s*Basic\s+)[A-Za-z0-9+/]{8,}={0,2}/gi,
    replacement: `$1${REDACTED}`,
  },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { label: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { label: "API key", pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{20,}\b/g },
  { label: "Stripe key", pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { label: "AWS access key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { label: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { label: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { label: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: "npm token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/g },
  {
    label: "URL credentials",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replacement: `$1${REDACTED}@`,
  },
  { label: "URL secret", pattern: /[?&#](?:password|passwd|api[_-]?key|apikey|access_token|token|secret)=[^&\s#]+/gi },
  {
    label: "secret assignment",
    // The key may be quoted, so a JSON-serialized state (`"password":"…"`) is swept too. The value is
    // taken whole through a lookahead (an atomic group), so a call such as `token = readToken()` is
    // left alone instead of being cut back to a prefix that happens to match.
    pattern: new RegExp(
      `(?<![A-Za-z0-9_.-])(${SECRET_KEY})(["']?\\s*[:=]\\s*)(["']?)(?=([^\\s"'\`<>(){}\\[\\],;]{6,}))\\4(?![(\\w.])`,
      "gi",
    ),
    replacement: `$1$2$3${REDACTED}`,
  },
  {
    label: "high-entropy token",
    pattern:
      /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=(?:[A-Za-z_-]*[0-9]){3})[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
  },
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
