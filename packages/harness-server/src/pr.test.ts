import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { branchState, countChecks, parseRepository, toPullRequest } from "./pr"

describe("parseRepository", () => {
  test("reads owner/name out of the URL forms git writes", () => {
    expect(parseRepository("https://github.com/rldona/FlupCode.git")).toBe("rldona/FlupCode")
    expect(parseRepository("https://github.com/rldona/FlupCode")).toBe("rldona/FlupCode")
    expect(parseRepository("git@github.com:rldona/FlupCode.git")).toBe("rldona/FlupCode")
    expect(parseRepository("ssh://git@github.com/rldona/FlupCode.git")).toBe("rldona/FlupCode")
    // A self-hosted host with the project nested deeper still names the project.
    expect(parseRepository("https://git.example.com/team/group/app.git")).toBe("team/group/app")
  })

  test("answers nothing for what is not a repository URL", () => {
    expect(parseRepository("/srv/repos/thing.git")).toBeUndefined()
    expect(parseRepository("")).toBeUndefined()
  })
})

describe("countChecks", () => {
  test("counts a run that has not finished as running, whatever it says it concluded", () => {
    expect(countChecks([{ status: "IN_PROGRESS" }, { status: "QUEUED", conclusion: "" }])).toEqual({
      total: 2,
      passed: 0,
      failed: 0,
      running: 2,
    })
  })

  test("counts every way GitHub says a check went wrong", () => {
    const rollup = [
      { status: "COMPLETED", conclusion: "FAILURE" },
      { status: "COMPLETED", conclusion: "TIMED_OUT" },
      { status: "COMPLETED", conclusion: "CANCELLED" },
      { status: "COMPLETED", conclusion: "SUCCESS" },
    ]
    expect(countChecks(rollup)).toEqual({ total: 4, passed: 1, failed: 3, running: 0 })
  })

  test("a skipped check is neither a pass nor a failure", () => {
    // Saying it passed would turn "four green" into a claim nobody made.
    expect(countChecks([{ status: "COMPLETED", conclusion: "SKIPPED" }])).toEqual({
      total: 1,
      passed: 0,
      failed: 0,
      running: 0,
    })
  })

  test("reads a status context, which carries `state` and no `status` at all", () => {
    expect(countChecks([{ state: "SUCCESS" }, { state: "PENDING" }, { state: "FAILURE" }])).toEqual({
      total: 3,
      passed: 1,
      failed: 1,
      running: 1,
    })
  })

  test("nothing is nothing", () => {
    expect(countChecks(undefined)).toEqual({ total: 0, passed: 0, failed: 0, running: 0 })
  })
})

test("toPullRequest keeps the states apart and defaults the rest", () => {
  const base = { number: 7, title: "t", url: "u", isDraft: false, additions: 1, deletions: 2 }
  expect(toPullRequest({ ...base, state: "MERGED" }).state).toBe("merged")
  expect(toPullRequest({ ...base, state: "CLOSED" }).state).toBe("closed")
  expect(toPullRequest({ ...base, state: "OPEN" }).state).toBe("open")
  expect(toPullRequest({ ...base, state: "OPEN" }).checks).toEqual({ total: 0, passed: 0, failed: 0, running: 0 })
})

describe("branchState", () => {
  let directory = ""
  const bares: string[] = []
  const run = async (args: string[], cwd = directory) => {
    const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
    await child.exited
    return (await new Response(child.stdout).text()).trim()
  }

  /**
   * A PATH with `git` on it and no `gh`.
   *
   * These tests are about what git can answer on its own. Left on the real PATH they would call the
   * GitHub API for every case — slow, rate-limited, and answering differently depending on whether
   * whoever runs them happens to be logged in.
   */
  let previousPath: string | undefined
  const hideGh = async () => {
    const bin = mkdtempSync(join(tmpdir(), "flupcode-bin-"))
    bares.push(bin)
    const where = await run(["which", "git"], tmpdir())
    symlinkSync(where || "/usr/bin/git", join(bin, "git"))
    previousPath = process.env.PATH
    process.env.PATH = bin
  }

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "flupcode-pr-"))
    await run(["git", "init", "-q", "-b", "main"])
    await run(["git", "config", "user.email", "test@example.com"])
    await run(["git", "config", "user.name", "Test"])
    writeFileSync(join(directory, "a.txt"), "one\n")
    await run(["git", "add", "-A"])
    await run(["git", "commit", "-qm", "first"])
  })

  afterEach(() => {
    if (previousPath !== undefined) process.env.PATH = previousPath
    previousPath = undefined
    rmSync(directory, { recursive: true, force: true })
    for (const bare of bares.splice(0)) rmSync(bare, { recursive: true, force: true })
  })

  test("says there is nothing to show when the folder has no remote", async () => {
    const state = await branchState(directory)
    expect(state).toEqual({
      available: false,
      branch: "main",
      pushed: false,
      problem: "No remote to compare against",
    })
  })

  /**
   * A remote that answers without a network.
   *
   * `insteadOf` sends git's transport at a bare repository on disk while the configured URL stays
   * the GitHub one, which is the thing being read. Without this the tests below would reach
   * github.com — slow, and untrue the moment CI has no network.
   */
  const localRemote = async (name: string, url: string) => {
    const bare = mkdtempSync(join(tmpdir(), "flupcode-bare-"))
    bares.push(bare)
    await run(["git", "init", "-q", "--bare", bare], tmpdir())
    await run(["git", "remote", "add", name, url])
    await run(["git", "config", `url.${bare}.insteadOf`, url])
    return bare
  }

  test("takes the repository from the branch's own remote, not from gh's default", async () => {
    // A fork: `origin` is where the branch lives, `upstream` is what `gh` would pick on its own.
    await localRemote("origin", "https://github.com/rldona/FlupCode.git")
    await localRemote("upstream", "https://github.com/anomalyco/opencode.git")
    await run(["git", "push", "-q", "--set-upstream", "origin", "main"])
    await hideGh()

    const state = await branchState(directory)

    expect(state.repository).toBe("rldona/FlupCode")
    expect(state.branch).toBe("main")
    expect(state.pushed).toBe(true)
  })

  test("a branch nobody has pushed is reported as not pushed", async () => {
    await localRemote("origin", "https://github.com/rldona/FlupCode.git")
    await hideGh()
    const state = await branchState(directory)
    expect(state.repository).toBe("rldona/FlupCode")
    expect(state.pushed).toBe(false)
  })

  test("without gh there is nothing to show, and it says which part is missing", async () => {
    await localRemote("origin", "https://github.com/rldona/FlupCode.git")
    await hideGh()

    const state = await branchState(directory)

    // Not an error the reader has to dismiss: a client draws no chip and says nothing.
    expect(state.available).toBe(false)
    expect(state.problem).toBe("gh is not installed")
    expect(state.pullRequest).toBeUndefined()
  })
})
