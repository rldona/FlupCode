/**
 * Checkpoints (H-15): a way back.
 *
 * A run writes files. Until now, if it made a mess the only way out was to undo it by hand — the
 * audit's "sólo revert manual". The diff viewer shows what a run did and the commit keeps what was
 * good; this is the third thing, and the one that makes the other two safe to rely on.
 *
 * A checkpoint is a git commit object that is not on any branch. It is built through a temporary
 * index, so taking one touches **nothing** a reader can see: not the working tree, not the index
 * they have staged, not the stash list, not the branch. A ref under `refs/flupcode/checkpoints/`
 * keeps it from being collected.
 *
 * Restoring is the dangerous half, and it has two rules. It says exactly which files it would write
 * and which it would delete before it does anything, and it takes a checkpoint of the present first
 * — so undoing an undo is the same operation again.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GitError, isRepository } from "./git"

export type Checkpoint = {
  id: string
  directory: string
  /** The commit object. Nothing points at it but our own ref. */
  sha: string
  title: string
  runID?: string
  taskID?: string
  createdAt: number
}

export type RestorePlan = {
  /** Files the restore would write, overwriting whatever is there. */
  write: string[]
  /** Files the restore would delete, because the checkpoint does not have them. */
  remove: string[]
}

const TIMEOUT_MS = 60_000

const REF = (id: string) => `refs/flupcode/checkpoints/${id}`

async function git(directory: string, args: string[], index?: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        NO_COLOR: "1",
        ...(index ? { GIT_INDEX_FILE: index } : {}),
      },
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

async function expect(directory: string, args: string[], what: string, index?: string) {
  const result = await git(directory, args, index)
  if (result.exitCode !== 0) {
    const detail = (result.stderr || result.stdout).split("\n").filter(Boolean)[0] ?? ""
    throw new GitError(`${what}${detail ? `: ${detail}` : ""}`)
  }
  return result.stdout
}

/** A scratch index, so nothing here goes near the one the reader has staged. */
async function withIndex<T>(run: (index: string) => Promise<T>) {
  const directory = mkdtempSync(join(tmpdir(), "flupcode-index-"))
  try {
    return await run(join(directory, "index"))
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * The tree the folder is right now — everything git would track, including files nobody has added.
 *
 * `git add -A` through the scratch index honours `.gitignore`, which is what makes a checkpoint of
 * a real project a few kilobytes rather than the whole of `node_modules`.
 */
async function currentTree(directory: string) {
  return withIndex(async (index) => {
    // From HEAD rather than empty, so unchanged files keep the object they already have.
    const head = await git(directory, ["rev-parse", "--verify", "--quiet", "HEAD"])
    if (head.exitCode === 0) await expect(directory, ["read-tree", "HEAD"], "Could not read HEAD", index)
    await expect(directory, ["add", "-A", "."], "Could not read the folder", index)
    return expect(directory, ["write-tree"], "Could not record the folder", index)
  })
}

const id = () => `cp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * Records what the folder looks like now.
 *
 * Cheap: unchanged files reuse the objects git already has, so a checkpoint of a big project after
 * a small change is a tree and a commit and nothing else.
 */
export async function take(input: {
  directory: string
  title: string
  runID?: string
  taskID?: string
}): Promise<Checkpoint> {
  if (!(await isRepository(input.directory))) throw new GitError("This folder is not a git repository")
  const tree = await currentTree(input.directory)
  const head = await git(input.directory, ["rev-parse", "--verify", "--quiet", "HEAD"])
  const parents = head.exitCode === 0 && head.stdout ? ["-p", head.stdout] : []
  const sha = await expect(
    input.directory,
    ["commit-tree", tree, ...parents, "-m", input.title || "checkpoint"],
    "Could not record a checkpoint",
  )
  const checkpoint: Checkpoint = {
    id: id(),
    directory: input.directory,
    sha,
    title: input.title,
    runID: input.runID,
    taskID: input.taskID,
    createdAt: Date.now(),
  }
  // The ref is what keeps `git gc` from collecting it. Without one this is a dangling commit that
  // disappears on its own schedule, which is the worst possible kind of undo.
  await expect(input.directory, ["update-ref", REF(checkpoint.id), sha], "Could not keep the checkpoint")
  return checkpoint
}

/**
 * What restoring would do, before it does it.
 *
 * Computed by recording the present the same way a checkpoint is recorded and diffing the two
 * trees, so files nobody ever added to git are in it too — those are exactly the ones a reader
 * would not expect to lose.
 */
export async function planRestore(directory: string, sha: string): Promise<RestorePlan> {
  if (!(await isRepository(directory))) throw new GitError("This folder is not a git repository")
  const now = await currentTree(directory)
  const listed = await expect(directory, ["diff", "--name-status", "-z", now, sha], "Could not compare")
  const write: string[] = []
  const remove: string[] = []
  const records = listed.split("\0").filter(Boolean)
  for (let index = 0; index < records.length; index += 2) {
    const status = records[index]?.[0]
    const path = records[index + 1]
    if (!status || !path) continue
    // From the present to the checkpoint: what the checkpoint does not have would go.
    if (status === "D") remove.push(path)
    else write.push(path)
  }
  return { write: write.sort(), remove: remove.sort() }
}

/**
 * Puts the folder back, after recording where it was.
 *
 * The safety checkpoint is not a nicety: restoring overwrites files and deletes others, and without
 * one the reader's only way back would be the thing they just undid.
 */
export async function restore(input: {
  directory: string
  sha: string
  /** Given back so the caller can record it. A restore with no way back is not one. */
  safetyTitle?: string
}): Promise<{ plan: RestorePlan; safety: Checkpoint }> {
  const plan = await planRestore(input.directory, input.sha)
  const safety = await take({ directory: input.directory, title: input.safetyTitle ?? "Before restoring" })

  await withIndex(async (index) => {
    await expect(input.directory, ["read-tree", input.sha], "Could not read the checkpoint", index)
    // Writes every file of the checkpoint over what is there, through the scratch index, so the
    // reader's staged state is exactly as they left it when this finishes.
    await expect(input.directory, ["checkout-index", "-a", "-f"], "Could not write the checkpoint", index)
  })

  for (const path of plan.remove) {
    rmSync(join(input.directory, path), { force: true })
  }
  return { plan, safety }
}

/** Forgets one. The commit goes with the ref, once git next collects. */
export async function drop(directory: string, checkpointID: string) {
  await git(directory, ["update-ref", "-d", REF(checkpointID)])
}

/** Whether the commit a checkpoint names is still there — a repository can be cleaned by hand. */
export async function exists(directory: string, sha: string) {
  const result = await git(directory, ["cat-file", "-e", `${sha}^{commit}`])
  return result.exitCode === 0
}
