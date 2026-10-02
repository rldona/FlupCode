import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * The engine boundary (V2-10, ADR-0027): OpenCode 2's generated client is imported by the adapter
 * (V2-20) and its event reducer (V2-21), and nowhere else, so a pin bump that changes it changes them
 * alone. Nothing imports the vendored upstream packages any more.
 */
const ALLOWED = new Set(["engine/v2.ts", "engine/v2-convert.ts", "engine/v2-events.ts"])

const root = join(import.meta.dir, "..")
const files = (function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return walk(path)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
})(root)

test("only the engine adapter imports OpenCode 2's client, and nothing an upstream workspace package", () => {
  const importers = (pattern: RegExp) =>
    files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file))
      .sort()
  expect(importers(/from "@opencode-ai\//)).toEqual([])
  expect(importers(/from "@opencode\/client/)).toEqual([...ALLOWED].sort())
})

/**
 * The same rule for calls (TI-12): a raw `fetch` to an engine route outside `src/engine/` is what
 * broke the terminal and the config editor in the 2.x migration without a test noticing (§3.3 A1).
 * Every source file outside the adapter is read with its comments stripped, and any string or
 * template piece that starts with an engine route fails the test. A route starts a literal, follows
 * an interpolation (`${base}/config`) or a port; `/harness/…` routes and module paths do not.
 */
test("no engine route is written outside the engine adapter", () => {
  const transpiler = new Bun.Transpiler({ loader: "tsx" })
  const raw = files
    .filter((file) => !relative(root, file).startsWith("engine/"))
    .flatMap((file) =>
      engineRoutes(transpiler.transformSync(readFileSync(file, "utf8"))).map(
        (route) => `${relative(root, file)}: ${route}`,
      ),
    )
  expect(raw).toEqual([])
})

test("the route rule catches a raw engine fetch and leaves harness routes alone", () => {
  expect(engineRoutes('fetch(`${base()}/config`)')).toEqual(["/config"])
  expect(engineRoutes('engineFetch(base + "/pty/" + id)')).toEqual(["/pty"])
  expect(engineRoutes('fetch("/session?directory=x")')).toEqual(["/session"])
  expect(engineRoutes('fetch("http://127.0.0.1:4096/api/session")')).toEqual(["/api/"])
  expect(engineRoutes('fetch(`${url}/global/config`)')).toEqual(["/global/"])
  expect(
    engineRoutes(
      'harness("/harness/config-files"); harness("/harness/session-prefs"); import("./session-title"); const p = "/path/to/config"; const u = "https://api.example.com/v1"',
    ),
  ).toEqual([])
})

/** The engine routes a piece of compiled source names: `/pty`, `/config`, `/session`, `/api/`, `/global/`. */
function engineRoutes(source: string) {
  return [...source.matchAll(/(?<=["'`}]|:\d+)\/(?:api\/|global\/|(?:pty|config|session)(?=[/?#"'`$]))/g)].map(
    (match) => match[0],
  )
}
