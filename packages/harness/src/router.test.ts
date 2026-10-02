import { describe, expect, test } from "bun:test"
import { DIALOGS, dialogFromSearch, searchForDialog, searchWithoutDialog } from "./router"

describe("a dialog's link", () => {
  test("names every dialog that opens without a target, and reads back what it wrote", () => {
    expect(DIALOGS).toHaveLength(12)
    for (const dialog of DIALOGS) expect(dialogFromSearch(searchForDialog(dialog))).toEqual({ dialog })
  })

  test("opens Settings on a section", () => {
    expect(searchForDialog("settings", "providers")).toBe("?dialog=settings&section=providers")
    expect(dialogFromSearch("?dialog=settings&section=providers")).toEqual({ dialog: "settings", section: "providers" })
  })

  test("drops a section Settings does not have, and a section on another dialog", () => {
    expect(dialogFromSearch("?dialog=settings&section=nowhere")).toEqual({ dialog: "settings" })
    expect(dialogFromSearch("?dialog=about&section=providers")).toEqual({ dialog: "about" })
    expect(searchForDialog("about", "providers")).toBe("?dialog=about")
  })

  test("claims nothing for a dialog that needs a target or does not exist", () => {
    expect(dialogFromSearch("")).toBeUndefined()
    expect(dialogFromSearch("?dialog=rename")).toBeUndefined()
    expect(dialogFromSearch("?dialog=")).toBeUndefined()
    expect(dialogFromSearch("?left=a&right=b")).toBeUndefined()
  })

  test("is taken out of the address and leaves the rest of the query", () => {
    expect(searchWithoutDialog("?dialog=settings&section=mcp")).toBe("")
    expect(searchWithoutDialog("?left=a&dialog=about&right=b")).toBe("?left=a&right=b")
    expect(searchWithoutDialog("?decision=d1")).toBe("?decision=d1")
  })
})
