import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { closesModal, trapTarget } from "./Modal"

describe("Escape closes the dialog on top (UX-03)", () => {
  const press = (key: string, extra: Partial<KeyboardEvent> = {}) =>
    closesModal({ key, isComposing: false, defaultPrevented: false, ...extra })

  test("on Escape, whatever the dialog's close button is called", () => {
    // The old handler clicked a button labelled "Close" or "Cerrar"; a dialog without one, or a
    // third language, stayed open.
    expect(press("Escape")).toBe(true)
  })

  test("not on any other key", () => {
    for (const key of ["Esc", "Enter", "Tab", "q", "Backspace"]) expect(press(key)).toBe(false)
  })

  test("not while an input method is composing a word: that Escape cancels the word", () => {
    expect(press("Escape", { isComposing: true })).toBe(false)
  })

  test("not when something inside used it first, such as a key being recorded or a list of suggestions", () => {
    expect(press("Escape", { defaultPrevented: true })).toBe(false)
  })
})

describe("Tab stays inside the dialog (UX-03)", () => {
  test("past the last control it wraps to the first, and before the first to the last", () => {
    expect(trapTarget(4, 3, false)).toBe(0)
    expect(trapTarget(4, 0, true)).toBe(3)
  })

  test("between the two, the browser's own step is left alone", () => {
    expect(trapTarget(4, 1, false)).toBeUndefined()
    expect(trapTarget(4, 2, true)).toBeUndefined()
  })

  test("from the dialog itself, or from outside it, the focus comes in at the edge it moves toward", () => {
    expect(trapTarget(4, -1, false)).toBe(0)
    expect(trapTarget(4, -1, true)).toBe(3)
  })

  test("a dialog with nothing to focus keeps the focus on itself", () => {
    expect(trapTarget(0, -1, false)).toBe(-1)
    expect(trapTarget(0, -1, true)).toBe(-1)
  })
})

describe("every dialog is the Modal", () => {
  const SOURCE = join(import.meta.dir, "..")
  const files = () =>
    readdirSync(SOURCE, { recursive: true })
      .filter((name): name is string => typeof name === "string" && name.endsWith(".tsx"))
      .map((name) => ({ name, text: readFileSync(join(SOURCE, name), "utf8") }))

  test("no component draws a modal of its own", () => {
    // `aria-modal` and a backdrop are what a hand-rolled dialog writes; only Modal.tsx may.
    const offenders = files()
      .filter((file) => file.name !== join("components", "Modal.tsx"))
      .filter((file) => /aria-modal|fc-modal-backdrop"|<div class="fc-(?:remote-)?sheet-backdrop/.test(file.text))
      .map((file) => file.name)
    expect(offenders).toEqual([])
  })

  test("is reading the components, and the Modal is what they use", () => {
    const users = files().filter((file) => /<Modal\b/.test(file.text))
    expect(users.length).toBeGreaterThan(30)
  })
})
