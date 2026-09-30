import { describe, expect, test } from "bun:test"
import { cachedText, msText, percentilesText, sessionCostKey, sessionLabel, sinceFor } from "./SessionCosts"
import type { SessionCost } from "../types"

describe("when the session cost is asked for", () => {
  const base = { open: true, capabilities: ["adaptive-metrics"], serverUrl: "http://h", days: 30 }

  test("only on an open screen of a server that announced the metrics", () => {
    expect(sessionCostKey(base)).toBe("http://h\n\n30")
    expect(sessionCostKey({ ...base, open: false })).toBeUndefined()
    // An older sidecar never hears the request, so there is no 404 in its console.
    expect(sessionCostKey({ ...base, capabilities: ["adaptive-decisions"] })).toBeUndefined()
  })

  test("again when the window or the project changes", () => {
    expect(sessionCostKey({ ...base, days: 7 })).not.toBe(sessionCostKey(base))
    expect(sessionCostKey({ ...base, directory: "/w" })).toBe("http://h\n/w\n30")
    expect(sessionCostKey({ ...base, days: undefined })).toBe("http://h\n\n0")
  })

  test("the window starts that many days ago, and no window has no start", () => {
    expect(sinceFor(7, 10 * 86_400_000)).toBe(3 * 86_400_000)
    expect(sinceFor(undefined, 10)).toBeUndefined()
  })
})

describe("how the numbers are said", () => {
  test("the cached share is a whole percentage", () => {
    expect(cachedText(0.6)).toBe("60%")
    expect(cachedText(0)).toBe("0%")
  })

  test("a latency keeps milliseconds, then seconds, then minutes", () => {
    expect(msText(240)).toBe("240 ms")
    expect(msText(1_500)).toBe("1.5 s")
    expect(msText(125_000)).toBe("2m 05s")
    expect(msText(undefined)).toBe("—")
  })

  test("p50 and p95 sit side by side, and none measured is a dash rather than zero", () => {
    expect(percentilesText({ p50: 800, p95: 4_200 })).toBe("800 ms / 4.2 s")
    expect(percentilesText({})).toBe("—")
  })

  test("a session is named by its title, and by its id when the engine forgot it", () => {
    const session = { sessionID: "ses_1" } as SessionCost
    expect(sessionLabel(session, "Fix the login")).toBe("Fix the login")
    expect(sessionLabel(session, undefined)).toBe("ses_1")
  })
})
