import { describe, expect, test } from "bun:test"
import { fieldsFor } from "./CommandsPanel"

const values = { description: "", agent: "", model: "", subtask: false, template: "" }

describe("the command form's fields", () => {
  test("only writes the ones that were filled in", () => {
    expect(fieldsFor(values, {})).toEqual({})
    expect(fieldsFor({ ...values, description: "Reviews", subtask: true }, {})).toEqual({
      description: "Reviews",
      subtask: true,
    })
    expect(fieldsFor({ ...values, description: "  spaced  " }, {})).toEqual({ description: "spaced" })
  })

  test("keeps keys the form does not know, the same promise the agent editor makes", () => {
    const original = { description: "Old", mode: "something_else", nested: { a: 1 } }
    expect(fieldsFor({ ...values, description: "New" }, original)).toEqual({
      mode: "something_else",
      nested: { a: 1 },
      description: "New",
    })
  })

  test("clearing a known key removes it rather than leaving it empty", () => {
    expect(fieldsFor(values, { description: "Old", agent: "build" })).toEqual({})
  })
})
