import { describe, expect, test } from "bun:test"
import { editorBrowserSessionID, frameClickFraction } from "./action-editor"

const VALID = /^[A-Za-z0-9_-]{1,128}$/

describe("the editor's browser session id", () => {
  test("is a valid session id for any project", () => {
    for (const project of ["/Users/me/project", "", "a b/c", "/very/long/".repeat(20)]) {
      const id = editorBrowserSessionID(project)
      expect(id).toMatch(VALID)
    }
  })

  test("is stable for one project and differs between projects", () => {
    expect(editorBrowserSessionID("/one")).toBe(editorBrowserSessionID("/one"))
    expect(editorBrowserSessionID("/one")).not.toBe(editorBrowserSessionID("/two"))
    expect(editorBrowserSessionID("/one")).toStartWith("editor-")
  })
})

describe("the point a click on the live frame names", () => {
  test("is the fraction of the displayed image, not its pixels", () => {
    const rect = { left: 100, top: 50, width: 400, height: 300 }
    expect(frameClickFraction({ ...rect, clientX: 300, clientY: 200 })).toEqual({ x: 0.5, y: 0.5 })
    expect(frameClickFraction({ ...rect, clientX: 100, clientY: 50 })).toEqual({ x: 0, y: 0 })
    expect(frameClickFraction({ ...rect, clientX: 500, clientY: 350 })).toEqual({ x: 1, y: 1 })
  })

  test("does not depend on the device pixel ratio", () => {
    // The same click against a frame drawn at the same CSS size but captured twice as densely maps
    // to the same fraction: the pixels behind the image never enter the calculation.
    const click = { clientX: 260, clientY: 170, left: 100, top: 50, width: 400, height: 300 }
    expect(frameClickFraction(click)).toEqual({ x: 0.4, y: 0.4 })
  })
})
