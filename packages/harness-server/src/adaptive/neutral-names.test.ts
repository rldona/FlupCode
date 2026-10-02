import { describe, expect, test } from "bun:test"
import { join } from "node:path"

/**
 * PI-01: no config key, persisted field, wire field or comment outside a provider's own module names
 * that provider. The name lives only in `providers/jev*.ts`, in the legacy shim that reads the old
 * names (`legacy.ts`), in fixtures and in tests, which exercise the provider by its registry id and the
 * old shapes on purpose. An import specifier is where a module lives, not a name a reader or a config
 * sees, so the one that registers the provider is not counted.
 */
const ROOT = join(import.meta.dir, "..")
const EXEMPT = [/^adaptive\/providers\/jev[^/]*\.ts$/, /^adaptive\/legacy\.ts$/, /(^|\/)fixtures\//, /\.test\.ts$/]
const SPECIFIER = /from "[^"]*\/providers\/jev"/g

describe("provider-neutral names (PI-01)", () => {
  test("no server source outside the provider's module, the legacy shim and fixtures names it", async () => {
    const files = [...new Bun.Glob("**/*.ts").scanSync(ROOT)].filter((file) => !EXEMPT.some((rule) => rule.test(file)))
    expect(files.length).toBeGreaterThan(100)
    const hits = (
      await Promise.all(
        files.map(async (file) =>
          (await Bun.file(join(ROOT, file)).text())
            .split("\n")
            .flatMap((line, index) =>
              /jev|typesafe/i.test(line.replace(SPECIFIER, "")) ? [`${file}:${index + 1}: ${line.trim()}`] : [],
            ),
        ),
      )
    ).flat()
    expect(hits).toEqual([])
  })
})
