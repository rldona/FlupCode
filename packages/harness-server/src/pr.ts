/**
 * Pull requests, through `gh` (H-20's other half).
 *
 * A branch is not the end of the work — the pull request is, and its state is the thing a reader
 * keeps leaving the app to check. One `gh pr list` answers all of it: the number, the state, what
 * it changes, and every check with its verdict.
 *
 * This is GitHub only, and it says so rather than pretending otherwise: `available: false` when
 * `gh` is not installed or not logged in, so a client can show nothing instead of a broken chip.
 */

import { GitError } from "./git"

export type CheckCounts = { total: number; passed: number; failed: number; running: number }

export type PullRequest = {
  number: number
  title: string
  url: string
  state: "open" | "merged" | "closed"
  draft: boolean
  additions: number
  deletions: number
  checks: CheckCounts
}

export type BranchState = {
  /** False when `gh` is missing or logged out: the client draws nothing rather than an error. */
  available: boolean
  branch: string
  /** "owner/name", taken from the branch's own remote and never from `gh`'s guess. */
  repository?: string
  /** Whether the branch exists on that remote yet. A pull request cannot be opened until it does. */
  pushed: boolean
  /** The subject of the last commit, which is what a new pull request is titled after. */
  subject?: string
  pullRequest?: PullRequest
  /** Why there is nothing to show, when there is a reason worth saying. */
  problem?: string
}

const TIMEOUT_MS = 20_000

async function run(command: string[], directory: string) {
  // `Bun.spawn` throws when the binary is not on PATH, rather than answering a non-zero exit code.
  // Left to propagate, a machine without this tool installed gets a 500 out of an endpoint whose
  // whole job is to report that it is missing.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const child = Bun.spawn(command, {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    })
    timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() }
  } catch (cause) {
    return { exitCode: 127, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The repository a branch belongs to, worked out from its own remote.
 *
 * Deliberately not left to `gh`, which picks the default repository of the folder it is run in. In
 * a fork with an `upstream` remote that is the *other* repository, and `gh pr list` then answers an
 * empty list for a branch that has a pull request — no error, just the wrong repository, silently.
 */
async function repositoryFor(directory: string, branch: string) {
  const remotes = await run(["git", "remote"], directory)
  if (remotes.exitCode !== 0 || !remotes.stdout) return undefined
  const names = remotes.stdout.split("\n").map((name) => name.trim()).filter(Boolean)
  // Where this branch actually pushes, then where it tracks, then the conventional name, then the
  // only one there is.
  const pushed = await run(["git", "rev-parse", "--abbrev-ref", `${branch}@{push}`], directory)
  const tracked = await run(["git", "rev-parse", "--abbrev-ref", `${branch}@{upstream}`], directory)
  const named = [pushed, tracked]
    .filter((result) => result.exitCode === 0)
    .map((result) => result.stdout.split("/")[0])
    .find((name) => name && names.includes(name))
  const remote = named ?? (names.includes("origin") ? "origin" : names.length === 1 ? names[0] : undefined)
  if (!remote) return undefined
  // `git config --get`, not `git remote get-url`: the latter applies `insteadOf` rewrites, and a
  // rewrite to a local mirror would hand back a path with no owner or name in it. What names the
  // repository is what the user configured; where git actually connects is a transport detail.
  const url = await run(["git", "config", "--get", `remote.${remote}.url`], directory)
  if (url.exitCode !== 0) return undefined
  return { remote, repository: parseRepository(url.stdout) }
}

/** `owner/name` out of either URL form git writes, with the `.git` suffix dropped. */
export function parseRepository(url: string): string | undefined {
  const cleaned = url.trim().replace(/\.git$/, "")
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+)$/.exec(cleaned)
  if (ssh) return ssh[2]
  const web = /^https?:\/\/[^/]+\/(.+)$/.exec(cleaned)
  if (web) return web[1]
  return undefined
}

type RollupEntry = { status?: string; conclusion?: string; state?: string }

/** What the checks add up to. GitHub reports two shapes; a status context has no `status`. */
export function countChecks(rollup: RollupEntry[] | undefined): CheckCounts {
  const counts: CheckCounts = { total: 0, passed: 0, failed: 0, running: 0 }
  for (const entry of rollup ?? []) {
    counts.total++
    const verdict = (entry.conclusion || entry.state || "").toUpperCase()
    const finished = entry.status === undefined || entry.status === "COMPLETED"
    if (!finished) {
      counts.running++
      continue
    }
    // Skipped and neutral are not failures, and calling them passes would be a lie of a different
    // kind — they are counted, and they are neither.
    if (verdict === "SUCCESS") counts.passed++
    else if (verdict === "FAILURE" || verdict === "ERROR" || verdict === "TIMED_OUT" || verdict === "CANCELLED")
      counts.failed++
    else if (verdict === "PENDING" || verdict === "EXPECTED" || verdict === "") counts.running++
  }
  return counts
}

const STATES: Record<string, PullRequest["state"]> = { OPEN: "open", MERGED: "merged", CLOSED: "closed" }

const FIELDS = "number,title,url,state,isDraft,additions,deletions,statusCheckRollup"

type ListedPullRequest = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  additions: number
  deletions: number
  statusCheckRollup?: RollupEntry[]
}

