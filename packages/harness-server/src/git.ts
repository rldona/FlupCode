/**
 * Git, run as git (H-20).
 *
 * The button that said "Commit changes" wrote `"Commit the current changes with a clear message."`
 * into the composer and sent it, so every commit was a model turn: tokens, latency, and a tool call
 * that could do anything, to do what `git commit` does for nothing. This module is the other half
 * of the diff viewer — you read what changed, and then you commit it.
 *
 * Every call runs `git` with an argument vector, never through a shell. The message, the paths and
 * the branch name all come from a browser, and a shell would read `;` and `$(…)` in any of them.
 */

import { rmSync } from "node:fs"
import { join, resolve, sep } from "node:path"
import { selectHunks } from "./patch"

export type GitCommit = { sha: string; subject: string; branch: string }

export class GitError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
    this.name = "GitError"
  }
}

const TIMEOUT_MS = 30_000

/**
 * The line of git's complaint worth showing, rather than the whole of it.
 *
 * Its own `fatal:`/`error:` line if there is one — a rejected commit prints the hook's output too,
 * and the hint lines after it are for a terminal, not for a button that just failed.
 */
const reason = (value: string) => {
  const lines = value.trim().split("\n").map((line) => line.trim()).filter(Boolean)
  const named = lines.find((line) => line.startsWith("fatal:") || line.startsWith("error:"))
  return (named ?? lines[0] ?? "").replace(/^(fatal|error):\s*/, "")
}

async function git(directory: string, args: string[], input?: string) {
  // `Bun.spawn` throws when the binary is not on PATH, rather than answering a non-zero exit code.
  // Left to propagate, a machine without this tool installed gets a 500 out of an endpoint whose
  // whole job is to report that it is missing.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      // A patch is written to git's standard input for `apply`, so it is piped when there is one.
      stdin: input === undefined ? "ignore" : "pipe",
      // Nothing here may stop to ask: a server has no terminal to ask at, and a git that blocks
      // on a credential or an editor prompt would hang the request until it timed out.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", NO_COLOR: "1" },
    })
    if (input !== undefined && child.stdin) {
      child.stdin.write(input)
      child.stdin.end()
    }
    timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    // Untrimmed: `git status --porcelain` puts the status in the first two columns, and a modified
    // file's first column is a space. Trimming here eats it and every path is then off by one.
    return { exitCode, stdout, stderr: stderr.trim() }
  } catch (cause) {
    return { exitCode: 127, stdout: "", stderr: cause instanceof Error ? cause.message : String(cause) }
  } finally {
    clearTimeout(timer)
  }
}

async function expect(directory: string, args: string[], what: string) {
  const result = await git(directory, args)
  if (result.exitCode !== 0) throw new GitError(`${what}: ${reason(result.stderr || result.stdout)}`)
  return result.stdout.trim()
}

/**
 * A path this may touch.
 *
 * Relative, inside the folder, and — the part that matters — one git itself has just listed as
 * changed. A client cannot name a path outside the working tree, and cannot stage something the
 * folder has not actually changed. It is the confinement H-47 says a task still lacks, applied
 * here, where the writing happens.
 */
async function changedPaths(directory: string) {
  const entries = await statusEntries(directory)
  return new Set(entries.map((entry) => entry.path))
}

/** Every path git lists as changed, with its two status columns (`??` is a new, untracked file). */
async function statusEntries(directory: string) {
  const listed = await git(directory, ["status", "--porcelain=v1", "-z"])
  if (listed.exitCode !== 0) throw new GitError(`Could not read the folder's status: ${reason(listed.stderr)}`)
  const entries: Array<{ path: string; status: string }> = []
  const records = listed.stdout.split("\0")
  for (let index = 0; index < records.length; index++) {
    const entry = records[index]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    entries.push({ path: entry.slice(3), status })
    // With `-z`, a rename or a copy is two records: the new path, then the old one on its own. The
    // old path has no status columns, so reading it as one would take three characters off a path.
    if (status[0] === "R" || status[0] === "C") index++
  }
  return entries
}

export async function isRepository(directory: string) {
  const result = await git(directory, ["rev-parse", "--is-inside-work-tree"])
  return result.exitCode === 0 && result.stdout.trim() === "true"
}

export async function currentBranch(directory: string) {
  const result = await git(directory, ["branch", "--show-current"])
  // Empty on a detached HEAD, which is a real state and not an error.
  return result.exitCode === 0 ? result.stdout.trim() : ""
}

/**
 * Stages what was picked and commits it.
 *
 * The paths are named rather than assumed: `git commit -a` takes whatever happens to be in the
 * folder at that moment, which after a run is not always what the reader just looked at.
 *
 * `hunks` is the part the diff viewer added: a file listed there is staged **by hunk** — only the
 * hunks named go to the index, so the commit carries the lines the reader chose and leaves the rest
 * in the working tree. A file not listed is staged whole.
 */
