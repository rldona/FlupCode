import { expect, test } from "@playwright/test"

const now = Date.now()

const session = {
  id: "ses_x",
  projectID: "p",
  title: "Work",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: now, updated: now },
  location: { directory: "/work/demo" },
}

const run = {
  id: "run_1",
  source: { type: "manual" },
  status: "running",
  startedAt: now,
  sessionID: "ses_root",
  // A run that refused the shell: unusual, so the card says it (H-47).
  shell: false,
}

const tasks = [
  { id: "t1", runID: "run_1", position: 0, name: "plan it", prompt: "p", status: "success", startedAt: now, finishedAt: now + 4000, agent: "plan", sessionID: "ses_a" },
  { id: "t2", runID: "run_1", position: 1, name: "build it", prompt: "b", status: "running", startedAt: now + 4000 },
]

const noTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
const spent = {
  events: 2,
  tokens: { ...noTokens, input: 2000, output: 400 },
  money: [{ basis: "engine-list-price", billing: "metered", usd: 0.0043, events: 2 }],
  unpriced: { events: 0, tokens: noTokens },
}
const ledger = {
  runID: "run_1",
  total: spent,
  byTask: [{ ...spent, key: "t2", fields: { taskID: "t2", runID: "run_1", attempt: 1 } }],
  byPurpose: [{ ...spent, key: "run-task", fields: { purpose: "run-task" } }],
  byAgent: [],
  byModel: [],
}

// The supervisor reads the list once and follows the stream after that. A task that changes while
// someone is looking must move on screen without the list being asked for again — that is the whole
// difference between this and the five-second poll it replaced.
test("a run and its tasks are shown, and a task moves when the server says so", async ({ page }) => {
  let listReads = 0

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") {
      listReads++
      return route.fulfill({ json: { data: [run] } })
    }
    if (url.pathname === "/harness/runs/run_1/tasks") return route.fulfill({ json: { data: tasks } })
    // What the run spent, from the ledger (UL-06): only the second task had a priced step.
    if (url.pathname === "/harness/usage/runs/run_1") return route.fulfill({ json: { data: ledger } })
    if (url.pathname === "/harness/events") {
      // Held open after one event: the second task finishes while the reader is watching.
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body:
          `id: 1\ndata: ${JSON.stringify({
            type: "task.changed",
            task: { ...tasks[1], status: "success", finishedAt: now + 9000, tokens: 2400, cost: 0.0043 },
          })}\n\n`,
      })
    }
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  // The nav item carries an icon in its label, so the name is matched loosely.
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  const run1 = page.locator(".fc-run-card")
  await expect(run1).toHaveCount(1)
  await expect(run1.locator(".fc-run-node")).toHaveCount(2)
  await expect(run1.locator(".fc-run-node-name").first()).toHaveText("plan it")

  // What the run was allowed to do: no shell is unusual, so it is stated (H-47).
  await expect(run1.locator(".fc-run-rules")).toContainText("No shell commands")

  // The event moved its node on the graph (UX-04).
  const second = run1.locator(".fc-run-node").nth(1)
  await expect(second).toHaveAttribute("data-state", "succeeded", { timeout: 15_000 })

  // The run's header says how far it got, and its cost is the ledger's run total (UL-06). A small
  // cost reads as what it is, not as $0.00 (TI-05), and as an estimate at list price.
  await expect(run1.locator(".fc-run-head .fc-run-meta")).toContainText("2/2")
  await expect(run1.locator(".fc-run-head .fc-cost-figure")).toHaveText("~$0.0043")
  // One cost on the card: a task's is in its detail, drawn by the same figure, the same string.
  await expect(run1.locator(".fc-cost")).toHaveCount(1)
  await second.click()
  const detail = page.getByRole("complementary", { name: /Task detail|Detalle/ })
  await expect(detail).toContainText("2.4k tokens")
  await expect(detail.locator(".fc-cost-figure")).toHaveText("~$0.0043")
  await detail.getByRole("button", { name: /^(Close|Cerrar)$/ }).click()
  // A task the ledger has nothing for carries a dash rather than a $0.
  await run1.locator(".fc-run-node").first().click()
  await expect(detail.locator(".fc-cost-unknown")).toHaveCount(1)

  // And nothing was re-read to learn it.
  expect(listReads).toBeLessThanOrEqual(2)
})

