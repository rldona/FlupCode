import { describe, expect, test } from "bun:test"
import { join } from "node:path"

/**
 * PI-01: no UI string, wire field or comment in the app names a predictive provider. A provider's name
 * is data the server serves (`providers[].name`); the only module that reads the names an older server
 * still sends is `adaptive-legacy.ts`. Tests exercise both shapes on purpose and are not counted.
 */
const EXEMPT = [/^adaptive-legacy\.ts$/, /\.test\.tsx?$/]

describe("provider-neutral names (PI-01)", () => {
  test("no app source outside the legacy shim names a provider", async () => {
    const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(import.meta.dir)].filter(
      (file) => !EXEMPT.some((rule) => rule.test(file)),
    )
    expect(files.length).toBeGreaterThan(100)
    const hits = (
      await Promise.all(
        files.map(async (file) =>
          (await Bun.file(join(import.meta.dir, file)).text())
            .split("\n")
            .flatMap((line, index) => (/jev|typesafe/i.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
        ),
      )
    ).flat()
    expect(hits).toEqual([])
  })
})