export function toPullRequest(listed: ListedPullRequest): PullRequest {
  return {
    number: listed.number,
    title: listed.title,
    url: listed.url,
    state: STATES[listed.state?.toUpperCase() ?? ""] ?? "open",
    draft: !!listed.isDraft,
    additions: listed.additions ?? 0,
    deletions: listed.deletions ?? 0,
    checks: countChecks(listed.statusCheckRollup),
  }
}

async function ghAvailable(directory: string) {
  const version = await run(["gh", "--version"], directory)
  if (version.exitCode !== 0) return "gh is not installed"
  const auth = await run(["gh", "auth", "status"], directory)
  if (auth.exitCode !== 0) return "gh is not logged in"
  return undefined
}

/** Where this branch stands: pushed or not, and what pull request it has, if any. */
export async function branchState(directory: string): Promise<BranchState> {
  const head = await run(["git", "branch", "--show-current"], directory)
  const branch = head.exitCode === 0 ? head.stdout : ""
  if (!branch) return { available: false, branch: "", pushed: false, problem: "Not on a branch" }

  const found = await repositoryFor(directory, branch)
  if (!found?.repository) return { available: false, branch, pushed: false, problem: "No remote to compare against" }

  const remoteHead = await run(["git", "ls-remote", "--exit-code", "--heads", found.remote, branch], directory)
  const pushed = remoteHead.exitCode === 0
  const last = await run(["git", "log", "-1", "--pretty=%s"], directory)
  const subject = last.exitCode === 0 ? last.stdout : undefined

  const missing = await ghAvailable(directory)
  if (missing) return { available: false, branch, repository: found.repository, pushed, subject, problem: missing }

  const listed = await run(
    ["gh", "pr", "list", "--repo", found.repository, "--head", branch, "--state", "all", "--limit", "1", "--json", FIELDS],
    directory,
  )
  if (listed.exitCode !== 0) {
    return { available: false, branch, repository: found.repository, pushed, subject, problem: firstLine(listed.stderr) }
  }
  let parsed: ListedPullRequest[] = []
  try {
    parsed = JSON.parse(listed.stdout || "[]") as ListedPullRequest[]
  } catch {
    return {
      available: false,
      branch,
      repository: found.repository,
      pushed,
      subject,
      problem: "gh answered something unreadable",
    }
  }
  const first = parsed[0]
  return {
    available: true,
    branch,
    repository: found.repository,
    pushed,
    subject,
    pullRequest: first ? toPullRequest(first) : undefined,
  }
}

const firstLine = (value: string) => value.trim().split("\n").filter(Boolean)[0] ?? "gh failed"

/**
 * Opens a pull request for this branch, pushing it first if it has never been pushed.
 *
 * Both halves reach GitHub, which is why neither happens on its own: this runs when somebody has
 * pressed a button that says so.
 */
export async function createPullRequest(input: {
  directory: string
  title: string
  body?: string
  base?: string
  draft?: boolean
}): Promise<PullRequest> {
  const title = input.title.trim()
  if (!title) throw new GitError("A pull request needs a title")

  const head = await run(["git", "branch", "--show-current"], input.directory)
  const branch = head.exitCode === 0 ? head.stdout : ""
  if (!branch) throw new GitError("Not on a branch")

  const found = await repositoryFor(input.directory, branch)
  if (!found?.repository) throw new GitError("This folder has no remote to open a pull request on")

  const missing = await ghAvailable(input.directory)
  if (missing) throw new GitError(missing)

  const pushed = await run(["git", "push", "--set-upstream", found.remote, branch], input.directory)
  if (pushed.exitCode !== 0) throw new GitError(`Could not push the branch: ${firstLine(pushed.stderr)}`)

  const args = [
    "gh",
    "pr",
    "create",
    "--repo",
    found.repository,
    "--head",
    branch,
    "--title",
    title,
    "--body",
    input.body ?? "",
  ]
  if (input.base) args.push("--base", input.base)
  if (input.draft) args.push("--draft")
  const created = await run(args, input.directory)
  if (created.exitCode !== 0) throw new GitError(firstLine(created.stderr) || "Could not open the pull request")

  const state = await branchState(input.directory)
  if (!state.pullRequest) throw new GitError("The pull request was opened but could not be read back")
  return state.pullRequest
}
