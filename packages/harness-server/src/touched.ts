/**
 * What each task of a run changed on disk (H-12).
 *
 * Not asked of the engine, and not inferred from tool calls: worked out from the checkpoints H-15
 * already takes after every task. The difference between one checkpoint and the one before it is
 * exactly what that task did to the folder — including files it wrote through a shell command,
 * which no tool-call listing would have caught.
 *
 * The first task of a run is compared against the checkpoint's own parent, which is where the
 * folder was when the run started.
 */

import type { Checkpoint } from "./types"

export type TouchedFiles = {
  taskID?: string
  checkpointID: string
  title: string
  /** What the step concluded (H-15), so the marker says what the point was for. */
  summary?: string
  /** Paths, relative to the folder. Empty when the task changed nothing, which is worth showing. */
  files: Array<{ path: string; status: "added" | "modified" | "deleted" }>
}

const TIMEOUT_MS = 30_000

async function git(directory: string, args: string[]) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
    })
    timer = setTimeout(() => child.kill(), TIMEOUT_MS)
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { exitCode, stdout }
  } catch {
    return { exitCode: 127, stdout: "" }
  } finally {
    clearTimeout(timer)
  }
}

const STATUS: Record<string, TouchedFiles["files"][number]["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "modified",
  C: "added",
  T: "modified",
}

/** What changed between two commits, as paths with what happened to each. */
export async function changedBetween(directory: string, from: string, to: string) {
  const result = await git(directory, ["diff", "--name-status", "-z", from, to])
  if (result.exitCode !== 0) return []
  const files: TouchedFiles["files"] = []
  const records = result.stdout.split("\0").filter(Boolean)
  for (let index = 0; index < records.length; index += 2) {
    const code = records[index]?.[0]
    const path = records[index + 1]
    if (!code || !path) continue
    files.push({ path, status: STATUS[code] ?? "modified" })
    // A rename is reported as two paths; the second is the old one and not a change of its own.
    if (code === "R" || code === "C") index++
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * Each checkpoint against the one before it.
 *
 * `checkpoints` must be oldest first — the order they were taken, which is the order the tasks ran.
 */
export async function filesPerTask(directory: string, checkpoints: Checkpoint[]): Promise<TouchedFiles[]> {
  const out: TouchedFiles[] = []
  for (const [index, checkpoint] of checkpoints.entries()) {
    const previous = checkpoints[index - 1]
    // For the first, the checkpoint's own parent: where the folder was when the run began.
    const from = previous?.sha ?? `${checkpoint.sha}^`
    // Each point knows the tree it was taken in (H-29); a worktree task's diff is not the run's.
    const files = await changedBetween(checkpoint.directory || directory, from, checkpoint.sha)
    out.push({
      ...(checkpoint.taskID ? { taskID: checkpoint.taskID } : {}),
      checkpointID: checkpoint.id,
      title: checkpoint.title,
      ...(checkpoint.summary ? { summary: checkpoint.summary } : {}),
      files,
    })
  }
  return out
}
