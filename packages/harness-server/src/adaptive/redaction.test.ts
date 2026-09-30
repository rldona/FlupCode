import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { REDACTED, environmentSecrets, redactKnownSecrets, redactPatterns, redactText } from "./redaction"

const CANARY = "canary-secret-value-1234567890"

let tokenBefore: string | undefined

beforeEach(() => {
  tokenBefore = process.env.FLUPCODE_TEST_API_TOKEN
})

afterEach(() => {
  if (tokenBefore === undefined) delete process.env.FLUPCODE_TEST_API_TOKEN
  else process.env.FLUPCODE_TEST_API_TOKEN = tokenBefore
})

describe("redactText", () => {
  test("a known canary never survives", () => {
    const text = `before ${CANARY} after`
    const redacted = redactText(text, [CANARY])
    expect(redacted).not.toContain(CANARY)
    expect(redacted).toContain(REDACTED)
  })

  test("sweeps bearer, api keys, cloud keys and private key blocks", () => {
    const bearer = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature"
    const apiKey = "token sk-abcdefghijklmnopqrstuvwxyz0123456"
    const aws = "aws AKIAIOSFODNN7EXAMPLE here"
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
    const url = "https://example.test/cb?password=hunter2&next=1"

    for (const text of [bearer, apiKey, aws, pem, url]) {
      const redacted = redactText(text)
      expect(redacted).toContain(REDACTED)
      expect(redacted).not.toMatch(/hunter2|AKIAIOSFODNN7EXAMPLE|eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/)
    }
  })

  test("leaves ordinary technical text alone", () => {
    const text = "bun test src/adaptive/redaction.test.ts && git diff --stat packages/harness-server/src"
    expect(redactText(text)).toBe(text)
  })

  test("ignores empty and very short known values instead of mangling text", () => {
    const text = "abc abc abc"
    expect(redactText(text, ["", "abc"])).toBe(text)
  })

  test("removes an environment secret whose name looks sensitive", () => {
    process.env.FLUPCODE_TEST_API_TOKEN = "env-secret-value-0987654321"
    const redacted = redactText("leaking env-secret-value-0987654321 now")
    expect(redacted).not.toContain("env-secret-value-0987654321")
  })
})

/**
 * The corpus (AH-A12): every credential shape the sweep claims, each with the secret part that must
 * not survive. The fixtures are assembled from pieces so no scanner mistakes this file for a leak.
 */
const CORPUS: Array<{ label: string; text: string; secret: string }> = [
  { label: "Stripe live secret key", text: `key ${"sk_live_"}${"4eC39HqLyjWDarjtT1zdp7dc"}`, secret: "4eC39HqLyjWDarjtT1zdp7dc" },
  { label: "Stripe restricted key", text: `key ${"rk_live_"}${"51HqLyjWDarjtT1zdp7dcXYZ"}`, secret: "51HqLyjWDarjtT1zdp7dcXYZ" },
  { label: "Stripe test key", text: `key ${"sk_test_"}${"26PHem9AhJZvU623DfE1x4sd"}`, secret: "26PHem9AhJZvU623DfE1x4sd" },
  {
    label: "JWT",
    text: `id_token ${"eyJhbGciOiJIUzI1NiJ9"}.${"eyJzdWIiOiIxMjM0NTY3ODkwIn0"}.${"dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"}`,
    secret: "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
  },
  { label: "Slack bot token", text: `slack ${"xoxb-"}${"123456789012-1234567890123-AbCdEfGh"}`, secret: "1234567890123-AbCdEfGh" },
  { label: "Slack user token", text: `slack ${"xoxp-"}${"123456789012-abcdefghijkl"}`, secret: "123456789012-abcdefghijkl" },
  { label: "GitHub fine-grained token", text: `${"github_pat_"}${"11ABCDEFG0123456789_abcdefghijKLMNOP"}`, secret: "11ABCDEFG0123456789" },
  { label: "npm token", text: `//registry.npmjs.org/:_authToken=${"npm_"}${"a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8"}`, secret: "a1B2c3D4e5F6g7H8i9J0" },
  { label: "Basic auth header", text: "Authorization: Basic dXNlcjpodW50ZXIy", secret: "dXNlcjpodW50ZXIy" },
  { label: "URL with credentials", text: "git clone https://deploy:hunter2secret@git.example.test/repo.git", secret: "hunter2secret" },
  { label: "database URL", text: "DATABASE_URL=postgres://admin:s3cr3tpass@db:5432/app", secret: "s3cr3tpass" },
  { label: ".env PASSWORD", text: "PASSWORD=hunter22", secret: "hunter22" },
  { label: "YAML password", text: "db:\n  password: hunter22\n  host: localhost", secret: "hunter22" },
  { label: ".env *_SECRET", text: "CLIENT_SECRET=abcdef123456", secret: "abcdef123456" },
  { label: ".env *_TOKEN", text: "export SENTRY_AUTH_TOKEN=\"sntrys_abc123def\"", secret: "sntrys_abc123def" },
  { label: ".env API_KEY", text: "API_KEY='zyxwvu987654'", secret: "zyxwvu987654" },
  { label: "JSON password", text: JSON.stringify({ user: "a", password: "hunter22" }), secret: "hunter22" },
  { label: "high-entropy token", text: "token-ish aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7sU here", secret: "aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7sU" },
]

