import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { rendererCsp } from "./renderer-csp"

const directives = (policy: string) =>
  new Map(policy.split(";").map((directive) => {
    const [name, ...sources] = directive.trim().split(/\s+/)
    return [name, sources.join(" ")] as const
  }))

describe("the desktop renderer's CSP (TI-17)", () => {
  test("is the hosted app's policy but for where the page may connect and WebAssembly", async () => {
    const vercel = await Bun.file(join(import.meta.dir, "../../../harness/vercel.json")).json()
    const hosted = directives(
      vercel.headers[0].headers.find((header: { key: string }) => header.key === "Content-Security-Policy").value,
    )
    const desktop = directives(rendererCsp("wss://relay.flupcode.com"))
    expect([...desktop.keys()]).toEqual([...hosted.keys()])
    for (const [name, sources] of hosted) if (name !== "connect-src" && name !== "script-src") expect(desktop.get(name)).toBe(sources)
    expect(desktop.get("script-src")).toBe(`${hosted.get("script-src")} 'wasm-unsafe-eval'`)
  })

  test("connects to loopback and the relay, and nowhere else", () => {
    expect(directives(rendererCsp("wss://relay.flupcode.com")).get("connect-src")).toBe(
      "'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* wss://relay.flupcode.com https://relay.flupcode.com",
    )
    // A relay the user set themselves, path and all, is allowed by its origin.
    expect(directives(rendererCsp("ws://10.0.0.5:8787/relay/")).get("connect-src")).toEndWith(
      "ws://10.0.0.5:8787 http://10.0.0.5:8787",
    )
  })

  test("a relay setting that is not a relay URL adds nothing", () => {
    for (const relay of ["", "not a url", "file:///etc/passwd", "javascript:alert(1)"])
      expect(directives(rendererCsp(relay)).get("connect-src")).toBe(
        "'self' http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:*",
      )
  })
})
