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
}

const tasks = [
  { id: "t1", runID: "run_1", position: 0, name: "plan it", prompt: "p", status: "success", startedAt: now, finishedAt: now + 4000, agent: "plan", sessionID: "ses_a" },
  { id: "t2", runID: "run_1", position: 1, name: "build it", prompt: "b", status: "running", startedAt: now + 4000 },
]

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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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
    if (url.pathname === "/harness/events") {
      // Held open after one event: the second task finishes while the reader is watching.
      return route.fulfill({
        headers: { "content-type": "text/event-stream" },
        body:
          `id: 1\ndata: ${JSON.stringify({
            type: "task.changed",
            task: { ...tasks[1], status: "success", finishedAt: now + 9000, tokens: 2400, cost: 0.12 },
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
  await expect(run1.locator(".fc-run-task")).toHaveCount(2)
  await expect(run1.getByText("plan it")).toBeVisible()

  // The event moved it: the task shows what it cost, which only the event carried.
  const second = run1.locator(".fc-run-task").nth(1)
  await expect(second.locator(".fc-run-meta")).toContainText("2.4k", { timeout: 15_000 })
  await expect(second.locator(".fc-run-meta")).toContainText("$0.12")

  // The run's header adds its tasks up: the report of what it did, where there is room for it.
  await expect(run1.locator(".fc-run-head .fc-run-meta")).toContainText("2/2")
  await expect(run1.locator(".fc-run-head .fc-run-meta")).toContainText("2.4k")

  // And nothing was re-read to learn it.
  expect(listReads).toBeLessThanOrEqual(2)
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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
      return route.fulfill({ json: { data: { ...run, status: "stopped" } } })
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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
test("a verify task shows its evidence, open when it failed", async ({ page }) => {
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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

  const task = page.locator(".fc-run-task")
  await expect(task).toHaveCount(1)
  // It says it was the harness that ran, not an agent.
  await expect(task.locator(".fc-run-meta")).toContainText(/verify|verificación/)

  // A failure is read, not clicked open: the evidence is already unfolded.
  const evidence = task.locator(".fc-run-evidence")
  await expect(evidence).toHaveAttribute("open", "")
  await expect(evidence.locator("pre")).toContainText("expected 1, got 2")
  await expect(evidence.locator("pre")).toContainText("- test (bun test) — exit 1")
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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
      title: "Run success",
      producer: "harness",
      mime: "text/markdown",
      createdAt: now - 1000,
      content: "Run success in 4s",
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
    if (url.pathname.endsWith("/health")) return route.fulfill({ json: { healthy: true, version: "e2e" } })
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

  const cards = page.locator(".fc-run-card")
  await expect(cards).toHaveCount(2)
  // It is not a list of file paths any more.
  await expect(cards.first()).toContainText("verify — failed")

  // Read in place: the evidence is the point, not a link to it.
  await expect(page.locator(".fc-artifact-body")).toHaveCount(0)
  await cards.first().getByRole("button", { name: /Read|Leer/ }).click()
  await expect(page.locator(".fc-artifact-body")).toContainText("- test (bun test) — exit 1")

  // Filtering by kind narrows the list.
  await page.getByRole("button", { name: /^(report|informe)$/ }).click()
  await expect(page.locator(".fc-run-card")).toHaveCount(1)
  await expect(page.locator(".fc-run-card")).toContainText("Run success")

  await page.getByRole("button", { name: /^(All|Todo)$/ }).click()
  await page.locator(".fc-run-card").first().getByRole("button", { name: /^(Delete|Eliminar)$/ }).click()
  await expect.poll(() => removed).toBe("a1")
})
