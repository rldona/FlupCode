import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { branch, commit, currentBranch, discard, isRepository, mergeBranch } from "./git"

/** A throwaway repository. Every test here writes to git, so none of them may share one. */
let directory = ""

const run = async (args: string[]) => {
  const child = Bun.spawn(["git", ...args], { cwd: directory, stdout: "pipe", stderr: "pipe" })
  await child.exited
  return (await new Response(child.stdout).text()).trim()
}

const write = (name: string, body: string) => writeFileSync(join(directory, name), body)

beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "flupcode-git-"))
  await run(["init", "-q", "-b", "main"])
  await run(["config", "user.email", "test@example.com"])
  await run(["config", "user.name", "Test"])
  write("kept.txt", "one\n")
  await run(["add", "-A"])
  await run(["commit", "-qm", "first"])
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe("commit", () => {
  test("commits only what was named, and leaves the rest alone", async () => {
    write("kept.txt", "two\n")
    write("other.txt", "untouched\n")

    const made = await commit({ directory, message: "change the one file", paths: ["kept.txt"] })

    expect(made.subject).toBe("change the one file")
    expect(made.branch).toBe("main")
    expect(made.sha).toMatch(/^[0-9a-f]{7,}$/)
    expect(await run(["show", "--stat", "--name-only", "--pretty=", "HEAD"])).toBe("kept.txt")
    // The file that was not named is still sitting there uncommitted, which is the point of naming.
    expect(await run(["status", "--porcelain"])).toContain("other.txt")
  })

  test("a new file is committed too, not skipped for being untracked", async () => {
    write("added.txt", "new\n")
    await commit({ directory, message: "add one", paths: ["added.txt"] })
    expect(await run(["show", "--name-only", "--pretty=", "HEAD"])).toBe("added.txt")
  })

  test("a deleted file is committed as a deletion", async () => {
    rmSync(join(directory, "kept.txt"))
    await commit({ directory, message: "drop one", paths: ["kept.txt"] })
    expect(await run(["show", "--diff-filter=D", "--name-only", "--pretty=", "HEAD"])).toBe("kept.txt")
  })

  test("refuses a path git does not report as changed", async () => {
    // Confinement: what may be written is what this folder says has changed, and nothing else.
    expect(commit({ directory, message: "m", paths: ["../escape.txt"] })).rejects.toThrow(/No longer changed/)
    expect(commit({ directory, message: "m", paths: ["kept.txt"] })).rejects.toThrow(/No longer changed/)
  })

  test("refuses an empty message and an empty selection", async () => {
    write("kept.txt", "two\n")
    expect(commit({ directory, message: "  ", paths: ["kept.txt"] })).rejects.toThrow(/needs a message/)
    expect(commit({ directory, message: "m", paths: [] })).rejects.toThrow(/Nothing was selected/)
  })

  test("a message is an argument, never a shell word", async () => {
    write("kept.txt", "two\n")
    // Through `sh -c` this would have written the file. Through argv it is just a subject line.
    await commit({ directory, message: '"; touch owned.txt; echo "', paths: ["kept.txt"] })
    expect(await run(["status", "--porcelain"])).not.toContain("owned.txt")
    expect(await run(["log", "-1", "--pretty=%s"])).toBe('"; touch owned.txt; echo "')
  })

  test("says so when the folder is not a repository", async () => {
    const plain = mkdtempSync(join(tmpdir(), "flupcode-plain-"))
    expect(commit({ directory: plain, message: "m", paths: ["a"] })).rejects.toThrow(/not a git repository/)
    rmSync(plain, { recursive: true, force: true })
  })

  test("stages only the chosen hunk, and leaves the other in the working tree", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    write("many.txt", `${lines.join("\n")}\n`)
    await run(["add", "-A"])
    await run(["commit", "-qm", "add many"])
    write("many.txt", [`CHANGED 1`, ...lines.slice(1, 19), `CHANGED 20`].join("\n") + "\n")

    await commit({ directory, message: "only the first hunk", paths: ["many.txt"], hunks: { "many.txt": [0] } })

    const committed = await run(["show", "--pretty=", "HEAD"])
    expect(committed).toContain("CHANGED 1")
    expect(committed).not.toContain("CHANGED 20")
    // The hunk that was not chosen is still there to commit next, or to discard.
    expect(await run(["diff", "--", "many.txt"])).toContain("CHANGED 20")
    expect(readFileSync(join(directory, "many.txt"), "utf8")).toContain("CHANGED 20")
  })

  test("a hunk commit still refuses a path git does not report as changed", async () => {
    expect(commit({ directory, message: "m", paths: ["kept.txt"], hunks: { "kept.txt": [0] } })).rejects.toThrow(
      /No longer changed/,
    )
  })
})