// UX-04: the run on its workflow's graph. Tasks that can run together share a column, and a task the
// graph skipped is drawn where it would have run, as skipped.
test("the graph draws parallel tasks in one column, and a skipped one as skipped", async ({ page }) => {
  const parallelRun = { id: "run_p", source: { type: "manual" }, status: "success", startedAt: now, finishedAt: now + 6000 }
  const parallelTasks = [
    { id: "p1", runID: "run_p", position: 0, name: "left", prompt: "l", status: "success", startedAt: now, finishedAt: now + 4000, dependsOn: [] },
    { id: "p2", runID: "run_p", position: 1, name: "right", prompt: "r", status: "success", startedAt: now + 1000, finishedAt: now + 5000, dependsOn: [] },
    { id: "p3", runID: "run_p", position: 2, name: "ship", prompt: "s", status: "skipped", error: "Not run: right did not succeed", dependsOn: ["right"] },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [parallelRun] } })
    if (url.pathname === "/harness/runs/run_p/tasks") return route.fulfill({ json: { data: parallelTasks } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  const graph = page.locator(".fc-run-card .fc-run-graph")
  await expect(graph).toHaveCount(1)
  const nodes = graph.locator(".fc-run-node")
  await expect(nodes).toHaveCount(3)
  const left = async (index: number) => (await nodes.nth(index).boundingBox())!.x
  // The two roots share the first column; what waited for one of them is to their right.
  expect(await left(0)).toBe(await left(1))
  expect(await left(2)).toBeGreaterThan(await left(1))
  await expect(graph.locator(".fc-workflow-edge")).toHaveCount(1)
  // Skipped is its state, with the reason as its tooltip.
  await expect(nodes.nth(2)).toHaveAttribute("data-state", "skipped")
  await expect(nodes.nth(2)).toHaveAttribute("title", /Not run: right did not succeed/)
})

