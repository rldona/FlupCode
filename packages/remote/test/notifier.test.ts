import { describe, expect, test } from "bun:test"
import { watchHarnessEvents } from "../src/notifier"

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
})
