#!/usr/bin/env bun
/**
 * repo-hygiene: fail if the public repository carries references to the private FlupCode content
 * (Isobaria, Jornia, Plazoleta, …) or to a particular machine.
 *
 * FlupCode is generic: that content lives in the reader's own configuration, never here. This is the
 * check that stops a stray `git add .` after copying a private `.opencode/` into the repo. It only
 * looks at tracked files, and it names the patterns itself, so this script and its workflow are
 * excluded on purpose. See docs/CONFIGURATION.md.
 */

const PATTERN = "isobaria|jornia|plazoleta|lovercast|carmela|/Users/raul"
const EXCLUDES = ["script/repo-hygiene.ts", ".github/workflows/repo-hygiene.yml"]

const result = Bun.spawnSync(
  ["git", "grep", "-I", "-n", "-i", "-E", PATTERN, "--", ".", ...EXCLUDES.map((path) => `:(exclude)${path}`)],
  { stdout: "pipe", stderr: "pipe" },
)

const output = result.stdout.toString().trim()

// `git grep` exits 1 when nothing matches, which is the healthy case.
if (result.exitCode === 1 && !output) {
  console.log("repo-hygiene: ok, no private references in tracked files")
  process.exit(0)
}

if (output) {
  console.error("repo-hygiene: private references found in the public repository:\n")
  console.error(output)
  console.error("\nMove that content to your own configuration (docs/CONFIGURATION.md).")
  process.exit(1)
}

console.error("repo-hygiene: git grep failed:\n" + result.stderr.toString())
process.exit(2)