// A finished run can be forgotten from the list it clutters, and the question is asked inside the
// card: the list scrolls, and a confirmation at the foot of it is one nobody sees.
test("a finished run is deleted after confirming, and a running one offers Stop instead", async ({ page }) => {
  const deleted: string[] = []
  const stopped: string[] = []
  const done = { ...run, id: "run_2", status: "success", finishedAt: now + 9000, sessionID: "ses_done" }

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs" && method === "GET") return route.fulfill({ json: { data: [run, done] } })
    if (/^\/harness\/runs\/[^/]+\/stop$/.test(url.pathname) && method === "POST") {
      stopped.push(url.pathname.split("/")[3]!)
      // The server answers once the engine was interrupted; the run is reported stopped later.
      return route.fulfill({ json: { data: run } })
    }
    if (/^\/harness\/runs\/[^/]+$/.test(url.pathname) && method === "DELETE") {
      deleted.push(url.pathname.split("/").pop()!)
      return route.fulfill({ json: { data: true } })
    }
    if (/^\/harness\/runs\/[^/]+\/tasks$/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  const cards = page.locator(".fc-run-card")
  await expect(cards).toHaveCount(2)

  // The one still going cannot be deleted — the server would refuse — so it offers Stop.
  const running = cards.first()
  await expect(running.getByRole("button", { name: /^(Stop|Detener)$/ })).toBeVisible()
  await expect(running.getByRole("button", { name: /^(Delete|Eliminar)$/ })).toHaveCount(0)
  await running.getByRole("button", { name: /^(Stop|Detener)$/ }).click()
  await expect.poll(() => stopped).toEqual(["run_1"])
  // Until the run is reported stopped, the card says it is stopping rather than offering Stop again.
  await expect(running.getByRole("button", { name: /^(Stopping…|Deteniendo…)$/ })).toBeDisabled()

  // The finished one asks first, where the eye already is, and then goes.
  const finished = cards.nth(1)
  await finished.getByRole("button", { name: /^(Delete|Eliminar)$/ }).click()
  const confirm = finished.getByText(/Delete this run\?|¿Eliminar esta ejecución\?/)
  await expect(confirm).toBeInViewport()
  await finished.getByRole("button", { name: /^(Delete|Eliminar)$/ }).last().click()
  await expect.poll(() => deleted).toEqual(["run_2"])
  await expect(page.locator(".fc-run-card")).toHaveCount(1)
})

// Clearing the whole list is one request, not one per run, and the run still going survives it.
test("the header clears every finished run in one request", async ({ page }) => {
  let cleared = 0
  let stoppedAll = 0
  const done = { ...run, id: "run_2", status: "success", finishedAt: now + 9000 }

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs" && method === "GET") return route.fulfill({ json: { data: [run, done] } })
    if (url.pathname === "/harness/runs" && method === "DELETE") {
      cleared++
      return route.fulfill({ json: { data: { removed: 1 } } })
    }
    if (url.pathname === "/harness/runs/stop" && method === "POST") {
      stoppedAll++
      return route.fulfill({ json: { data: { stopped: 1 } } })
    }
    if (/^\/harness\/runs\/[^/]+\/tasks$/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()
  await expect(page.locator(".fc-run-card")).toHaveCount(2)

  await page.getByRole("button", { name: /Clear finished|Limpiar terminadas/ }).click()
  const confirm = page.getByText(/Delete every finished run\?|¿Eliminar todas las ejecuciones terminadas\?/)
  await expect(confirm).toBeInViewport()
  await page.locator(".fc-confirm-inline").getByRole("button", { name: /^(Delete|Eliminar)$/ }).click()

  // Stopping everything is its own button, and it asks first: it interrupts work that is paid for.
  await page.getByRole("button", { name: /Stop all|Detener todas/ }).click()
  const stopQuestion = page.getByText(/Stop every run that is going\?|¿Detener todas las ejecuciones en curso\?/)
  await expect(stopQuestion).toBeInViewport()
  await page.locator(".fc-confirm-inline").getByRole("button", { name: /^(Stop|Detener)$/ }).click()
  await expect.poll(() => stoppedAll).toBe(1)

  await expect.poll(() => cleared).toBe(1)
  // The one still going is not history, so it stays, and the header stops offering the clear-out.
  await expect(page.locator(".fc-run-card")).toHaveCount(1)
  await expect(page.getByRole("button", { name: /Clear finished|Limpiar terminadas/ })).toHaveCount(0)
})

// H-22: a verify task is the harness checking the work, so the supervisor shows what it checked and
// what the commands printed — a run that says "success" because a model stopped talking is not
// evidence of anything.
test("a verify task says so on its node, and its evidence is in its detail", async ({ page }) => {
  const failed = {
    id: "run_v",
    source: { type: "manual" },
    status: "failed",
    startedAt: now,
    finishedAt: now + 5000,
    error: "Verification failed: test",
  }
  const verifyTasks = [
    {
      id: "v1",
      runID: "run_v",
      position: 0,
      name: "verify",
      prompt: "",
      kind: "verify",
      status: "failed",
      startedAt: now,
      finishedAt: now + 5000,
      error: "Verification failed: test",
      output: "Verification: failed\n\n- typecheck (bun run typecheck) — ok, 2.0s\n- test (bun test) — exit 1, 3.0s\n\n### test\n```\nexpected 1, got 2\n```",
    },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [failed] } })
    if (url.pathname === "/harness/runs/run_v/tasks") return route.fulfill({ json: { data: verifyTasks } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  const task = page.locator(".fc-run-node")
  await expect(task).toHaveCount(1)
  await expect(task).toHaveAttribute("data-state", "failed")
  // It says it was the harness that ran, not an agent.
  await expect(task.locator(".fc-run-node-fact")).toContainText(/verify|verificación/)

  // The evidence is in its detail, one click from the node (UX-04).
  await task.click()
  const evidence = page.locator(".fc-run-detail .fc-run-detail-pre")
  await expect(evidence).toContainText("expected 1, got 2")
  await expect(evidence).toContainText("- test (bun test) — exit 1")
})

// RP-06: each task carries a verdict from something other than the agent, and the run its worst
// one. "Not verified" must not read as a quieter "Verified", and a give-up is read in the agent's words.
test("a task's verdict is its node's state, and the run's is its worst task's, said once", async ({ page }) => {
  const judged = {
    id: "run_j",
    source: { type: "routine", routineID: "nightly" },
    status: "success",
    startedAt: now,
    finishedAt: now + 5000,
    verdict: { value: "failed", reason: "I cannot do this without the API key, so I stop here.", source: "rule", taskID: "j1" },
  }
  const judgedTasks = [
    { id: "j1", runID: "run_j", position: 0, name: "fix", prompt: "f", status: "success", startedAt: now, finishedAt: now + 1000, verdict: { value: "failed", reason: "I cannot do this without the API key, so I stop here.", source: "rule" } },
    { id: "j2", runID: "run_j", position: 1, name: "build", prompt: "b", status: "success", startedAt: now, finishedAt: now + 1000, verdict: { value: "verified", reason: "Verification passed: test", source: "check" } },
    { id: "j3", runID: "run_j", position: 2, name: "notes", prompt: "n", status: "success", startedAt: now, finishedAt: now + 1000, verdict: { value: "unverified", reason: "Nothing checked this answer", source: "rule" } },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [judged] } })
    if (url.pathname === "/harness/runs/run_j/tasks") return route.fulfill({ json: { data: judgedTasks } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  // The run says how it ended once: its verdict, not "success" beside it (UX-04), and why.
  const card = page.locator(".fc-run-card")
  await expect(card.locator(".fc-run-head .fc-verdict")).toHaveAttribute("data-verdict", "failed")
  await expect(card.locator(".fc-run-head")).not.toContainText("success")
  await expect(card.locator(".fc-verdict-reason")).toHaveText("I cannot do this without the API key, so I stop here.")
  await expect(card.locator(".fc-verdict-reason")).toHaveCount(1)
  // Each task's verdict is its node's state, with the word as its name and the reason as its tooltip.
  const tasks = card.locator(".fc-run-node")
  await expect(tasks).toHaveCount(3)
  await expect(tasks.nth(0)).toHaveAttribute("data-state", "failed")
  await expect(tasks.nth(0)).toHaveAccessibleName(/Failed|Fallida/)
  await expect(tasks.nth(1)).toHaveAttribute("data-state", "verified")
  await expect(tasks.nth(2)).toHaveAttribute("data-state", "unverified")
  await expect(tasks.nth(2)).toHaveAttribute("title", /Not verified|Sin verificar/)
  // Drawn apart: an outline, not a paler fill.
  const style = (index: number) =>
    tasks.nth(index).evaluate((node) => {
      const computed = getComputedStyle(node)
      return { border: computed.borderTopStyle, background: computed.backgroundColor }
    })
  expect((await style(2)).border).toBe("dashed")
  expect((await style(1)).border).not.toBe("dashed")
  expect((await style(1)).background).not.toBe((await style(2)).background)

  await tasks.nth(0).click()
  const detail = page.getByRole("complementary", { name: /Task detail|Detalle/ })
  await expect(detail).toContainText("I cannot do this without the API key, so I stop here.")
  await expect(detail).toContainText(/Judged by a rule over the agent's answer|Lo decidió una regla/)
})

// H-38: a task another CLI ran says so, and the command it ran and what it printed are what there is
// to read — there is no session to open and no model to switch.
test("an external task shows its command and what it printed", async ({ page }) => {
  const external = {
    id: "run_x",
    source: { type: "manual" },
    status: "success",
    startedAt: now,
    finishedAt: now + 5000,
  }
  const externalTasks = [
    {
      id: "x1",
      runID: "run_x",
      position: 0,
      name: "codex",
      prompt: "do it",
      kind: "external",
      command: "codex exec {{prompt}}",
      status: "success",
      startedAt: now,
      finishedAt: now + 5000,
      output: "done: 2 files changed",
    },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [external] } })
    if (url.pathname === "/harness/runs/run_x/tasks") return route.fulfill({ json: { data: externalTasks } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  const task = page.locator(".fc-run-node")
  await expect(task).toHaveCount(1)
  // It says who executed, not that an agent did.
  await expect(task.locator(".fc-run-node-fact")).toContainText(/external|externo/)

  await task.click()
  const detail = page.locator(".fc-run-detail")
  // The detail opens as a dialog now, not as a column beside the task list.
  await expect(page.locator('[role="dialog"] .fc-run-detail')).toHaveCount(1)
  await expect(detail).toContainText("codex exec {{prompt}}")
  await expect(detail).toContainText("done: 2 files changed")
  // A check or a vendor CLI has no model to choose for a retry.
  await expect(detail.locator(".fc-run-detail-model")).toHaveCount(0)
})

// H-21's human gate: a run stopped on purpose is not finished and not running. It offers the two
// answers there are — let it through, or stop it — and it is not something Clear finished can take.
test("a run waiting at a gate offers Approve, and is not cleared away", async ({ page }) => {
  let approved = ""
  const waiting = { ...run, id: "run_g", status: "awaiting" }

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs" && method === "GET") return route.fulfill({ json: { data: [waiting] } })
    if (/^\/harness\/runs\/[^/]+\/approve$/.test(url.pathname) && method === "POST") {
      approved = url.pathname.split("/")[3]!
      return route.fulfill({ json: { data: { ...waiting, status: "running" } } })
    }
    if (/^\/harness\/runs\/[^/]+\/tasks$/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  const card = page.locator(".fc-run-card")
  await expect(card).toHaveCount(1)
  // Not finished: there is nothing to delete and nothing for Clear finished to take.
  await expect(card.getByRole("button", { name: /^(Delete|Eliminar)$/ })).toHaveCount(0)
  await expect(page.getByRole("button", { name: /Clear finished|Limpiar terminadas/ })).toHaveCount(0)
  // The two answers there are.
  await expect(card.getByRole("button", { name: /^(Stop|Detener)$/ })).toBeVisible()
  await card.getByRole("button", { name: /Approve|Aprobar/ }).click()
  await expect.poll(() => approved).toBe("run_g")
})

// H-21's launcher: a workflow is a command. Typing it in the composer starts a run with what came
// after the name, and drops you where you can watch it.
test("a workflow is listed with the commands and launched from the composer", async ({ page }) => {
  let started: { name?: string; body?: unknown } = {}
  const workflow = {
    name: "feature",
    description: "Plan a feature, build it, and check it still works",
    inputs: ["goal"],
    tasks: [{ id: "plan", agent: "plan", gate: "human" }, { id: "verify", kind: "verify" }],
  }

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [workflow] } })
    if (/^\/harness\/workflows\/[^/]+\/runs$/.test(url.pathname)) {
      started = { name: url.pathname.split("/")[3], body: route.request().postDataJSON() }
      return route.fulfill({ json: { data: { id: "run_w", source: { type: "manual" }, status: "running", startedAt: now } } })
    }
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/")

  const input = page.locator(".fc-composer textarea.fc-input")
  await input.fill("/feature")
  // It is in the same list as everything else — that is what "unified launcher" means.
  const menu = page.locator(".fc-command-menu")
  await expect(menu).toBeVisible()
  await expect(menu).toContainText("/feature")
  await expect(menu).toContainText("Plan a feature")

  await input.fill("/feature add search to the sidebar")
  await input.press("Enter")

  await expect.poll(() => started.name).toBe("feature")
  // Everything after the name fills its first input.
  expect(started.body).toMatchObject({ inputs: { goal: "add search to the sidebar" } })
  // And it leaves you where the run can be watched.
  await expect(page).toHaveURL(/\/runs$/)
})

// H-14: what the runs left behind, where it can be read. The panel this replaces listed the files
// the session had touched and called them artifacts; that list is still here, under its own name.
test("artifacts are listed by kind, read in place, and the session's files keep their own heading", async ({ page }) => {
  let removed = ""
  const artifacts = [
    {
      id: "a1",
      kind: "verdict",
      title: "verify — failed",
      producer: "harness",
      mime: "text/markdown",
      createdAt: now,
      runID: "run_1",
      content: "Verification: failed\n\n- test (bun test) — exit 1",
    },
    {
      id: "a2",
      kind: "report",
      title: "Run not verified",
      producer: "harness",
      mime: "text/markdown",
      createdAt: now - 1000,
      content: "Run not verified in 4s",
    },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
    window.localStorage.setItem("flupcode.selectedSession", JSON.stringify("ses_x"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [session], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/session/status") return route.fulfill({ json: {} })
    if (/^\/api\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: { data: [], cursor: {} } })
    if (/^\/session\/[^/]+\/message/.test(url.pathname)) return route.fulfill({ json: [] })
    if (/^\/api\/session\/[^/]+\/(permission|question)/.test(url.pathname)) return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/permission" || url.pathname === "/question") return route.fulfill({ json: [] })
    if (url.pathname === "/api/permission/request") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/workflows") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/artifacts") return route.fulfill({ json: { data: artifacts } })
    if (/^\/harness\/artifacts\/[^/]+$/.test(url.pathname) && route.request().method() === "DELETE") {
      removed = url.pathname.split("/").pop()!
      return route.fulfill({ json: { data: true } })
    }
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.goto("/artifacts")

  const cards = page.locator(".fc-artifact-card")
  await expect(cards).toHaveCount(2)
  // It is not a list of file paths any more.
  await expect(cards.first()).toContainText("verify — failed")

  // Read in place: the artifact fills the panel, and the arrow comes back to the list.
  await cards.first().locator(".fc-artifact-card-main").click()
  await expect(page.locator(".fc-artifact-viewer-title")).toContainText("verify — failed")
  await expect(page.locator(".fc-artifact-markdown")).toContainText("exit 1")
  await page.locator(".fc-artifact-viewer-bar").getByRole("button", { name: /^(Back|Atrás)$/ }).click()
  await expect(page.locator(".fc-artifact-viewer")).toHaveCount(0)

  // Filtering by kind narrows the list.
  await page.locator(".fc-artifact-kinds").getByRole("button", { name: /^(report|informe)$/ }).click()
  await expect(page.locator(".fc-artifact-card")).toHaveCount(1)
  await expect(page.locator(".fc-artifact-card")).toContainText("Run not verified")

  await page.locator(".fc-artifact-kinds").getByRole("button", { name: /^(All|Todo)$/ }).click()
  await page
    .locator(".fc-artifact-card")
    .first()
    .locator(".fc-artifact-card-actions")
    .getByRole("button", { name: /^(Delete|Eliminar)$/ })
    .click()
  await expect.poll(() => removed).toBe("a1")

  // The files this session wrote are their own tab, with their own search.
  await page.getByRole("button", { name: /Files this session wrote/ }).click()
  await expect(page.locator(".fc-artifact-kinds")).toHaveCount(0)
})

// H-32's noted gap: a task that ran in its own worktree has its points, its diff and its
// checkpoints anchored to that tree (H-29), so "Checkpoints" has to open the tree it ran in and not
// the run's folder — which is where the findings would never show.
test("a worktree task opens the tree it ran in", async ({ page }) => {
  const worktreeRun = {
    id: "run_w",
    source: { type: "manual" },
    status: "success",
    startedAt: now,
    finishedAt: now + 5000,
    directory: "/work/demo",
  }
  const worktreeTasks = [
    {
      id: "w1",
      runID: "run_w",
      position: 0,
      name: "review",
      prompt: "review it",
      status: "success",
      startedAt: now,
      finishedAt: now + 5000,
      directory: "/work/.flupcode/wt/review",
    },
  ]
  const worktreeFiles = [
    { taskID: "w1", checkpointID: "c1", title: "review", files: [{ path: "src/a.ts", status: "modified" }] },
  ]

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/model") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/vcs/diff") return route.fulfill({ json: [] })
    if (url.pathname === "/api/event" || url.pathname === "/event")
      return route.fulfill({ headers: { "content-type": "text/event-stream" }, body: "" })
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [worktreeRun] } })
    if (url.pathname === "/harness/runs/run_w/tasks") return route.fulfill({ json: { data: worktreeTasks } })
    if (url.pathname === "/harness/runs/run_w/files") return route.fulfill({ json: { data: worktreeFiles } })
    if (url.pathname === "/harness/events") return new Promise(() => {})
    return route.fulfill({ json: { data: [] } })
  })
  await page.goto("/")
  await page.getByRole("button", { name: /Runs|Ejecuciones/ }).click()

  // The run's footer opens its points, in the tree they were taken in (UX-04).
  await expect(page.locator(".fc-run-node")).toHaveCount(1)
  await page.locator(".fc-run-foot").getByRole("button", { name: /Checkpoints|Puntos de retorno/ }).click()

  // The Changes screen opened for the worktree folder, not for the run's: the kicker names it.
  await expect(page.locator(".fc-routines-kicker").first()).toHaveText("review")
})

