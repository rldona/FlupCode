import { describe, expect, test } from "bun:test"
import { listedFolder } from "./elsewhere"

describe("where another computer's project is listed (ADR-0029)", () => {
  const ours = ["/Users/raul/workspace/opencode-ui-power", "/Users/raul/workspace/OpenLibrary", "/Users/raul/app"]
  const mine = {
    "/Users/raul/workspace/opencode-ui-power": "rldona/FlupCode",
    "/Users/raul/workspace/OpenLibrary": null,
    "/Users/raul/app": "rldona/app",
  }

  test("under this computer's folder of the same repository, whatever either is called", () => {
    expect(
      listedFolder({
        directory: "/home/rldona/FlupCode",
        theirs: { "/home/rldona/FlupCode": "rldona/FlupCode" },
        ours,
        mine,
      }),
    ).toBe("/Users/raul/workspace/opencode-ui-power")
  })

  test("by the folder's name when there is no repository to go by", () => {
    expect(listedFolder({ directory: "/home/rldona/openlibrary/", theirs: {}, ours, mine })).toBe(
      "/Users/raul/workspace/OpenLibrary",
    )
  })

  test("not under a folder of the same name that holds another repository", () => {
    expect(
      listedFolder({ directory: "/home/rldona/app", theirs: { "/home/rldona/app": "someone/app" }, ours, mine }),
    ).toBe("/home/rldona/app")
  })

  test("where it is when this computer has nothing like it, or the same path", () => {
    expect(listedFolder({ directory: "/home/rldona/strava-decoded", theirs: {}, ours, mine })).toBe(
      "/home/rldona/strava-decoded",
    )
    expect(listedFolder({ directory: "/Users/raul/app", theirs: {}, ours, mine })).toBe("/Users/raul/app")
  })
})
