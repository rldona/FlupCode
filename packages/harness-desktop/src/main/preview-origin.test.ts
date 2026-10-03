import { describe, expect, test } from "bun:test"
import { addressOf, isLoopbackHost, previewVerdict } from "./preview-origin"

describe("where the preview may go (BU-06)", () => {
  test("a page on this machine opens without asking", () => {
    for (const url of [
      "http://localhost:5173/",
      "http://127.0.0.1:3000/a?b=c",
      "http://127.4.5.6:8080",
      "http://[::1]:4321/",
      "https://app.localhost/",
      "http://LOCALHOST.:80/",
      "about:blank",
    ])
      expect(previewVerdict(url)).toBe("allow")
  })

  test("any other web origin asks first, until the policy allowed that origin", () => {
    expect(previewVerdict("https://example.com/docs")).toBe("ask")
    expect(previewVerdict("http://192.168.1.20:3000/")).toBe("ask")
    // Looks like loopback, is not: a name under someone else's domain.
    expect(previewVerdict("http://127.0.0.1.example.com/")).toBe("ask")
    expect(previewVerdict("http://localhost.example.com/")).toBe("ask")
    expect(previewVerdict("https://example.com/other", new Set(["https://example.com"]))).toBe("allow")
    // An origin is scheme, host and port: the allowed one does not cover its neighbours.
    expect(previewVerdict("http://example.com/", new Set(["https://example.com"]))).toBe("ask")
  })

  test("what is not a web address never opens", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "chrome://settings",
      "data:text/html,hi",
      "not a url",
      "http://user:secret@localhost:3000/",
    ])
      expect(previewVerdict(url)).toBe("refuse")
  })

  test("loopback is this machine only", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
    expect(isLoopbackHost("128.0.0.1")).toBe(false)
    expect(isLoopbackHost("127.0.0.256")).toBe(false)
    expect(isLoopbackHost("0.0.0.0")).toBe(false)
  })

  test("the address bar reads a port or a bare host as http", () => {
    expect(addressOf(":5173")).toBe("http://localhost:5173")
    expect(addressOf(" localhost:3000/a ")).toBe("http://localhost:3000/a")
    expect(addressOf("https://example.com")).toBe("https://example.com")
    expect(addressOf("about:blank")).toBe("about:blank")
  })
})
