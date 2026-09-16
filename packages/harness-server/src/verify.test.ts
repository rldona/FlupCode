import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { configuredSteps, detectedSteps, evidenceText, runVerify, verifySteps } from "./verify"

const made: string[] = []
const project = (files: Record<string, string>) => {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-verify-"))
  made.push(directory)
  for (const [path, contents] of Object.entries(files)) {
    const full = join(directory, path)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, contents)
  }
  return directory
}

afterEach(() => {
  for (const directory of made.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe("what a project is verified with", () => {
  test("what it declares, in the order it declared it", async () => {
    const directory = project({
      ".flupcode/project.yaml": "verify:\n  typecheck: bun run typecheck\n  test: bun test src\n",
      "package.json": JSON.stringify({ scripts: { test: "vitest", lint: "eslint ." } }),
    })
    // Declared wins whole: the lint script is not bolted onto a list the repository wrote itself.
    expect(await verifySteps(directory)).toEqual({
      steps: [
        { name: "typecheck", command: "bun run typecheck" },
        { name: "test", command: "bun test src" },
      ],
    })
  })

  test("the scripts it has, run with the manager its lockfile names", async () => {
    const directory = project({
      "package.json": JSON.stringify({ scripts: { build: "tsc", test: "bun test", typecheck: "tsgo" } }),
      "bun.lock": "{}",
    })
    // Cheapest first, and `build` last — the order is the module's, not package.json's.
    expect(await detectedSteps(directory)).toEqual([
      { name: "typecheck", command: "bun run typecheck" },
      { name: "test", command: "bun run test" },
      { name: "build", command: "bun run build" },
    ])
  })

  test("nothing is invented for a script the project does not have", async () => {
    const directory = project({ "package.json": JSON.stringify({ scripts: { start: "node ." } }), "yarn.lock": "" })
    expect(await detectedSteps(directory)).toEqual([])
  })

  test("no file at all leaves the scripts to speak", async () => {
    expect(await configuredSteps(project({}))).toBeUndefined()
    // A file that says nothing about checks says nothing about checks.
    expect(await configuredSteps(project({ ".flupcode/project.yaml": "name: thing\n" }))).toBeUndefined()
  })

  // A declaration that cannot be read is not the same as no declaration. Falling back to detection
  // there tells the reader "this project declares no checks" about a project that declares them in
  // a file with a typo — and hands a retry that same sentence to act on.
  test("a declaration that cannot be read says so, and does not fall back", async () => {
    const broken = await configuredSteps(project({ ".flupcode/project.yaml": "verify: [" }))
    expect(broken?.steps).toEqual([])
    expect(broken?.problem).toContain("could not be read")

    const empty = await configuredSteps(project({ ".flupcode/project.yaml": "verify:\n" }))
    expect(empty?.problem).toContain("no commands under it")

    const wrong = await configuredSteps(project({ ".flupcode/project.yaml": "verify: just a string\n" }))
    expect(wrong?.problem).toContain("not a list of commands")

    // And detection does not quietly take over, even with scripts sitting right there.
    const directory = project({
      ".flupcode/project.yaml": "verify: [",
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "bun.lock": "{}",
    })
    const plan = await verifySteps(directory)
    expect(plan.steps).toEqual([])
    expect(plan.problem).toContain("could not be read")
  })
})

describe("running it", () => {
  test("every step runs, and one failure is the verdict", async () => {
    const directory = project({})
    const report = await runVerify(directory, {
      steps: [
        { name: "typecheck", command: "echo checked" },
        { name: "test", command: "echo 'it broke' >&2; exit 3" },
        { name: "build", command: "echo built" },
      ],
    })
    expect(report.ok).toBe(false)
    // The third ran anyway: the report is worth more whole than stopped at the first red.
    expect(report.steps.map((step) => step.exitCode)).toEqual([0, 3, 0])
    expect(report.steps[1]!.output).toContain("it broke")
  })

  test("all green is a pass, and nothing to run is not", async () => {
    const directory = project({})
    expect((await runVerify(directory, { steps: [{ name: "test", command: "true" }] })).ok).toBe(true)
    // A project nobody can check must not report that it checked out.
    expect((await runVerify(directory, { steps: [] })).ok).toBe(false)
  })

  test("the commands run where the run is working", async () => {
    const directory = project({ "marker.txt": "here" })
    const report = await runVerify(directory, { steps: [{ name: "test", command: "cat marker.txt" }] })
    expect(report.steps[0]!.output).toContain("here")
  })

  test("a stopped run does not start the steps it had left", async () => {
    const directory = project({})
    let started = 0
    const report = await runVerify(directory, {
      steps: [
        { name: "one", command: "true" },
        { name: "two", command: "true" },
      ],
      stopped: () => ++started > 1,
    })
    expect(report.steps).toHaveLength(1)
  })
})

describe("the evidence", () => {
  test("a broken declaration is the whole answer, and reads as something to fix", () => {
    const text = evidenceText({ ok: false, steps: [], problem: ".flupcode/project.yaml could not be read: bad token" })
    expect(text).toContain("Verification could not run")
    expect(text).toContain("bad token")
    // Not the sentence that sent an agent hunting for a file that was right there.
    expect(text).not.toContain("declares no")
  })

  test("says the verdict, lists every step, and quotes only what failed", () => {
    const text = evidenceText({
      ok: false,
      steps: [
        { name: "typecheck", command: "tsc", exitCode: 0, durationMs: 1200, output: "fine" },
        { name: "test", command: "bun test", exitCode: 1, durationMs: 4300, output: "1 fail" },
      ],
    })
    expect(text).toContain("Verification: failed")
    expect(text).toContain("- typecheck (tsc) — ok, 1.2s")
    expect(text).toContain("- test (bun test) — exit 1, 4.3s")
    expect(text).toContain("1 fail")
    // The output of what passed is noise in a handoff.
    expect(text).not.toContain("fine")
  })

  test("says so when there was nothing to run, rather than claiming a pass", () => {
    expect(evidenceText({ ok: false, steps: [] })).toContain("No verification")
  })
})
