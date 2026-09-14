import { describe, expect, test } from "bun:test"
import { errorDetail } from "./error-text"

describe("errorDetail", () => {
  test("keeps non-HTTP errors untouched", () => {
    expect(errorDetail("Provider turn interrupted")).toBe("Provider turn interrupted")
    expect(errorDetail("Provider did not return a tool result")).toBe("Provider did not return a tool result")
  })

  test("surfaces the nested provider message without the JSON envelope", () => {
    const message =
      'Provider request failed with HTTP 400: {"error":{"param":null,"type":"invalid_request_error","message":"Invalid assistant message: content or tool_calls must be set"}}'
    expect(errorDetail(message)).toBe("HTTP 400: Invalid assistant message: content or tool_calls must be set")
  })

  test("reads a doubly nested gateway message", () => {
    const message =
      'Provider request failed with HTTP 429: {"type":"error","error":{"type":"GoUsageLimitError","message":"Weekly usage limit reached. Resets in 5hr 41min."}}'
    expect(errorDetail(message)).toBe("HTTP 429: Weekly usage limit reached. Resets in 5hr 41min.")
  })

  test("reads top-level message and detail fields", () => {
    const balance = 'Provider request failed with HTTP 402: {"message":"Insufficient Balance"}'
    const upstream = 'Provider request failed with HTTP 500: {"detail":"upstream boom"}'
    expect(errorDetail(balance)).toBe("HTTP 402: Insufficient Balance")
    expect(errorDetail(upstream)).toBe("HTTP 500: upstream boom")
  })

  test("falls back to the status when the body is not a usable envelope", () => {
    expect(errorDetail("Provider request failed with HTTP 502: gateway timeout")).toBe("HTTP 502")
    expect(errorDetail("Provider request failed with HTTP 503: ")).toBe("HTTP 503")
  })
})