// UX-04: a run card reads as one thing. A running workflow shows each task's state on the workflow's
// graph and moves as the server's task events arrive; the card says its name, how it stands and what
// it cost once each; and a routine's one task does not repeat the routine's name.
test("a running workflow's graph shows each task's state, and no label repeats on a card", async ({ page }) => {
  const workflow = { name: "ship", scope: "project", hash: "h", inputs: { goal: "add a lexer cache" } }
  const going = { id: "run_s", source: { type: "manual" }, workflow, status: "running", startedAt: now, sessionID: "ses_s", directory: "/work/demo" }
  const unverified = { value: "unverified", reason: "Nothing checked this answer", source: "rule" }
  const shipTasks = [
    { id: "s1", runID: "run_s", position: 0, name: "plan", prompt: "p", status: "success", startedAt: now, finishedAt: now + 1000, agent: "plan", verdict: unverified },
    { id: "s2", runID: "run_s", position: 1, name: "build", prompt: "b", status: "running", startedAt: now + 1000, agent: "build" },
    { id: "s3", runID: "run_s", position: 2, name: "docs", prompt: "d", status: "queued", dependsOn: ["plan"] },
    { id: "s4", runID: "run_s", position: 3, name: "check", prompt: "", kind: "verify", status: "queued", dependsOn: ["build", "docs"] },
  ]
  const routineRun = { id: "run_r", source: { type: "routine", routineID: "rt_1" }, status: "success", startedAt: now - 60_000, finishedAt: now - 59_000, verdict: { ...unverified, taskID: "r1" } }
  const routineTasks = [
    { id: "r1", runID: "run_r", position: 0, name: "Nightly parser fix", prompt: "f", status: "success", startedAt: now - 60_000, finishedAt: now - 59_000, verdict: unverified },
  ]
  const routine = { id: "rt_1", name: "Nightly parser fix", description: "", prompt: "f", enabled: true, schedule: { type: "manual" }, createdAt: now, runs: [] }
  const points = [{ taskID: "s1", checkpointID: "cp1", title: "plan", summary: "Two steps.", files: [{ path: "PLAN.md", status: "added" }] }]
  const left = [
    { id: "a1", kind: "handoff", title: "plan — handoff", producer: "harness", mime: "text/markdown", createdAt: now, runID: "run_s", taskID: "s1" },
    { id: "a2", kind: "verdict", title: "plan — unverified", producer: "harness", mime: "text/markdown", createdAt: now, runID: "run_s", taskID: "s1" },
  ]
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => (release = resolve))

  await page.addInitScript(() => {
    window.localStorage.setItem("flupcode.onboarded", JSON.stringify(true))
    window.localStorage.setItem("flupcode.serverUrl", JSON.stringify("http://127.0.0.1:9"))
    window.localStorage.setItem("flupcode.harnessServerUrl", JSON.stringify("http://127.0.0.1:9097"))
  })
  await page.route("http://127.0.0.1:9/**", (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/api/info") return route.fulfill({ json: { version: "e2e" } })
    if (url.pathname === "/api/session") return route.fulfill({ json: { data: [], cursor: {} } })
    if (url.pathname === "/api/session/active") return route.fulfill({ json: { data: {} } })
    if (url.pathname === "/api/event" || url.pathname === "/event") return new Promise(() => {})
    return route.fulfill({ status: 404, json: {} })
  })
  await page.route("http://127.0.0.1:9097/**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === "/harness/routines") return route.fulfill({ json: { data: [routine] } })
    if (url.pathname === "/harness/runs") return route.fulfill({ json: { data: [going, routineRun] } })
    if (url.pathname === "/harness/runs/run_s/tasks") return route.fulfill({ json: { data: shipTasks } })
    if (url.pathname === "/harness/runs/run_r/tasks") return route.fulfill({ json: { data: routineTasks } })
    if (url.pathname === "/harness/runs/run_s/files") return route.fulfill({ json: { data: points } })
    if (url.pathname === "/harness/artifacts" && url.searchParams.get("runID") === "run_s") return route.fulfill({ json: { data: left } })
    if (url.pathname === "/harness/events") {
      // Held until the test has read the run as it was: then build fails its verdict and docs starts.
      await held
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body: [
          { type: "task.changed", task: { ...shipTasks[1], status: "success", finishedAt: now + 5000, verdict: { value: "failed", reason: "I cannot do this, so I stop here.", source: "rule" } } },
          { type: "task.changed", task: { ...shipTasks[2], status: "running", startedAt: now + 5000 } },
        ]
          .map((event, index) => `id: ${index + 1}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
      })
    }
    return route.fulfill({ json: { data: [] } })
  })
  await page.goto("/runs")

  const card = page.locator(".fc-run-card").filter({ hasText: "goal: add a lexer cache" })
  const node = (name: string) => card.locator(".fc-run-node").filter({ has: page.locator(".fc-run-node-name", { hasText: new RegExp(`^${name}$`) }) })
  await expect(card.locator(".fc-run-node")).toHaveCount(4)
  await expect(node("plan")).toHaveAttribute("data-state", "unverified")
  await expect(node("build")).toHaveAttribute("data-state", "running")
  await expect(node("docs")).toHaveAttribute("data-state", "queued")
  await expect(node("check")).toHaveAttribute("data-state", "queued")
  await expect(card.locator(".fc-run-head .fc-verdict")).toHaveAttribute("data-verdict", "running")
  await expect(card.locator(".fc-run-head .fc-run-meta")).toContainText("1/4")

  // The events move the nodes, nothing else asked.
  release()
  await expect(node("build")).toHaveAttribute("data-state", "failed")
  await expect(node("docs")).toHaveAttribute("data-state", "running")
  await expect(card.locator(".fc-run-head .fc-run-meta")).toContainText("2/4")

  // What it left behind is its footer: its checkpoints, the files they changed and its artifacts.
  const foot = card.locator(".fc-run-foot")
  await expect(foot.getByRole("button", { name: /Checkpoints|Puntos de retorno/ })).toContainText("1")
  await expect(foot.locator(".fc-run-files summary")).toHaveText(/1 files|1 archivos/)
  await expect(foot.locator(".fc-artifact-kind")).toHaveText([/handoff|traspaso/, /verdict|veredicto/])

  // No label repeats within a card: its name, its state, its tasks and what it left are each said once.
  const labels = async (scope: typeof card) =>
    (
      await scope
        .locator(".fc-run-title, .fc-run-head .fc-verdict, .fc-run-node-name, .fc-run-foot .fc-artifact-kind, .fc-run-foot button, .fc-run-artifacts > .fc-run-meta")
        .allTextContents()
    ).map((text) => text.replace(/\d+$/, "").trim().toLowerCase())
  const shipLabels = await labels(card)
  expect(shipLabels).toContain("ship")
  expect(new Set(shipLabels).size).toBe(shipLabels.length)

  // A routine's run is named after the routine, and its one task by what does it, not that name again.
  const routineCard = page.locator(".fc-run-card").filter({ hasText: "Nightly parser fix" })
  await expect(routineCard.locator(".fc-run-title")).toHaveText("Nightly parser fix")
  await expect(routineCard.locator(".fc-run-node-name")).toHaveText(/^(Task|Tarea)$/)
  const routineLabels = await labels(routineCard)
  expect(new Set(routineLabels).size).toBe(routineLabels.length)
  await expect(routineCard.getByText("Nightly parser fix")).toHaveCount(1)
})
