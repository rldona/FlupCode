import { describe, expect, test } from "bun:test"
import { watchEngineEvents, watchHarnessEvents } from "../src/notifier"

const sse = (events: unknown[]) => events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")

type Seen = { kind: string; sessionID: string; session: string; detail?: string }

/** A fake harness: one routines endpoint, and one event stream that ends as soon as it is read. */
const harness = (events: unknown[]) =>
  ((url: string | URL | Request) => {
    const path = new URL(String(url)).pathname
    if (path === "/harness/routines/rt_1")
      return Promise.resolve(new Response(JSON.stringify({ data: { name: "Nightly audit" } }), { status: 200 }))
    if (path === "/harness/events") return Promise.resolve(new Response(sse(events), { status: 200 }))
    return Promise.resolve(new Response("", { status: 404 }))
  }) as unknown as typeof globalThis.fetch

const routineRun = (over: Record<string, unknown> = {}) => ({
  type: "run.changed",
  run: { id: "run_1", status: "success", sessionID: "ses_root", source: { type: "routine", routineID: "rt_1" }, ...over },
})

describe("watchHarnessEvents", () => {
  test("a routine run ending is reported, with the routine's name", async () => {
    const seen: Seen[] = []
    const watcher = watchHarnessEvents({
      harness: "http://h",
      fetch: harness([routineRun()]),
      onNotification: (notification) => seen.push(notification),
    })
    await Bun.sleep(30)
    watcher.stop()

    expect(seen).toEqual([{ kind: "finished", sessionID: "ses_root", session: "Nightly audit", detail: "success" }])
  })

  test("only routine runs, only when they end, and only once", async () => {
    const seen: Seen[] = []
    const watcher = watchHarnessEvents({
      harness: "http://h",
      fetch: harness([
        // A manual run is not a routine.
        routineRun({ id: "run_manual", source: { type: "manual" } }),
        // Still going is not ended.
        routineRun({ id: "run_running", status: "running" }),
        // The same run ending twice is still one notification.
        routineRun({ id: "run_twice" }),
        routineRun({ id: "run_twice" }),
      ]),
      onNotification: (notification) => seen.push(notification),
    })
    await Bun.sleep(30)
    watcher.stop()

    expect(seen).toHaveLength(1)
    expect(seen[0]?.detail).toBe("success")
  })

  // AH-A05: with a token configured the harness refuses its event stream and routines without it.
  test("with the harness's token it presents the bearer and receives the routine's events", async () => {
    const seen: Seen[] = []
    const auth: Array<[string, string | null]> = []
    const open = harness([routineRun()])
    const guarded = ((url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization")
      auth.push([new URL(String(url)).pathname, authorization])
      if (authorization !== "Bearer secret-token")
        return Promise.resolve(new Response(JSON.stringify({ code: "invalid_token" }), { status: 403 }))
      return open(url, init)
    }) as unknown as typeof globalThis.fetch

    const refused = watchHarnessEvents({ harness: "http://h", fetch: guarded, onNotification: (n) => seen.push(n) })
    await Bun.sleep(30)
    refused.stop()
    expect(seen).toEqual([])

    auth.length = 0
    const watcher = watchHarnessEvents({
      harness: "http://h",
      token: "secret-token",
      fetch: guarded,
      onNotification: (notification) => seen.push(notification),
    })
    await Bun.sleep(30)
    watcher.stop()

    expect(seen).toEqual([{ kind: "finished", sessionID: "ses_root", session: "Nightly audit", detail: "success" }])
    expect(auth).toEqual([
      ["/harness/events", "Bearer secret-token"],
      ["/harness/routines/rt_1", "Bearer secret-token"],
    ])
  })

  test("a failed run is reported as a failure", async () => {
    const seen: Seen[] = []
    const watcher = watchHarnessEvents({
      harness: "http://h",
      fetch: harness([routineRun({ status: "failed" })]),
      onNotification: (notification) => seen.push(notification),
    })
    await Bun.sleep(30)
    watcher.stop()

    expect(seen[0]?.kind).toBe("failed")
  })

  // RP-07: a routine failing again and again is said once, after the run that reached the notice.
  test("a routine that keeps failing is reported once, after its failed run, with how many in a row", async () => {
    const seen: Seen[] = []
    const watcher = watchHarnessEvents({
      harness: "http://h",
      fetch: harness([
        routineRun({ id: "run_3", status: "failed" }),
        { type: "routine.failing", routineID: "rt_1", name: "Nightly audit", failedInARow: 3, sessionID: "ses_root" },
        // A run that failed to start has no session to open, so there is nothing to push.
        { type: "routine.failing", routineID: "rt_1", name: "Nightly audit", failedInARow: 3 },
      ]),
      onNotification: (notification) => seen.push(notification),
    })
    await Bun.sleep(30)
    watcher.stop()

    expect(seen).toEqual([
      { kind: "failed", sessionID: "ses_root", session: "Nightly audit", detail: "failed" },
      { kind: "failed", sessionID: "ses_root", session: "Nightly audit", detail: "failed 3 times in a row" },
    ])
  })

  // UL-08: a budget's warning and its limit, each raised once by the harness, open the session whose
  // step crossed it.
  test("a budget's warning and its limit are reported, with what was spent of it", async () => {
    const seen: Seen[] = []
    const budget = { type: "budget.reached", scope: "run", name: "review", unit: "usd", limit: 1, runID: "run_1" }
    const watcher = watchHarnessEvents({
      harness: "http://h",
      fetch: harness([
        { ...budget, level: "soft", spent: 0.8, sessionID: "ses_task" },
        { ...budget, level: "hard", spent: 1.05, sessionID: "ses_task" },
        { ...budget, scope: "day", name: "today", unit: "tokens", limit: 5000, level: "hard", spent: 5200, sessionID: "ses_chat" },
        // Nowhere to open: nothing to push.
        { ...budget, level: "hard", spent: 2 },
      ]),
      onNotification: (notification) => seen.push(notification),
    })
    await Bun.sleep(30)
    watcher.stop()

    expect(seen).toEqual([
      { kind: "budget-warning", sessionID: "ses_task", session: "review", detail: "$0.80 of $1.00" },
      { kind: "budget", sessionID: "ses_task", session: "review", detail: "$1.05 of $1.00" },
      { kind: "budget", sessionID: "ses_chat", session: "today", detail: "5200 tokens of 5000 tokens" },
    ])
  })
})

