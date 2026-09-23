#!/usr/bin/env bun

// Every file of ours inside an upstream package is a conflict we pay on every sync, and one the
// resolver only resolves correctly if they know it is there. This compares what `power` actually
// changes under `packages/` against the declared inventory and fails on anything undeclared, so a
// sync is never resolved against a stale docs/UPSTREAM.md.
//
//   bun script/upstream-inventory.ts            check, exits 1 on undeclared files
//   bun script/upstream-inventory.ts --update   rewrite the inventory from the current diff

import { $ } from "bun"
import path from "path"

const INVENTORY = "docs/upstream-inventory.txt"
const BASE = process.env.UPSTREAM_BASE ?? "origin/dev"

const root = (await $`git rev-parse --show-toplevel`.text()).trim()
const file = path.join(root, INVENTORY)

const declared = (await Bun.file(file).text())
  .split("\n")
  .map((line) => line.replace(/#.*$/, "").trim())
  .filter(Boolean)

// A trailing slash declares a whole subtree: our own packages, and the generated directories whose
// contents change name on every regeneration.
const covers = (entry: string, changed: string) => (entry.endsWith("/") ? changed.startsWith(entry) : entry === changed)

// No revision after the base: this diffs against the working tree, so a local edit is caught
// before it is committed. In CI the working tree is the commit under test, so it is the same thing.
const changed = (await $`git diff --name-only ${BASE} -- packages`.text())
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)

const undeclared = changed.filter((item) => !declared.some((entry) => covers(entry, item)))
const stale = declared.filter((entry) => !changed.some((item) => covers(entry, item)))

if (process.argv.includes("--update")) {
  const header = (await Bun.file(file).text()).split("\n").filter((line) => line.startsWith("#"))
  await Bun.write(file, [...header, "", ...collapse(changed, declared), ""].join("\n"))
  console.log(`${INVENTORY}: ${changed.length} files, ${undeclared.length} newly declared`)
  process.exit(0)
}

for (const entry of stale) console.log(`::warning::${entry} no longer differs from ${BASE}; drop it from ${INVENTORY}`)

if (undeclared.length === 0) {
  console.log(`${INVENTORY}: ${changed.length} changed files, all declared`)
  process.exit(0)
}

for (const item of undeclared)
  console.log(`::error file=${item}::${item} changes an upstream package and is not declared in ${INVENTORY}`)

console.log(
  [
    "",
    `${undeclared.length} file(s) change an upstream package without being declared.`,
    "",
    "Every such file is a conflict on every upstream sync, and docs/UPSTREAM.md is what tells the",
    "resolver whether to keep ours, take upstream, re-add a registry line or regenerate. Either move",
    "the change into one of our own packages, or declare it:",
    "",
    "  bun script/upstream-inventory.ts --update",
    "",
    "and describe it in the matching section of docs/UPSTREAM.md.",
  ].join("\n"),
)
process.exit(1)

// Keep the subtree entries the file already declares instead of expanding them into every file
// they cover: `packages/harness/` should stay one line, not four hundred.
function collapse(items: string[], entries: string[]) {
  const subtrees = entries.filter((entry) => entry.endsWith("/") && items.some((item) => item.startsWith(entry)))
  return [...subtrees, ...items.filter((item) => !subtrees.some((entry) => item.startsWith(entry)))].sort()
}
