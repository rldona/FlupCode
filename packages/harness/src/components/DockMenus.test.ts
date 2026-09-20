import { expect, test } from "bun:test"
import { agentIconPath } from "./DockMenus"

test("the built-in agents keep their own icons", () => {
  expect(agentIconPath("plan")).not.toBe(agentIconPath("build"))
  expect(agentIconPath("plan").length).toBeGreaterThan(0)
  expect(agentIconPath("build").length).toBeGreaterThan(0)
})

test("any other agent gets the same robot", () => {
  const robot = agentIconPath("jornia")
  expect(robot.length).toBeGreaterThan(0)
  expect(agentIconPath("whatever")).toBe(robot)
  expect(robot).not.toBe(agentIconPath("plan"))
  expect(robot).not.toBe(agentIconPath("build"))
})
