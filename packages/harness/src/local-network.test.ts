import { describe, expect, test } from "bun:test"
import {
  addressSpaceOf,
  localNetworkGated,
  localNetworkPermissions,
  queryLocalNetworkPermission,
} from "./local-network"

describe("the address space of an engine (H-45)", () => {
  test("loopback is localhost, 127/8 and ::1", () => {
    expect(addressSpaceOf("http://localhost:4096")).toBe("loopback")
    expect(addressSpaceOf("http://127.0.0.1:4096")).toBe("loopback")
    expect(addressSpaceOf("http://127.13.2.9")).toBe("loopback")
    expect(addressSpaceOf("http://[::1]:4096")).toBe("loopback")
    expect(addressSpaceOf("https://LOCALHOST:4096")).toBe("loopback")
  })

  test("the private ranges and .local names are local", () => {
    expect(addressSpaceOf("http://192.168.1.5:4096")).toBe("local")
    expect(addressSpaceOf("http://10.0.0.7:4096")).toBe("local")
    expect(addressSpaceOf("http://172.20.3.4:4096")).toBe("local")
    expect(addressSpaceOf("http://169.254.10.1:4096")).toBe("local")
    expect(addressSpaceOf("http://engine.local:4096")).toBe("local")
    // 172.32 is outside the private block that starts at 172.16.
    expect(addressSpaceOf("http://172.32.0.1")).toBe("public")
  })

  test("a public name is public, and anything that is not a web address has no space", () => {
    expect(addressSpaceOf("https://app.flupcode.com")).toBe("public")
    expect(addressSpaceOf("wss://engine.example.com")).toBe("public")
    // The desktop app's own protocol is not a website, so no browser gates it.
    expect(addressSpaceOf("oc://renderer/index.html")).toBeUndefined()
    expect(addressSpaceOf("not a url")).toBeUndefined()
  })
})

describe("what a browser gates (H-45)", () => {
  test("a public page reaching either local space is a local network request", () => {
    expect(localNetworkGated("public", "loopback")).toBe(true)
    expect(localNetworkGated("public", "local")).toBe(true)
  })

  test("a local page reaching loopback is one too, and loopback to loopback is not", () => {
    expect(localNetworkGated("local", "loopback")).toBe(true)
    // Same space: this is the desktop app and a dev server, which never see a prompt.
    expect(localNetworkGated("loopback", "loopback")).toBe(false)
    expect(localNetworkGated("local", "local")).toBe(false)
    expect(localNetworkGated("public", "public")).toBe(false)
    expect(localNetworkGated(undefined, "loopback")).toBe(false)
  })
})

describe("asking the browser for the permission (H-45)", () => {
  test("asks the granular name first and the alias after it", () => {
    expect(localNetworkPermissions("loopback")).toEqual(["loopback-network", "local-network-access"])
    expect(localNetworkPermissions("local")).toEqual(["local-network", "local-network-access"])
  })

  test("answers with the first name the browser understands", async () => {
    const asked: string[] = []
    const state = await queryLocalNetworkPermission(["loopback-network", "local-network-access"], async (name) => {
      asked.push(name)
      if (name === "loopback-network") throw new TypeError("unknown permission name")
      return { state: "granted" }
    })
    expect(state).toBe("granted")
    // The name it does not know is not asked again, and the one it does is.
    expect(asked).toEqual(["loopback-network", "local-network-access"])
  })

  test("a browser that knows none of them simply does not gate anything", async () => {
    const state = await queryLocalNetworkPermission(["loopback-network", "local-network-access"], async () => {
      throw new TypeError("unknown permission name")
    })
    expect(state).toBe("unsupported")
  })
})
