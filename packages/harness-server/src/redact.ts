/**
 * Keeping a secret out of anything a run records (WA-2).
 *
 * The runner holds a credential's value for as long as it takes to type it, and every message, URL,
 * title or snapshot it reports has to survive passing through it. Replacing the value wherever it
 * appears is the only check that does not depend on knowing where it leaked.
 *
 * A value is not only leaked raw: a snapshot's HTML carries it escaped as entities, and a URL carries
 * it percent-encoded. Each secret is replaced in every shape it could have been written back in.
 */

/** The escaping `outerHTML`/`innerHTML` apply, in the order that keeps an ampersand from doubling. */
const escapeHTML = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")

/**
 * The shapes a secret takes in a URL: `encodeURIComponent`, the form-encoded space, and the
 * `application/x-www-form-urlencoded` escaping `URLSearchParams` applies — it also escapes `~ ! ' ( )`.
 */
const encodedForms = (secret: string): string[] => {
  // A lone surrogate throws here; redaction must never be the call that fails, so it only falls back
  // to the shapes that do not need encoding.
  try {
    const encoded = encodeURIComponent(secret)
    const form = new URLSearchParams({ v: secret }).toString().slice(2)
    return [...new Set([encoded, encoded.replace(/%20/g, "+"), form])].filter((value) => value !== "")
  } catch {
    return []
  }
}

/** The HTML escaping, plus the control characters a browser writes back inside an attribute. */
const escapeAttribute = (value: string): string =>
  escapeHTML(value)
    .replace(/\n/g, "&#10;")
    .replace(/\t/g, "&#9;")
    .replace(/\r/g, "&#13;")
    .replace(/\u00a0/g, "&nbsp;")

/** Raw, HTML-escaped, attribute-escaped, percent-encoded and form-encoded, deduplicated, empties dropped. */
const variantsOf = (secret: string): string[] => [
  secret,
  escapeHTML(secret),
  escapeAttribute(secret),
  ...encodedForms(secret),
]

/** A value is replaced wherever it appears; the longest first, so one secret inside another still goes. */
export function redactSecrets(text: string, secrets: string[]): string {
  return [...new Set(secrets.flatMap(variantsOf))]
    .filter((secret) => secret !== "")
    .sort((left, right) => right.length - left.length)
    .reduce((result, secret) => result.split(secret).join("[redacted]"), text)
}
