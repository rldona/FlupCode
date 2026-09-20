import { describe, expect, test } from "bun:test"
import { DEFAULT_KEYBINDS, formatKeybind, keybindFromEvent, loadKeybinds, matchesKeybind, withKeybind } from "./keybinds"

const event = (over: Partial<Parameters<typeof matchesKeybind>[1]> & { key: string }) => ({
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
})

describe("matchesKeybind", () => {
  test("mod is Cmd on one platform and Ctrl on the other", () => {
    expect(matchesKeybind("mod+k", event({ key: "k", metaKey: true }))).toBe(true)
    expect(matchesKeybind("mod+k", event({ key: "k", ctrlKey: true }))).toBe(true)
    expect(matchesKeybind("mod+k", event({ key: "k" }))).toBe(false)
  })

  test("every modifier has to match, and no extra one may be held", () => {
    expect(matchesKeybind("mod+shift+k", event({ key: "k", metaKey: true, shiftKey: true }))).toBe(true)
    expect(matchesKeybind("mod+shift+k", event({ key: "k", metaKey: true }))).toBe(false)
    // Shift held but not part of the binding: not a match, or plain typing would trigger shortcuts.
    expect(matchesKeybind("mod+k", event({ key: "k", metaKey: true, shiftKey: true }))).toBe(false)
    expect(matchesKeybind("mod+alt+b", event({ key: "b", metaKey: true, altKey: true }))).toBe(true)
  })

  test("an empty binding matches nothing", () => {
    expect(matchesKeybind("", event({ key: "k", metaKey: true }))).toBe(false)
  })
})

describe("formatKeybind", () => {
  test("reads as symbols, in a fixed order", () => {
    expect(formatKeybind("mod+k")).toBe("⌘K")
    expect(formatKeybind("alt+mod+b")).toBe("⌘⌥B")
    expect(formatKeybind("mod+,")).toBe("⌘,")
    expect(formatKeybind("")).toBe("")
  })
})

describe("withKeybind", () => {
  test("a key belongs to one action: taking it clears the other", () => {
    const next = withKeybind(DEFAULT_KEYBINDS, "newSession", DEFAULT_KEYBINDS.palette)
    expect(next.newSession).toBe("mod+k")
    expect(next.palette).toBe("")
  })

  test("clearing one leaves the rest alone", () => {
    const next = withKeybind(DEFAULT_KEYBINDS, "palette", "")
    expect(next.palette).toBe("")
    expect(next.toggleSidebar).toBe(DEFAULT_KEYBINDS.toggleSidebar)
  })
})

describe("keybindFromEvent", () => {
  test("builds a canonical binding, and ignores a bare modifier", () => {
    expect(keybindFromEvent(event({ key: "K", metaKey: true, shiftKey: true }))).toBe("mod+shift+k")
    expect(keybindFromEvent(event({ key: "Meta", metaKey: true }))).toBeUndefined()
    expect(keybindFromEvent(event({ key: "Control", ctrlKey: true }))).toBeUndefined()
  })
})

describe("loadKeybinds", () => {
  test("fills unset actions from the defaults", () => {
    expect(loadKeybinds({ palette: "mod+p" })).toMatchObject({ palette: "mod+p", toggleSidebar: "mod+b" })
  })

  test("carries over the old single palette key until the map replaces it", () => {
    expect(loadKeybinds(undefined, "mod+j").palette).toBe("mod+j")
    // A map that already has a palette key wins over the old one.
    expect(loadKeybinds({ palette: "mod+p" }, "mod+j").palette).toBe("mod+p")
  })
})
