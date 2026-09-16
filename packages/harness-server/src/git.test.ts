import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { branch, commit, currentBranch, isRepository } from "./git"

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
