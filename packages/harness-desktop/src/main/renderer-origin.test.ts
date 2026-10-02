import { expect, test } from "bun:test"
import { isAppPage } from "./renderer-origin"

test("only the app's own renderer gets its credentials (TI-10)", () => {
  expect(isAppPage("oc://renderer/index.html", undefined)).toBe(true)
  expect(isAppPage("http://localhost:4444/", "http://localhost:4444")).toBe(true)
  // A dev server is trusted only while the app uses one.
  expect(isAppPage("http://localhost:4444/", undefined)).toBe(false)
  expect(isAppPage("http://localhost:5555/", "http://localhost:4444")).toBe(false)
  expect(isAppPage("https://example.com/", "http://localhost:4444")).toBe(false)
  expect(isAppPage("oc://other/index.html", undefined)).toBe(false)
  expect(isAppPage("not a url", "http://localhost:4444")).toBe(false)
})
