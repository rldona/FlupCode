import { expect, test } from "bun:test"
import { agentIcon } from "./DockMenus"

test("the built-in agents keep their own icons", () => {
  expect(agentIcon("plan")).toBe("bulb")
  expect(agentIcon("build")).toBe("hammer")
})

test("any other agent gets the same robot", () => {
  expect(agentIcon("custom")).toBe("robot")
  expect(agentIcon("whatever")).toBe("robot")
})
