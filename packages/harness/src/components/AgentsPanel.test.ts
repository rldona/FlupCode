import { describe, expect, test } from "bun:test"
import { OWNED, fieldsFrom, withoutFiles } from "./AgentsPanel"
import type { AgentFile } from "../types"

const form = {
  description: "",
  mode: "subagent",
  model: "",
  variant: "",
  temperature: "",
  steps: "",
  color: "",
  hidden: false,
  disable: false,
  tools: {} as Record<string, boolean>,
  permission: {} as Record<string, string>,
}

describe("what the form would write", () => {
  test("writes only what was filled in", () => {
    // An empty box is not a setting. Writing `model: ""` would pin the agent to a model with no
    // name instead of leaving it on the default.
    expect(fieldsFrom({ ...form, description: "Reviews a diff" }, {})).toEqual({
      description: "Reviews a diff",
      mode: "subagent",
    })
  })

  test("zero is a temperature somebody means, and empty is not zero", () => {
    expect(fieldsFrom({ ...form, temperature: "0" }, {}).temperature).toBe(0)
    expect(fieldsFrom({ ...form, temperature: "" }, {}).temperature).toBeUndefined()
    expect(fieldsFrom({ ...form, temperature: "nonsense" }, {}).temperature).toBeUndefined()
  })

  test("steps has to be a whole number of steps", () => {
    expect(fieldsFrom({ ...form, steps: "12" }, {}).steps).toBe(12)
    expect(fieldsFrom({ ...form, steps: "1.5" }, {}).steps).toBeUndefined()
    expect(fieldsFrom({ ...form, steps: "-3" }, {}).steps).toBeUndefined()
  })

  test("keys the form knows nothing about are carried over", () => {
    const written = fieldsFrom({ ...form, mode: "primary" }, { mode: "subagent", something_new: 42, top_p: 0.9 })
    expect(written).toMatchObject({ mode: "primary", something_new: 42, top_p: 0.9 })
  })

  test("a permission written as a map of patterns is not deleted by the form", () => {
    // The form draws `edit: deny` and cannot draw `edit: { "src/**": allow }`. Replacing the whole
    // `permission` key with what the form holds would quietly throw the second one away.
    const written = fieldsFrom(
      { ...form, permission: { bash: "ask" } },
      { permission: { bash: "deny", edit: { "src/**": "allow" } } },
    )
    expect(written.permission).toEqual({ bash: "ask", edit: { "src/**": "allow" } })
  })

  test("the switched-off tools survive as a map", () => {
    expect(fieldsFrom({ ...form, tools: { "*": false, read: true } }, {}).tools).toEqual({ "*": false, read: true })
  })

  test("everything the form draws is listed as owned", () => {
    // Otherwise a field would be both written from the form and carried over from the file, and
    // the carried one would win.
    for (const key of ["description", "mode", "model", "variant", "temperature", "steps", "color", "tools"]) {
      expect(OWNED).toContain(key as (typeof OWNED)[number])
    }
  })
})

describe("agents with no file", () => {
  const file = (name: string) => ({ name, path: `/p/${name}.md` }) as AgentFile

  test("are the ones the engine reports and nothing here can change", () => {
    const orphans = withoutFiles(
      [
        { id: "build", description: "The default" },
        { id: "reviewer", description: "Mine" },
      ] as never,
      [file("reviewer")],
    )
    expect(orphans.map((agent) => agent.id)).toEqual(["build"])
  })

  test("none when every agent has one", () => {
    expect(withoutFiles([{ id: "reviewer" }] as never, [file("reviewer")])).toEqual([])
  })
})
