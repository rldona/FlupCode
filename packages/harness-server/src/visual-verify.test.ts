import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBrowserPolicy } from "./browser-policy"
import { createPreview } from "./browser-preview"
import { fakeDesktop } from "./browser-preview.fixture"
import { encodePng, type Image } from "./png"
import { SqliteRoutineRepository } from "./repository"
import { TaskRunner } from "./runner"
import type { RunSource, VisualResult } from "./types"
import { createVisualCheck, readVisualCheck, visualVerdict, type VisualRunner } from "./visual-verify"
import { explainWorkflow, tasksFor } from "./workflow"

/**
 * A verify task that looks at the page (CL-4): its grammar in a workflow, its verdict, and runs of it
 * against the desktop's preview. The desktop is `fakeDesktop`, which answers what the real main
 * process answers; the driver, the policy, the comparison, the store and the runner are real.
 */

const scratch: string[] = []
const repositories: SqliteRoutineRepository[] = []
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()))
afterAll(() => scratch.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })))

const folder = (prefix: string) => {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(directory)
  return directory
}

const WORKFLOW = `name: ui
tasks:
  - id: look
    kind: verify
    visual:
      url: http://localhost:5173/
      steps:
        - waitFor: "#app"
        - assert: { selector: "#app", text: "Dev app" }
        - screenshot: home
      mask: [".clock"]
      tolerance: 0.5%
      settle: { captures: 3, interval: 0ms }
`

describe("a visual verify task in a workflow (CL-4)", () => {
  test("the block reads into the task, with its defaults, and the task carries it into the run", () => {
    const read = explainWorkflow(WORKFLOW, "ui")
    if (!read.ok) throw new Error(read.problem)
    const [task] = tasksFor(read.workflow, {})
    expect(task).toMatchObject({
      name: "look",
      kind: "verify",
      visual: {
        url: "http://localhost:5173/",
        steps: [{ waitFor: "#app" }, { assert: { selector: "#app", text: "Dev app" } }, { screenshot: "home" }],
        mask: [".clock"],
        tolerance: 0.005,
        settle: { captures: 3, intervalMs: 0 },
      },
    })
    expect(readVisualCheck(true)).toEqual({
      ok: true,
      check: { steps: [], mask: [], tolerance: 0.001, settle: { captures: 4, intervalMs: 250 } },
    })
    expect(readVisualCheck({ tolerance: 0.02, settle: { interval: "1s" } })).toMatchObject({
      ok: true,
      check: { tolerance: 0.02, settle: { captures: 4, intervalMs: 1000 } },
    })
  })

  test("what a visual check may not do is refused with the task's name, before a run starts", () => {
    const problem = (visual: string, kind = "verify") => {
      const read = explainWorkflow(`name: ui\ntasks:\n  - id: look\n    kind: ${kind}\n    prompt: hi\n    visual: ${visual}\n`, "ui")
      return read.ok ? undefined : read.problem
    }
    expect(problem("{ url: 'https://example.com/' }")).toBe("look: visual.url must be a page on this machine (localhost or 127.0.0.1)")
    expect(problem("{ steps: [{ submit: { selector: form } }] }")).toContain("no submit, upload or credential")
    expect(problem("{ steps: [{ fill: { selector: '#p', credential: '{{credential}}' } }] }")).toContain("visual.steps")
    expect(problem("{ steps: [{ goto: 'https://example.com/' }] }")).toBe("look: visual.steps: a goto can only open a page on this machine")
    expect(problem("{ steps: [{ hover: '#a' }] }")).toContain("Step 1: must name exactly one action")
    expect(problem("{ tolerance: 100% }")).toContain("visual.tolerance")
    expect(problem("{ mask: '.clock' }")).toBe("look: visual.mask must be a list of selectors")
    expect(problem("{ settle: { captures: 1 } }")).toContain("visual.settle")
    expect(problem("true", "agent")).toBe("look: only a verify task can have `visual`")
    expect(problem("{ steps: [{ goto: /settings }, { click: 'a.next' }, { fill: { selector: '#q', text: hi } }] }")).toBeUndefined()
  })

  test("the verdict: only captures that match the last ones are verified", () => {
    const shot = { name: "home", changed: 0, stable: true, after: "a" }
    const ran = (shots: VisualResult["shots"]): VisualResult => ({ status: "ran", url: "http://localhost:5173/", shots })
    expect(visualVerdict(ran([{ ...shot, outcome: "same", before: "b", diff: "d" }]))).toMatchObject({ value: "verified", source: "check" })
    expect(visualVerdict(ran([{ ...shot, outcome: "first" }]))).toMatchObject({ value: "unverified", reason: expect.stringContaining("Nothing to compare home with yet") })
    expect(visualVerdict(ran([{ ...shot, outcome: "same", stable: false }]))).toMatchObject({ value: "unverified", reason: expect.stringContaining("did not hold still") })
    expect(visualVerdict(ran([{ ...shot, outcome: "changed", changed: 0.042 }]))).toMatchObject({ value: "needs-user", reason: expect.stringContaining("home (4.20% of it)") })
    expect(visualVerdict({ status: "not-run", problem: "no preview", shots: [] })).toMatchObject({ value: "unverified", reason: "The visual check did not run: no preview" })
    expect(visualVerdict({ status: "failed", problem: "Step 1 (waitFor #x): gone", shots: [] })).toMatchObject({ value: "failed" })
  })
})

