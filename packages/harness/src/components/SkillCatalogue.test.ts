import { describe, expect, test } from "bun:test"
import {
  ignored,
  learnedActionCopy,
  learnedSkillActions,
  learnedSkillLabel,
  learnedStateLabel,
  notPickedUp,
  proposalStatusLabel,
  reviewable,
  withoutFiles,
} from "./SkillCatalogue"
import { setLocale, t } from "../i18n"
import type { SkillFile, SkillProposal } from "../types"

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

describe("the read-only learning labels (FH-073)", () => {
  test("a learned skill's state is titled, and one without a state is on probation", () => {
    expect(learnedStateLabel("mature")).toBe("Mature")
    expect(learnedStateLabel("archived")).toBe("Archived")
    expect(learnedStateLabel(undefined)).toBe("Probation")
  })

  test("a proposal's status is titled", () => {
    expect(proposalStatusLabel("proposed")).toBe("Proposed")
    expect(proposalStatusLabel("promoted")).toBe("Promoted")
    expect(proposalStatusLabel("rejected")).toBe("Rejected")
  })
})

describe("the human review of a proposal (AH-A04)", () => {
  const proposal = (status: SkillProposal["status"]): SkillProposal => ({
    id: "proposal:ep1",
    episodeID: "ep1",
    projectID: "/work/demo",
    intent: "add",
    name: "flaky-test-helper",
    evidenceRefs: [],
    status,
    createdAt: 1,
    updatedAt: 1,
  })

  test("only a staged proposal is reviewable, and only when the server announced the review", () => {
    expect(reviewable(proposal("proposed"), { review: true })).toBe(true)
    expect(reviewable(proposal("proposed"), { review: false })).toBe(false)
    expect(reviewable(proposal("promoted"), { review: true })).toBe(false)
    expect(reviewable(proposal("rejected"), { review: true })).toBe(false)
  })
})

describe("the actions on a learned skill (AH-E04)", () => {
  test("an enabled skill can be disabled or archived, a disabled one enabled or archived", () => {
    expect(learnedSkillActions({ disabled: false }, { manageSkills: true })).toEqual(["disable", "archive"])
    expect(learnedSkillActions({}, { manageSkills: true })).toEqual(["disable", "archive"])
    expect(learnedSkillActions({ disabled: true }, { manageSkills: true })).toEqual(["enable", "archive"])
  })

  test("nothing is offered when the server did not announce the actions", () => {
    expect(learnedSkillActions({ disabled: false }, { manageSkills: false })).toEqual([])
    expect(learnedSkillActions({ disabled: true }, { manageSkills: false })).toEqual([])
  })

  test("a disabled skill says so instead of its lifecycle state", () => {
    expect(learnedSkillLabel({ state: "mature", disabled: true })).toBe("Disabled")
    expect(learnedSkillLabel({ state: "mature", disabled: false })).toBe("Mature")
  })

  test("each confirmation says what changes for new sessions, never a field or a route", () => {
    for (const action of ["disable", "enable", "archive", "reject"] as const) {
      const copy = learnedActionCopy(action)
      expect(copy.message).not.toMatch(/adaptive\.|\/harness|enabled|learning\./)
    }
    expect(learnedActionCopy("disable").message).toContain("no longer be offered in new sessions")
    expect(learnedActionCopy("archive").message).toContain("nothing is deleted")
    expect(learnedActionCopy("enable").message).toContain("offered again in new sessions")
    expect(learnedActionCopy("reject").message).toContain("will not be installed")
  })

  test("every string of the actions has a Spanish translation", () => {
    setLocale("es")
    const strings = (["disable", "enable", "archive", "reject"] as const).flatMap((action) =>
      Object.values(learnedActionCopy(action)),
    )
    expect(strings.filter((text) => t(text) === text)).toEqual([])
    expect(t("Open file")).toBe("Abrir fichero")
    setLocale("en")
  })
})