describe("the redaction corpus", () => {
  for (const entry of CORPUS) {
    test(`${entry.label} is redacted`, () => {
      const redacted = redactText(entry.text)
      expect(redacted).not.toContain(entry.secret)
      expect(redacted).toContain(REDACTED)
    })
  }

  test("a key-value sweep keeps the key name, so the text still says what was there", () => {
    expect(redactText("PASSWORD=hunter22")).toBe(`PASSWORD=${REDACTED}`)
    expect(redactText("postgres://admin:s3cr3tpass@db:5432/app")).toBe(`postgres://${REDACTED}@db:5432/app`)
  })

  test("the hashes and ids the adaptive layer relies on are never touched", () => {
    const untouched = [
      // A git SHA-1, a sha256 digest (both lower-case hex), an HMAC opaque id, a UUID.
      "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
      "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      "path:1f2e3d4c5b6a7980",
      "run 123e4567-e89b-12d3-a456-426614174000",
      // Engine ids and ordinary settings keep their shape too.
      "ses_01JABCdefGHIjklMNOpqrST msg_01JXYZabcDEF",
      "maxInputTokens: 2000",
      "tokens: 120000",
      "const token = readToken()",
      "Basic configuration applies",
      "git@github.com:org/repo.git and https://github.com/org/repo",
      "handleUserAuthenticationRequestCallbackHandler",
    ]
    for (const text of untouched) expect(redactText(text)).toBe(text)
  })

  test("a known value is removed raw and in its percent-encoded shape", () => {
    const secret = "vault value/with spaces"
    const redacted = redactText(`raw ${secret} url ${encodeURIComponent(secret)}`, [secret])
    expect(redacted).not.toContain(secret)
    expect(redacted).not.toContain(encodeURIComponent(secret))
  })
})

describe("redaction passes", () => {
  test("known values are removed before the pattern sweep", () => {
    const text = `raw ${CANARY}`
    expect(redactKnownSecrets(text, [CANARY])).toBe(`raw ${REDACTED}`)
    expect(redactPatterns(text)).toBe(text)
  })

  test("environmentSecrets only reports a named, long, non-placeholder value", () => {
    expect(environmentSecrets({ FLUPCODE_TEST_API_TOKEN: "env-secret-value-0987654321" })).toEqual([
      { name: "FLUPCODE_TEST_API_TOKEN", value: "env-secret-value-0987654321" },
    ])
    expect(environmentSecrets({})).toEqual([])
    expect(environmentSecrets({ FLUPCODE_TEST_API_TOKEN: "short" })).toEqual([])
  })
})
