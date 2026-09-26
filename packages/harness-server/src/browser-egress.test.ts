import { describe, expect, test } from "bun:test"
import { createEgressGuard, isBlockedAddress, NavigationBlockedError } from "./browser-egress"

const guard = createEgressGuard()

describe("what the guard refuses", () => {
  test("schemes a browser should not follow", async () => {
    for (const url of [
      "file:///etc/passwd",
      "data:text/html,<h1>hi</h1>",
      "javascript:alert(1)",
      "blob:https://example.com/1",
      "ftp://example.com/file",
    ]) {
      await expect(guard.assertNavigable(url)).rejects.toThrow(NavigationBlockedError)
    }
  })

  test("a URL that carries credentials", async () => {
    await expect(guard.assertNavigable("https://user:pass@example.com/")).rejects.toThrow(NavigationBlockedError)
  })

  test("loopback, link-local and private addresses", async () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/",
      "http://10.0.0.1/",
      "http://192.168.1.1/",
      "http://172.16.0.1/",
      "http://0.0.0.0/",
      "http://192.88.99.1/",
    ]) {
      await expect(guard.assertNavigable(url)).rejects.toThrow(NavigationBlockedError)
    }
  })

  // A public IPv4 wrapped in an IPv6 form must not slip past the guard as "just IPv6".
  test("addresses carrying an embedded IPv4", async () => {
    for (const url of [
      "http://[2002:a9fe:a9fe::]/",
      "http://[::127.0.0.1]/",
      "http://[::ffff:0:127.0.0.1]/",
      "http://[64:ff9b:1::7f00:1]/",
    ]) {
      await expect(guard.assertNavigable(url)).rejects.toThrow(NavigationBlockedError)
    }
  })
})

describe("what the guard allows", () => {
  test("a public address is allowed", async () => {
    const resolved = await guard.assertNavigable("https://1.1.1.1/")
    expect(resolved.hostname).toBe("1.1.1.1")
  })

  // The old guard waved through whatever DNS could not answer. A name that does not resolve is not
  // a public destination, it is an unknown one, and the guard cannot vouch for it.
  test("a name that does not resolve is refused, not waved through", async () => {
    await expect(guard.assertNavigable("http://does-not-resolve.invalid/")).rejects.toThrow(NavigationBlockedError)
  })

  test("loopback only on the port it was told", async () => {
    const local = createEgressGuard({ allowLoopbackPorts: [8080] })
    expect((await local.assertNavigable("http://127.0.0.1:8080/")).port).toBe("8080")
    expect((await local.assertNavigable("http://[::1]:8080/")).port).toBe("8080")
    await expect(local.assertNavigable("http://127.0.0.1:9090/")).rejects.toThrow(NavigationBlockedError)
    await expect(local.assertNavigable("http://127.0.0.1/")).rejects.toThrow(NavigationBlockedError)
    await expect(guard.assertNavigable("http://127.0.0.1:8080/")).rejects.toThrow(NavigationBlockedError)
  })
})

describe("isBlockedAddress", () => {
  test("fails closed on anything that is not an IP", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true)
    expect(isBlockedAddress("example.com")).toBe(true)
    expect(isBlockedAddress("999.1.1.1")).toBe(true)
  })

  test("classifies IPv4 and IPv6, including mapped forms", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true)
    expect(isBlockedAddress("8.8.8.8")).toBe(false)
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true)
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false)
    expect(isBlockedAddress("2001:db8::1")).toBe(true)
    expect(isBlockedAddress("2606:4700::1111")).toBe(false)
    expect(isBlockedAddress("192.88.99.1")).toBe(true)
  })
})
