import { describe, expect, test } from "bun:test"
import { isLocalPreview } from "./browser"

describe("isLocalPreview", () => {
  test("accepts localhost, loopback and LAN dev servers", () => {
    expect(isLocalPreview("http://localhost:4444")).toBe(true)
    expect(isLocalPreview("https://localhost:4444")).toBe(true)
    expect(isLocalPreview("http://app.localhost:3000")).toBe(true)
    expect(isLocalPreview("http://127.0.0.1:5173")).toBe(true)
    expect(isLocalPreview("http://0.0.0.0:8080")).toBe(true)
    expect(isLocalPreview("http://10.0.0.4:4200")).toBe(true)
    expect(isLocalPreview("http://192.168.1.20:3000")).toBe(true)
    expect(isLocalPreview("http://172.16.0.1")).toBe(true)
    expect(isLocalPreview("http://172.31.255.254")).toBe(true)
  })

  test("leaves everything else to a real tab", () => {
    expect(isLocalPreview("https://app.flupcode.com")).toBe(false)
    expect(isLocalPreview("https://github.com/rldona/FlupCode")).toBe(false)
    expect(isLocalPreview("http://172.15.0.1")).toBe(false)
    expect(isLocalPreview("http://172.32.0.1")).toBe(false)
    expect(isLocalPreview("/docs")).toBe(false)
    expect(isLocalPreview("#section")).toBe(false)
    expect(isLocalPreview("")).toBe(false)
  })
})
