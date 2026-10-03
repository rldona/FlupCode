import { describe, expect, test } from "bun:test"
import {
  DESTINATIONS,
  MOVED_DIALOGS,
  MOVED_PATHS,
  PICKERS,
  SCREENS,
  SETTINGS_GROUPS,
  destination,
  offered,
  urlForDestination,
} from "./navigation"
import { DIALOGS, dialogFromSearch, movedFromSearch } from "./router"
import { movedFromPath, screenFromPath } from "./screen"
import { search } from "./components/CommandPalette"
import { KEYBIND_ACTIONS } from "./keybinds"
import { t, setLocale } from "./i18n"

const sources = {
  commands: [],
  sessions: [],
  projects: [],
  artifacts: [],
  routines: [],
  runs: [],
  workflows: [],
  files: [],
}

describe("the destinations (UX-01)", () => {
  test("each has one id and one name, and no two share either", () => {
    const ids = DESTINATIONS.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    const titles = DESTINATIONS.map((entry) => entry.title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  test("each has an address that leads back to it", () => {
    for (const entry of DESTINATIONS) {
      const url = new URL(urlForDestination(entry), "http://app")
      if (entry.screen) {
        expect(screenFromPath(url.pathname)).toBe(entry.screen)
        continue
      }
      expect(url.pathname).toBe("/")
      const linked = dialogFromSearch(url.search)
      expect(linked?.dialog).toBe(entry.dialog!)
      expect(linked?.section).toBe(entry.section)
    }
  })

  test("is each screen's and each dialog's only entry, apart from the pickers", () => {
    for (const screen of SCREENS) expect(DESTINATIONS.filter((entry) => entry.screen === screen)).toHaveLength(1)
    // Settings is one dialog with a destination per section; every other dialog is one destination.
    for (const dialog of DIALOGS.filter((name) => name !== "settings" && !PICKERS.some((picker) => picker === name)))
      expect(DESTINATIONS.filter((entry) => entry.dialog === dialog)).toHaveLength(1)
    expect(DESTINATIONS.filter((entry) => entry.dialog === "settings" && !entry.section).map((entry) => entry.id)).toEqual([
      "settings",
    ])
  })

  test("all of them are in the search, under their own name", () => {
    const found = search("", { ...sources, places: offered(true) }).filter((item) => item.kind === "place")
    expect(found.map((item) => item.value)).toEqual(DESTINATIONS.map((entry) => entry.id))
    for (const item of found) expect(item.label).toBe(t(destination(item.value as never)!.title))
  })

  test("a search finds a destination by its name in either language, and by its id", () => {
    setLocale("es")
    try {
      const places = offered(true)
      const named = (query: string) =>
        search(query, { ...sources, places })
          .filter((item) => item.kind === "place")
          .map((item) => item.value)
      expect(named("ejecuciones")).toContain("runs")
      expect(named("runs")).toContain("runs")
      expect(named("providers")).toEqual(["settings-providers"])
    } finally {
      setLocale("en")
    }
  })

  test("the browser build is not offered what only the desktop app can run", () => {
    const desktopOnly = DESTINATIONS.filter((entry) => entry.desktop).map((entry) => entry.id)
    expect(desktopOnly).toEqual(["actions"])
    expect(offered(false).map((entry) => entry.id)).not.toContain("actions")
    expect(offered(true).map((entry) => entry.id)).toContain("actions")
  })

  test("the sidebar holds the work primitives, and Settings configuration only", () => {
    expect(DESTINATIONS.filter((entry) => entry.home === "sidebar").map((entry) => entry.id)).toEqual([
      "runs",
      "workflows",
      "routines",
      "artifacts",
      "cost",
    ])
    // What Settings opens is either one of its sections or a dialog that edits the engine's files.
    const inSettings = DESTINATIONS.filter((entry) => entry.home === "settings" || entry.home === "advanced")
    expect(inSettings.filter((entry) => entry.home === "advanced").map((entry) => entry.id)).toEqual([
      "config",
      "config-files",
    ])
    expect(inSettings.filter((entry) => entry.home === "settings").map((entry) => entry.section)).toEqual(
      SETTINGS_GROUPS.flatMap((group) => group.items.map((item) => item.id)),
    )
  })

  test("a shortcut that opens a destination is one Settings can rebind", () => {
    const bound = DESTINATIONS.filter((entry) => entry.keybind)
    expect(bound.map((entry) => entry.id)).toEqual(["settings"])
    for (const entry of bound) expect(KEYBIND_ACTIONS).toContain(entry.keybind!)
  })

  test("is named in Spanish too", () => {
    setLocale("es")
    try {
      // "Skills" is the one name both languages share.
      for (const entry of DESTINATIONS.filter((entry) => entry.title !== "Skills"))
        expect(t(entry.title)).not.toBe(entry.title)
    } finally {
      setLocale("en")
    }
  })
})

describe("an address from before UX-01", () => {
  test("leads to a destination that exists, and is not itself a destination any more", () => {
    for (const [path, id] of Object.entries(MOVED_PATHS)) {
      expect(destination(id)).toBeDefined()
      expect(screenFromPath(`/${path}`)).toBeUndefined()
      expect(movedFromPath(`/${path}`)).toBe(id)
    }
    for (const [name, id] of Object.entries(MOVED_DIALOGS)) {
      expect(destination(id)).toBeDefined()
      expect(dialogFromSearch(`?dialog=${name}`)).toBeUndefined()
      expect(movedFromSearch(`?dialog=${name}`)).toBe(id)
    }
  })

  test("is these: the cost screen's old path, the agents screen and the skill picker", () => {
    expect(movedFromPath("/usage")).toBe("cost")
    expect(movedFromPath("/agents/")).toBe("settings-agents")
    expect(movedFromSearch("?dialog=skills")).toBe("skills")
    // Nothing else is read as moved: an unknown address is still the home screen.
    expect(movedFromPath("/")).toBeUndefined()
    expect(movedFromPath("/toString")).toBeUndefined()
    expect(movedFromSearch("?dialog=constructor")).toBeUndefined()
  })
})
