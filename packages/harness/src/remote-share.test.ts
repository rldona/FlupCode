import { describe, expect, test } from "bun:test"
import { DEFAULT_ENGINE_PORT, enginePort, lanServeCommand, reachabilityLabel, tunnelCommand } from "./remote-share"

describe("the engine port of a URL", () => {
  test("the port it names, or the default", () => {
    expect(enginePort("http://localhost:4096")).toBe(4096)
    expect(enginePort("http://192.168.1.2:5000")).toBe(5000)
    expect(enginePort("http://localhost")).toBe(DEFAULT_ENGINE_PORT)
    expect(enginePort("not a url")).toBe(DEFAULT_ENGINE_PORT)
  })
})

describe("the copyable commands", () => {
  test("the LAN command carries the port and the origin asking for it", () => {
    expect(lanServeCommand(4096, "http://localhost:5173")).toBe(
      "OPENCODE_SERVER_PASSWORD=… opencode serve --hostname 0.0.0.0 --port 4096 --cors http://localhost:5173",
    )
  })

  test("the tunnel command points at the local engine", () => {
    expect(tunnelCommand(4096)).toBe("cloudflared tunnel --url http://localhost:4096")
  })
})

describe("the local URL status line", () => {
  test("one label per probe outcome, checking while none", () => {
    expect(reachabilityLabel("online")).toBe("Reachable")
    expect(reachabilityLabel("blocked")).toBe("Blocked by the browser")
    expect(reachabilityLabel("unauthorized")).toBe("Authentication required")
    expect(reachabilityLabel("offline")).toBe("Offline")
    expect(reachabilityLabel(undefined)).toBe("Checking…")
  })
})
