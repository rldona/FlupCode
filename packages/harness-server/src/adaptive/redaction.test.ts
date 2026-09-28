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
