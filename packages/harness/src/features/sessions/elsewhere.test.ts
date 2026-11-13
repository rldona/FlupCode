import { describe, expect, test } from "bun:test"
import { listedFolder } from "./elsewhere"

describe("where another computer's project is listed (ADR-0029)", () => {
  const ours = ["/Users/me/workspace/opencode-ui-power", "/Users/me/workspace/OpenLibrary", "/Users/me/app"]
  const mine = {
    "/Users/me/workspace/opencode-ui-power": "rldona/FlupCode",
    "/Users/me/workspace/OpenLibrary": null,
    "/Users/me/app": "rldona/app",
  }

  test("under this computer's folder of the same repository, whatever either is called", () => {
    expect(
      listedFolder({
        directory: "/home/me/FlupCode",
        theirs: { "/home/me/FlupCode": "rldona/FlupCode" },
        ours,
        mine,
      }),
    ).toBe("/Users/me/workspace/opencode-ui-power")
  })

  test("by the folder's name when there is no repository to go by", () => {
    expect(listedFolder({ directory: "/home/me/openlibrary/", theirs: {}, ours, mine })).toBe(
      "/Users/me/workspace/OpenLibrary",
    )
  })

  test("not under a folder of the same name that holds another repository", () => {
    expect(
      listedFolder({ directory: "/home/me/app", theirs: { "/home/me/app": "someone/app" }, ours, mine }),
    ).toBe("/home/me/app")
  })

  test("where it is when this computer has nothing like it, or the same path", () => {
    expect(listedFolder({ directory: "/home/me/strava-decoded", theirs: {}, ours, mine })).toBe(
      "/home/me/strava-decoded",
    )
    expect(listedFolder({ directory: "/Users/me/app", theirs: {}, ours, mine })).toBe("/Users/me/app")
  })
})