export async function commit(input: {
  directory: string
  message: string
  paths: string[]
  /** Per path, the hunk indices to stage. A path absent from here is staged whole. */
  hunks?: Record<string, number[]>
}): Promise<GitCommit> {
  const message = input.message.trim()
  if (!message) throw new GitError("A commit needs a message")
  if (input.paths.length === 0) throw new GitError("Nothing was selected to commit")
  if (!(await isRepository(input.directory))) throw new GitError("This folder is not a git repository")

  const changed = await changedPaths(input.directory)
  const unknown = input.paths.filter((path) => !changed.has(path))
  if (unknown.length > 0) throw new GitError(`No longer changed: ${unknown.slice(0, 3).join(", ")}`, 409)

  for (const path of input.paths) {
    const picked = input.hunks?.[path]
    if (!picked || picked.length === 0) {
      // `--` so a path that looks like an option, or like a branch, is still read as a path.
      await expect(input.directory, ["add", "--", path], "Could not stage those files")
      continue
    }
    const patch = await diffForFile(input.directory, path)
    if (!patch.trim()) throw new GitError(`There is nothing left to stage in ${path}`, 409)
    await applyPatch(input.directory, selectHunks(patch, picked), ["apply", "--cached"], `Could not stage the chosen hunks of ${path}`)
  }

  const result = await git(input.directory, ["commit", "-m", message])
  if (result.exitCode !== 0) {
    // A hook that rejects the commit is the common case here, and its own output is the answer.
    throw new GitError(reason(result.stderr || result.stdout) || "The commit was refused")
  }
  const sha = await expect(input.directory, ["rev-parse", "--short", "HEAD"], "Could not read the new commit")
  const subject = await expect(input.directory, ["log", "-1", "--pretty=%s"], "Could not read the new commit")
  return { sha, subject, branch: await currentBranch(input.directory) }
}

/** The working tree's change to one file, as a patch git would apply. */
async function diffForFile(directory: string, path: string) {
  const result = await git(directory, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--", path])
  if (result.exitCode !== 0) throw new GitError(`Could not read the change: ${reason(result.stderr)}`)
  return result.stdout
}

/**
 * What a commit would carry, as one patch — for reading, not for applying.
 *
 * Built the same way `commit` stages it, so a message describes the picked lines and not the whole
 * working tree. An untracked file has no diff to read, so it is named as a new file and nothing more.
 */
export async function patchForCommit(input: { directory: string; paths: string[]; hunks?: Record<string, number[]> }) {
  if (!(await isRepository(input.directory))) throw new GitError("This folder is not a git repository")
  const known = new Map((await statusEntries(input.directory)).map((entry) => [entry.path, entry.status]))
  const unknown = input.paths.filter((path) => !known.has(path))
  if (unknown.length > 0) throw new GitError(`No longer changed: ${unknown.slice(0, 3).join(", ")}`, 409)
  const parts: string[] = []
  for (const path of input.paths) {
    if (known.get(path) === "??") {
      parts.push(`new file: ${path}`)
      continue
    }
    const patch = await diffForFile(input.directory, path)
    if (!patch.trim()) continue
    const picked = input.hunks?.[path]
    parts.push(!picked || picked.length === 0 ? patch : selectHunks(patch, picked))
  }
  return parts.join("\n")
}

async function applyPatch(directory: string, patch: string, mode: string[], what: string) {
  const result = await git(directory, [...mode, "--whitespace=nowarn", "-"], patch)
  if (result.exitCode !== 0) throw new GitError(`${what}: ${reason(result.stderr) || "the patch did not apply"}`)
}

/**
 * Throws away a file's change, or the named hunks of it.
 *
 * A file named with no hunks is reset to what git has: the working tree goes back to the index
 * (or to `HEAD` when nothing of it was staged), which is what "discard" means. A file git has never
 * seen is removed, because there is no earlier version to go back to.
 */
export async function discard(input: { directory: string; path: string; hunks?: number[] }) {
  if (!(await isRepository(input.directory))) throw new GitError("This folder is not a git repository")
  const entries = await statusEntries(input.directory)
  const entry = entries.find((candidate) => candidate.path === input.path)
  if (!entry) throw new GitError("That path is not changed", 409)

  if (!input.hunks || input.hunks.length === 0) {
    if (entry.status === "??") {
      const absolute = resolve(input.directory, input.path)
      if (!(absolute === join(input.directory, input.path) || absolute.startsWith(resolve(input.directory) + sep))) {
        throw new GitError("That path is outside the folder")
      }
      rmSync(absolute)
    } else {
      await expect(input.directory, ["restore", "--staged", "--worktree", "--", input.path], "Could not discard the change")
    }
    return { path: input.path }
  }

  if (entry.status === "??") {
    throw new GitError("That file is new, so it has no hunks to choose: discard the whole file")
  }
  const patch = await diffForFile(input.directory, input.path)
  if (!patch.trim()) throw new GitError(`There is nothing left to discard in ${input.path}`, 409)
  await applyPatch(
    input.directory,
    selectHunks(patch, input.hunks),
    ["apply", "--reverse"],
    `Could not discard the chosen hunks of ${input.path}`,
  )
  return { path: input.path }
}

/**
 * Starts a branch here and moves onto it.
 *
 * Uncommitted work comes along, which is what somebody who realises mid-change that this should not
 * be on the branch they are on actually wants.
 */
export async function branch(input: { directory: string; name: string }) {
  const name = input.name.trim()
  if (!name) throw new GitError("A branch needs a name")
  if (!(await isRepository(input.directory))) throw new GitError("This folder is not a git repository")
  // git's own rules, asked of git, rather than a regular expression here that disagrees with it.
  const valid = await git(input.directory, ["check-ref-format", "--branch", name])
  if (valid.exitCode !== 0) throw new GitError(`"${name}" is not a name git accepts for a branch`)
  const exists = await git(input.directory, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`])
  if (exists.exitCode === 0) throw new GitError(`There is already a branch called "${name}"`, 409)
  await expect(input.directory, ["checkout", "-b", name], "Could not start that branch")
  return { branch: await currentBranch(input.directory) }
}
