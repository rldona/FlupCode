import { describe, expect, test } from "bun:test"
import { needsModelSwitchWarning } from "./model-switch"

const current = { providerID: "opencode-go", id: "deepseek-v4.1-flash" }
const asked = { enabled: true, history: true, current, next: { providerID: "anthropic", id: "claude-opus-5" } }

describe("model switch warning", () => {
  test("warns when an active session moves to another model", () => {
    expect(needsModelSwitchWarning(asked)).toBe(true)
    // Another provider offering the same id is still another model.
    expect(needsModelSwitchWarning({ ...asked, next: { providerID: "anthropic", id: current.id } })).toBe(true)
  })

  test("stays quiet when the session keeps its model", () => {
    expect(needsModelSwitchWarning({ ...asked, next: { providerID: current.providerID, id: current.id } })).toBe(false)
  })

  test("stays quiet when there is nothing to re-read, or no model to name", () => {
    expect(needsModelSwitchWarning({ ...asked, history: false })).toBe(false)
    expect(needsModelSwitchWarning({ ...asked, current: undefined })).toBe(false)
  })

  test("stays quiet once the reader asked not to be told again", () => {
    expect(needsModelSwitchWarning({ ...asked, enabled: false })).toBe(false)
  })
})
