import { describe, expect, test } from "bun:test"
import { parsePlan } from "./plan"

describe("reading a plan's steps (H-28)", () => {
  test("reads the fenced json block an answer ends with", () => {
    const text = `Here is the plan.

- first, in prose

\`\`\`json
["Add the route", "Write the test", "Update the docs"]
\`\`\`
`
    expect(parsePlan(text)).toEqual(["Add the route", "Write the test", "Update the docs"])
  })

  test("takes objects by any of the names a model gives a step", () => {
    expect(parsePlan('```json\n[{"title": "One"}, {"task": "Two"}, {"summary": "Three"}]\n```')).toEqual([
      "One",
      "Two",
      "Three",
    ])
    // A holder object is read too, and the last block wins: an answer explains and then lists.
    expect(parsePlan('```json\n{"steps": ["a", "b"]}\n```')).toEqual(["a", "b"])
  })

  test("nothing to read is not a failure", () => {
    expect(parsePlan(undefined)).toEqual([])
    expect(parsePlan("just prose with no block")).toEqual([])
    expect(parsePlan("```json\nnot json\n```")).toEqual([])
    // A block that parses but names nothing usable is not the plan.
    expect(parsePlan('```json\n[{"file": "a.ts"}]\n```')).toEqual([])
    expect(parsePlan("```json\n[]\n```")).toEqual([])
  })

  test("a bare array with no fence is still a plan", () => {
    expect(parsePlan('["just one"]')).toEqual(["just one"])
  })
})