describe("discard", () => {
  test("puts a whole file back to what git has", async () => {
    write("kept.txt", "two\n")
    await discard({ directory, path: "kept.txt" })
    expect(readFileSync(join(directory, "kept.txt"), "utf8")).toBe("one\n")
  })

  test("removes a file git has never seen when the whole file is discarded", async () => {
    write("new.txt", "hi\n")
    await discard({ directory, path: "new.txt" })
    expect(existsSync(join(directory, "new.txt"))).toBe(false)
  })

  test("discards only the chosen hunk from the working tree", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`)
    write("many.txt", `${lines.join("\n")}\n`)
    await run(["add", "-A"])
    await run(["commit", "-qm", "add many"])
    write("many.txt", [`CHANGED 1`, ...lines.slice(1, 19), `CHANGED 20`].join("\n") + "\n")

    // Hunks are numbered as the diff shows them: index 1 is the later change.
    await discard({ directory, path: "many.txt", hunks: [1] })

    const left = readFileSync(join(directory, "many.txt"), "utf8")
    expect(left).toContain("CHANGED 1")
    expect(left).not.toContain("CHANGED 20")
    expect(left).toContain("line 20")
  })

  test("a new file has no hunks to choose, and says so", async () => {
    write("new.txt", "hi\n")
    expect(discard({ directory, path: "new.txt", hunks: [0] })).rejects.toThrow(/has no hunks/)
  })

  test("refuses a path that is not changed", async () => {
    expect(discard({ directory, path: "kept.txt" })).rejects.toThrow(/not changed/)
  })
})

describe("branch", () => {
  test("starts one and moves onto it, bringing uncommitted work along", async () => {
    write("kept.txt", "two\n")

    expect(await branch({ directory, name: "feature/thing" })).toEqual({ branch: "feature/thing" })

    expect(await currentBranch(directory)).toBe("feature/thing")
    expect(await run(["status", "--porcelain"])).toContain("kept.txt")
  })

  test("refuses a name git would refuse, and one that is taken", async () => {
    expect(branch({ directory, name: "has spaces" })).rejects.toThrow(/not a name git accepts/)
    expect(branch({ directory, name: "main" })).rejects.toThrow(/already a branch/)
    expect(branch({ directory, name: " " })).rejects.toThrow(/needs a name/)
  })
})

test("isRepository tells the two apart", async () => {
  expect(await isRepository(directory)).toBe(true)
  const plain = mkdtempSync(join(tmpdir(), "flupcode-plain-"))
  expect(await isRepository(plain)).toBe(false)
  rmSync(plain, { recursive: true, force: true })
})

test("a missing git is an answer, not a crash", async () => {
  // `Bun.spawn` throws for a binary that is not on PATH. Left to propagate it would come out of the
  // API as a 500 rather than as "this folder is not a git repository".
  const empty = mkdtempSync(join(tmpdir(), "flupcode-nopath-"))
  const previous = process.env.PATH
  process.env.PATH = empty
  try {
    expect(await isRepository(directory)).toBe(false)
    expect(await currentBranch(directory)).toBe("")
    expect(commit({ directory, message: "m", paths: ["kept.txt"] })).rejects.toThrow(/not a git repository/)
  } finally {
    process.env.PATH = previous
    rmSync(empty, { recursive: true, force: true })
  }
})

describe("merging a worktree's branch back (H-29)", () => {
  const onFeature = async () => {
    await run(["checkout", "-q", "-b", "feature"])
    write("kept.txt", "two\n")
    await run(["add", "-A"])
    await run(["commit", "-qm", "feature change"])
    await run(["checkout", "-q", "main"])
  }

  test("merges a branch with a commit of its own, and says so in the history", async () => {
    await onFeature()

    const merged = await mergeBranch({ directory, branch: "feature", message: "Merge feature" })

    expect(merged.branch).toBe("feature")
    expect(await run(["log", "-1", "--pretty=%s"])).toBe("Merge feature")
    expect(readFileSync(join(directory, "kept.txt"), "utf8")).toBe("two\n")
  })

  test("refuses a branch that is not there", async () => {
    expect(mergeBranch({ directory, branch: "nope" })).rejects.toThrow(/no branch called/)
  })

  test("a conflict is aborted, not left half-merged", async () => {
    await run(["checkout", "-q", "-b", "feature"])
    write("kept.txt", "feature\n")
    await run(["add", "-A"])
    await run(["commit", "-qm", "feature"])
    await run(["checkout", "-q", "main"])
    write("kept.txt", "main\n")
    await run(["add", "-A"])
    await run(["commit", "-qm", "main"])

    expect(mergeBranch({ directory, branch: "feature" })).rejects.toThrow(/Could not merge/)

    // The folder is clean and not mid-merge, so the reader can just try again.
    expect(await run(["status", "--porcelain"])).toBe("")
    expect(await run(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"])).toBe("")
  })
})
