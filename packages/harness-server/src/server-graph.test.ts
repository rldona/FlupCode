/**
 * What the server is built from (PI-03): the modules reachable from `src/index.ts`, the entry the
 * server binary is compiled from. The adaptive layer's offline evaluation tools live in the dev-only
 * `@flupcode/adaptive-eval` package and must never be pulled into it, directly or through another
 * workspace package; and every adaptive decision kind it declares, it also asks.
 */

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { decisionKinds } from "./adaptive/decision"

const packages = path.resolve(import.meta.dir, "../..")
const transpilers = { ts: new Bun.Transpiler({ loader: "ts" }), tsx: new Bun.Transpiler({ loader: "tsx" }), js: new Bun.Transpiler({ loader: "js" }) }
const importsOf = (file: string) =>
  transpilers[file.endsWith(".tsx") ? "tsx" : file.endsWith(".ts") ? "ts" : "js"].scanImports(readFileSync(file, "utf8"))

test("the server imports nothing from the adaptive evaluation package", () => {
  const reached = serverModules()
  expect(reached.size).toBeGreaterThan(100)
  expect([...reached].map((file) => path.relative(packages, file)).filter((file) => file.startsWith("adaptive-eval/"))).toEqual([])
  const specifiers = [...reached].flatMap((file) => importsOf(file).map((entry) => entry.path))
  expect(specifiers.filter((specifier) => specifier.startsWith("@flupcode/adaptive-eval"))).toEqual([])
})

test("the evaluation tools are not part of the server any more", () => {
  const reached = [...serverModules()].map((file) => path.relative(packages, file))
  expect(reached).toContain("harness-server/src/adaptive/decision-service.ts")
  expect(reached.filter((file) => /adaptive\/(promotion\/|learning\/eval|learning\/heuristics-cli)/.test(file))).toEqual([])
})

// P8: a decision kind is declared because something in the server asks it, not for later. A kind's
// own module names it in its definition (PI-02), which is not asking it, so the modules are not read.
test("every decision kind is asked by the server", () => {
  const sources = [...serverModules()]
    .filter((file) => !file.includes("/adaptive/decisions/"))
    .map((file) => readFileSync(file, "utf8"))
  const unasked = decisionKinds().filter((kind) => !sources.some((source) => source.includes(`kind: "${kind}"`)))
  expect(unasked).toEqual([])
})

/** Every workspace source file reachable from the server entry; third-party packages are not walked. */
function serverModules() {
  const seen = new Set<string>()
  const pending = [path.join(packages, "harness-server/src/index.ts")]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    pending.push(...importsOf(file).flatMap((entry) => workspaceFile(entry.path, path.dirname(file))))
  }
  return seen
}

function workspaceFile(specifier: string, from: string): string[] {
  if (specifier.startsWith("bun:") || specifier.startsWith("node:")) return []
  const resolved = (() => {
    try {
      return Bun.resolveSync(specifier, from)
    } catch {
      return undefined
    }
  })()
  if (resolved === undefined || !path.isAbsolute(resolved)) return []
  if (!resolved.startsWith(packages + path.sep) || resolved.includes(`${path.sep}node_modules${path.sep}`)) return []
  return /\.(ts|tsx|js|mjs)$/.test(resolved) ? [resolved] : []
}