describe("runs of a visual verify task against the desktop's preview (CL-4)", () => {
  const engine = new Proxy({} as never, {
    get: () => () => {
      throw new Error("a verify task does not reach the engine")
    },
  })
  const manual: RunSource = { type: "manual" }
  const WIDTH = 100
  const HEIGHT = 60

  /** The page, as the preview captures it: 1000 CSS pixels wide at a tenth of the size. */
  const frame = (blocks: Array<{ x: number; y: number; width: number; height: number }> = []): Buffer => {
    const data = new Uint8Array(WIDTH * HEIGHT * 4).fill(255)
    for (const block of blocks)
      for (let y = block.y; y < block.y + block.height; y++)
        for (let x = block.x; x < block.x + block.width; x++) data.set([20, 90, 200, 255], (y * WIDTH + x) * 4)
    const image: Image = { width: WIDTH, height: HEIGHT, data }
    return encodePng(image)
  }

  function subject(workflow = WORKFLOW) {
    const repository = new SqliteRoutineRepository(":memory:")
    repositories.push(repository)
    const preview = createPreview({ repository, dataDir: folder("flupcode-visual-data-"), platform: "linux" })
    const desktop = fakeDesktop()
    desktop.attach(preview)
    // A clock in the top right corner of the page, which the workflow masks.
    desktop.page.elements.set(".clock", { nodeId: 3, quad: [800, 0, 1000, 0, 1000, 100, 800, 100], html: "<span>12:00</span>" })
    const policy = createBrowserPolicy(repository)
    const visual = createVisualCheck({ preview, policy, repository })
    // A project with no commands of its own: the look is the whole check.
    const directory = folder("flupcode-visual-project-")
    const read = explainWorkflow(workflow, "ui")
    if (!read.ok) throw new Error(read.problem)
    const tasks = tasksFor(read.workflow, {})
    const run = async (options: { check?: VisualRunner } = { check: visual }) => {
      const check = options.check
      const started = repository.startRun(manual, Date.now(), directory)
      repository.addTasks(started.id, tasks)
      // A failed check ends the run by throwing, as the scheduler expects; the task says why.
      await new TaskRunner(repository, engine, undefined, undefined, undefined, undefined, undefined, undefined, check)
        .execute(started, { directory })
        .catch(() => undefined)
      return { run: started, task: repository.listTasks(started.id)[0]! }
    }
    return { repository, preview, desktop, run, directory }
  }

  test("each run keeps the step's capture as the next version, compares it with the last, and judges the task", async () => {
    const { repository, desktop, run } = subject()

    desktop.page.frames = [frame()]
    const first = await run()
    expect(first.task.status).toBe("success")
    expect(first.task.verdict).toMatchObject({ value: "unverified", source: "check" })
    expect(first.task.verdict?.reason).toContain("Nothing to compare home with yet")
    const [kept] = repository.listArtifacts({ runID: first.run.id, kind: "screenshot" })
    expect(kept).toMatchObject({ title: "look — home", taskID: first.task.id, mime: "image/png", version: 1 })
    expect(first.task.visualResult).toEqual({
      status: "ran",
      url: "http://localhost:5173/",
      shots: [{ name: "home", outcome: "first", changed: 0, stable: true, after: kept!.id }],
    })
    expect(existsSync(join(kept!.directory!, kept!.path!))).toBe(true)

    // The same page again: the same logical artifact, its next version, and verified.
    const second = await run()
    expect(second.task.verdict).toMatchObject({ value: "verified", source: "check" })
    const shot = second.task.visualResult!.shots[0]!
    expect(shot).toMatchObject({ outcome: "same", changed: 0, before: kept!.id })
    expect(repository.getArtifact(shot.after)).toMatchObject({ logicalID: kept!.logicalID, version: 2, runID: second.run.id })
    expect(repository.getArtifact(shot.diff!)).toMatchObject({ kind: "screenshot", title: "look — home — difference", runID: second.run.id })
    expect(second.task.output).toContain(`- home — same as before: 0.00% of the page differs (artifact ${shot.after}, before ${kept!.id}`)

    // A block of the page changed: a person has to look at the before and the after.
    desktop.page.frames = [frame([{ x: 10, y: 20, width: 20, height: 10 }])]
    const third = await run()
    expect(third.task.status).toBe("success")
    expect(third.task.verdict).toMatchObject({ value: "needs-user", reason: expect.stringContaining("The page changed: home") })
    expect(third.task.visualResult!.shots[0]).toMatchObject({ outcome: "changed", before: shot.after })
    expect(third.task.visualResult!.shots[0]!.changed).toBeCloseTo(200 / (WIDTH * HEIGHT - 20 * 10))
    expect(repository.getRun(third.run.id)?.verdict).toMatchObject({ value: "needs-user" })

    // Only the clock moved: masked, so the page is the same as the last capture.
    desktop.page.frames = [frame([{ x: 10, y: 20, width: 20, height: 10 }, { x: 85, y: 2, width: 10, height: 5 }])]
    const fourth = await run()
    expect(fourth.task.verdict).toMatchObject({ value: "verified" })
    expect(repository.listArtifactVersions(kept!.id).map((version) => version.runID)).toEqual(
      [fourth, third, second, first].map((entry) => entry.run.id),
    )

    // Every step went through the browser policy and is in its audit: a decision, then what it did.
    const audit = repository.listBrowserAudit({ runID: fourth.run.id }).reverse()
    expect(audit.filter((entry) => entry.kind === "decision").map((entry) => [entry.tier, entry.decision])).toEqual([
      ["navigate", "allow"],
      ["read", "allow"],
      ["read", "allow"],
      ["read", "allow"],
    ])
    expect(audit.filter((entry) => entry.kind === "action").map((entry) => entry.outcome)).toEqual(["success", "success", "success", "success"])
    expect(audit.find((entry) => entry.kind === "action" && entry.artifactID)?.artifactID).toBe(fourth.task.visualResult!.shots[0]!.after)
    expect(audit.every((entry) => entry.action === "visual.look" && entry.origin === "http://localhost:5173")).toBe(true)
  })

  test("a capture is kept once the page holds still; one that never does is said, and not verified", async () => {
    const { desktop, run } = subject()
    const still = frame()
    const moving = [0, 20, 40].map((x) => frame([{ x, y: 0, width: 10, height: 10 }]))
    desktop.page.frames = [still]
    await run()
    // Still loading, then settled: the settled capture is the one kept and compared.
    desktop.page.frames = [moving[0]!, still, still]
    const settled = await run()
    expect(settled.task.visualResult!.shots[0]).toMatchObject({ outcome: "same", stable: true })
    expect(settled.task.verdict?.value).toBe("verified")
    // An animation that never stops within three captures: the last is kept, and said not to be still.
    desktop.page.frames = [...moving]
    const restless = await run()
    expect(restless.task.visualResult!.shots[0]).toMatchObject({ outcome: "changed", stable: false })
    expect(restless.task.verdict).toMatchObject({ value: "needs-user" })
    // Even when it lands where it was the last time, a page that did not hold still is not verified.
    desktop.page.frames = [...moving]
    const unsteady = await run()
    expect(unsteady.task.visualResult!.shots[0]).toMatchObject({ outcome: "same", stable: false })
    expect(unsteady.task.verdict).toMatchObject({ value: "unverified", reason: expect.stringContaining("did not hold still for home") })
  })

  test("a step that fails fails the task with the step; no desktop, and the check did not run", async () => {
    const { desktop, preview, run, repository } = subject(WORKFLOW.replace('- waitFor: "#app"', '- { waitFor: "#app", timeoutMs: 300 }'))
    desktop.page.elements.delete("#app")
    desktop.page.frames = [frame()]
    const missing = await run()
    expect(missing.task.status).toBe("failed")
    expect(missing.task.verdict).toMatchObject({ value: "failed", reason: expect.stringContaining("Step 1 (waitFor #app): Nothing visible matched #app within 300 ms") })
    expect(missing.task.error).toContain("The visual check failed: Step 1 (waitFor #app)")
    expect(repository.listArtifacts({ runID: missing.run.id, kind: "screenshot" })).toEqual([])
    // Newest first: the step that failed, after the page that opened.
    expect(repository.listBrowserAudit({ runID: missing.run.id }).filter((entry) => entry.kind === "action").map((entry) => entry.outcome)).toEqual(["failed", "success"])

    preview.disconnect(desktop.socket)
    const away = await run()
    expect(away.task.status).toBe("success")
    expect(away.task.verdict).toMatchObject({ value: "unverified", reason: expect.stringContaining("The visual check did not run: the desktop app's preview is not open") })
    expect(away.task.output).toContain("Visual check of http://localhost:5173/: did not run")

    // A server with no preview at all (the web, `flupcode serve`): the same answer, not a pass.
    const nowhere = await run({})
    expect(nowhere.task.verdict).toMatchObject({ value: "unverified", reason: expect.stringContaining("only runs there") })
  })

  test("a project's own commands still run, and the worse of the two judges the task", async () => {
    const { desktop, run, directory } = subject()
    writeFileSync(join(directory, "package.json"), "{}")
    mkdirSync(join(directory, ".flupcode"), { recursive: true })
    writeFileSync(join(directory, ".flupcode", "project.yaml"), "verify:\n  test: exit 1\n")
    desktop.page.frames = [frame()]
    const failing = await run()
    expect(failing.task.status).toBe("failed")
    expect(failing.task.verdict).toMatchObject({ value: "failed", reason: "Verification failed: test" })
    expect(failing.task.output).toContain("Verification: failed")
    expect(failing.task.output).toContain("Visual check of http://localhost:5173/: ran")

    writeFileSync(join(directory, ".flupcode", "project.yaml"), "verify:\n  test: exit 0\n")
    const passing = await run()
    expect(passing.task.verdict).toMatchObject({ value: "verified" })
  })
})
