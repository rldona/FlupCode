import { describe, expect, test } from "bun:test"
import { ignored, notPickedUp, withoutFiles } from "./SkillCatalogue"
import type { SkillFile } from "../types"

const file = (over: Partial<SkillFile>): SkillFile => ({
  path: "/p/.opencode/skills/one/SKILL.md",
  scope: "project",
  root: "/p/.opencode/skills",
  bytes: 100,
  loaded: true,
  ...over,
})

describe("the ones that are not loaded", () => {
  test("are what this screen is for", () => {
    const files = [
      file({ name: "one" }),
      file({ path: "/p/two.md", loaded: false, reason: "Only a file called SKILL.md is loaded" }),
    ]
    expect(ignored(files).map((entry) => entry.path)).toEqual(["/p/two.md"])
  })
})

describe("skills with no file behind them", () => {
  test("are the ones the engine has and the disk does not explain", () => {
    const skills = [{ name: "customize-opencode" }, { name: "one" }] as never
    expect(withoutFiles(skills, [file({ name: "one" })]).map((skill) => skill.name)).toEqual(["customize-opencode"])
  })

  test("a file that exists but is not loaded does not count as explaining one", () => {
    // Otherwise a broken skill file would hide the fact that the engine does not have that skill.
    const skills = [{ name: "one" }] as never
    const broken = file({ name: "one", loaded: false, reason: "It has no `name`" })
    expect(withoutFiles(skills, [broken]).map((skill) => skill.name)).toEqual(["one"])
  })
})

describe("written and not picked up", () => {
  test("is a file the engine would load that the engine does not have", () => {
    // Measured against a real engine: a skill written after the folder was opened does not appear
    // at all until it is opened again. From the outside that is identical to a broken one.
    const files = [file({ name: "added-later" }), file({ name: "effect" })]
    const skills = [{ name: "effect" }] as never
    expect(notPickedUp(skills, files).map((entry) => entry.name)).toEqual(["added-later"])
  })

  test("a file with a mistake in it is not counted here", () => {
    // It belongs under the mistake, which says what to fix.
    const broken = file({ name: "added-later", loaded: false, reason: "It has no `name`" })
    expect(notPickedUp([] as never, [broken])).toEqual([])
  })
})
