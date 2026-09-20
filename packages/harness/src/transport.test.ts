import { describe, expect, test } from "bun:test"
import { pickAddressSpace } from "./transport"

/** A browser that knows the option and accepts only these names for it. */
const validating = (accepted: string[]) => (init: RequestInit) => {
  const value = (init as { targetAddressSpace?: string }).targetAddressSpace
  if (value && !accepted.includes(value)) throw new TypeError(`unknown targetAddressSpace: ${value}`)
}

describe("pickAddressSpace", () => {
  test("uses the name the spec gives the option", () => {
    expect(pickAddressSpace(validating(["public", "local"]))).toBe("local")
  })

  test("falls back to the older name rather than sending nothing", () => {
    expect(pickAddressSpace(validating(["public", "loopback"]))).toBe("loopback")
  })

  test("sends no annotation at all when the browser rejects every name it knows", () => {
    expect(pickAddressSpace(validating([]))).toBeUndefined()
  })

  test("a browser that ignores the option gets the right name anyway", () => {
    expect(pickAddressSpace(() => undefined)).toBe("local")
  })
})