/** A fake engine: one session to name, and one event stream that ends as soon as it is read. */
const engine = (events: unknown[]) =>
  ((url: string | URL | Request) => {
    const path = new URL(String(url)).pathname
    if (path === "/api/session/ses_1")
      return Promise.resolve(new Response(JSON.stringify({ data: { title: "Fix the build" } }), { status: 200 }))
    if (path === "/api/event") return Promise.resolve(new Response(sse(events), { status: 200 }))
    return Promise.resolve(new Response("", { status: 404 }))
  }) as unknown as typeof globalThis.fetch

describe("watchEngineEvents", () => {
  test("an OpenCode 2 engine's permission, form, finished and failed runs are reported", async () => {
    const seen: Seen[] = []
    const watcher = watchEngineEvents({
      engine: "http://e",
      fetch: engine([
        {
          type: "permission.asked",
          data: { id: "per_1", sessionID: "ses_1", action: "shell", resources: ["rm -rf dist"] },
        },
        {
          type: "form.created",
          data: {
            form: {
              id: "frm_1",
              sessionID: "ses_1",
              title: "Question",
              fields: [{ key: "q0", title: "Which branch?" }],
            },
          },
        },
        { type: "session.execution.succeeded", data: { sessionID: "ses_1" } },
        { type: "session.execution.interrupted", data: { sessionID: "ses_1" } },
        { type: "session.execution.failed", data: { sessionID: "ses_1", error: { type: "unknown", message: "boom" } } },
      ]),
      onNotification: (notification) => seen.push(notification),
    })
    await Bun.sleep(30)
    watcher.stop()

    expect(seen).toEqual([
      { kind: "permission", sessionID: "ses_1", session: "Fix the build", detail: "shell: rm -rf dist" },
      { kind: "question", sessionID: "ses_1", session: "Fix the build", detail: "Which branch?" },
      { kind: "finished", sessionID: "ses_1", session: "Fix the build" },
      { kind: "failed", sessionID: "ses_1", session: "Fix the build" },
    ])
  })
})
