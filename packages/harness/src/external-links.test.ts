import { describe, expect, test } from "bun:test"
import { externalLinkOrigin, isBrowsableUrl } from "./external-links"

describe("isBrowsableUrl", () => {
  test("accepts absolute http(s) URLs, hosts included", () => {
    expect(isBrowsableUrl("http://localhost:4444")).toBe(true)
    expect(isBrowsableUrl("https://localhost:4444")).toBe(true)
    expect(isBrowsableUrl("http://127.0.0.1:5173")).toBe(true)
    expect(isBrowsableUrl("http://10.0.0.4:4200")).toBe(true)
    expect(isBrowsableUrl("http://192.168.1.20:3000")).toBe(true)
    expect(isBrowsableUrl("https://app.flupcode.com")).toBe(true)
    expect(isBrowsableUrl("https://github.com/rldona/FlupCode")).toBe(true)
    expect(isBrowsableUrl("https://93.184.216.34/path?q=1#top")).toBe(true)
  })

  test("rejects other schemes, relative paths, anchors and malformed strings", () => {
    expect(isBrowsableUrl("mailto:someone@example.com")).toBe(false)
    expect(isBrowsableUrl("tel:+34600000000")).toBe(false)
    expect(isBrowsableUrl("javascript:alert(1)")).toBe(false)
    expect(isBrowsableUrl("data:text/html,<h1>hi</h1>")).toBe(false)
    expect(isBrowsableUrl("blob:https://example.com/abc")).toBe(false)
    expect(isBrowsableUrl("file:///etc/hosts")).toBe(false)
    expect(isBrowsableUrl("/docs")).toBe(false)
    expect(isBrowsableUrl("#section")).toBe(false)
    expect(isBrowsableUrl("")).toBe(false)
    expect(isBrowsableUrl("not a url")).toBe(false)
  })
})

describe("externalLinkOrigin", () => {
  test("is the scheme, host and port, so a downgrade or another port is a different origin", () => {
    expect(externalLinkOrigin("https://github.com/rldona/FlupCode/pull/6")).toBe("https://github.com")
    expect(externalLinkOrigin("https://www.npmjs.com/package/@rldona/aemet-mcp")).toBe("https://www.npmjs.com")
    expect(externalLinkOrigin("http://localhost:4444/dev")).toBe("http://localhost:4444")
    expect(externalLinkOrigin("https://localhost:4444/dev")).not.toBe(externalLinkOrigin("http://localhost:4444/dev"))
    expect(externalLinkOrigin("http://localhost:4444/dev")).not.toBe(externalLinkOrigin("http://localhost:3000/dev"))
  })

  test("drops credentials, so `user@trusted` never reads as the trusted origin", () => {
    expect(externalLinkOrigin("https://user:pass@evil.com/path")).toBe("https://evil.com")
    expect(externalLinkOrigin("https://apple.com@evil.com/")).toBe("https://evil.com")
  })

  test("has no origin for a scheme or string a browser would not open", () => {
    expect(externalLinkOrigin("mailto:someone@example.com")).toBeUndefined()
    expect(externalLinkOrigin("/docs")).toBeUndefined()
    expect(externalLinkOrigin("not a url")).toBeUndefined()
  })
})
