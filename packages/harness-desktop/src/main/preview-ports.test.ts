import { describe, expect, test } from "bun:test"
import {
  listDevServers,
  parseLsof,
  parseLsofCwd,
  parseNetstat,
  parseProcNetTcp,
  reachableOnLoopback,
  titleOf,
} from "./preview-ports"

// What `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` prints, trimmed from a real macOS run.
const LSOF = [
  "p834",
  "cControlCenter",
  "f9",
  "n*:7000",
  "p4100",
  "cnode",
  "f22",
  "n[::1]:5173",
  "f23",
  "n127.0.0.1:5173",
  "p4200",
  "cbun",
  "f12",
  "n127.0.0.1:3000",
  "p4300",
  "cpostgres",
  "f7",
  "n127.0.0.1:5432",
  "p4400",
  "cjava",
  "f5",
  "n192.168.1.20:8080",
  "p4500",
  "cflupcode-harness",
  "f9",
  "n127.0.0.1:4097",
].join("\n")

const CWD = ["p4100", "fcwd", "n/work/app", "p4200", "fcwd", "n/work/other", "p834", "fcwd", "n/"].join("\n")

describe("the servers on this machine (BU-06)", () => {
  test("lsof's fields become one listener per address, with the process that holds it", () => {
    const listeners = parseLsof(LSOF)
    expect(listeners).toContainEqual({ port: 5173, address: "::1", pid: 4100, process: "node" })
    expect(listeners).toContainEqual({ port: 7000, address: "*", pid: 834, process: "ControlCenter" })
    expect(listeners).toContainEqual({ port: 8080, address: "192.168.1.20", pid: 4400, process: "java" })
    expect(parseLsofCwd(CWD).get(4100)).toBe("/work/app")
  })

  test("netstat and /proc read the same way where there is no lsof", () => {
    const netstat = [
      "  Proto  Local Address          Foreign Address        State           PID",
      "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1012",
      "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4100",
      "  TCP    [::1]:3000             [::]:0                 LISTENING       4200",
      "  TCP    127.0.0.1:5173         127.0.0.1:61000        ESTABLISHED     4100",
      "  UDP    0.0.0.0:500            *:*                                    3000",
    ].join("\r\n")
    expect(parseNetstat(netstat)).toEqual([
      { port: 135, address: "0.0.0.0", pid: 1012 },
      { port: 5173, address: "127.0.0.1", pid: 4100 },
      { port: 3000, address: "::1", pid: 4200 },
    ])
    const tcp = [
      "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
      "   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1",
      "   1: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 2",
      "   2: 0100007F:1435 0100007F:EE48 01 00000000:00000000 00:00000000 00000000  1000        0 3",
    ].join("\n")
    expect(parseProcNetTcp(tcp)).toEqual([
      { port: 5173, address: "127.0.0.1" },
      { port: 3000, address: "0.0.0.0" },
    ])
    const tcp6 = [
      "  sl  local_address                         remote_address                        st",
      "   0: 00000000000000000000000001000000:1F90 00000000000000000000000000000000:0000 0A",
      "   1: 0000000000000000FFFF00000100007F:22B8 00000000000000000000000000000000:0000 0A",
    ].join("\n")
    expect(parseProcNetTcp(tcp6)).toEqual([
      { port: 8080, address: "::1" },
      { port: 8888, address: "127.0.0.1" },
    ])
  })

  test("only what a page on this machine reaches through loopback counts", () => {
    for (const address of ["*", "0.0.0.0", "::", "::1", "127.0.0.1", "127.1.2.3", "localhost"])
      expect(reachableOnLoopback(address)).toBe(true)
    for (const address of ["192.168.1.20", "10.0.0.2", "fe80::1", "ipv6"]) expect(reachableOnLoopback(address)).toBe(false)
  })

  test("web servers are listed, the project's first; FlupCode's own ports, other hosts and non-web sockets are not", async () => {
    const probed: number[] = []
    const servers = await listDevServers({
      platform: "darwin",
      run: async (command, args) => (command === "lsof" && args.includes("cwd") ? CWD : LSOF),
      // Postgres does not answer HTTP; the rest do.
      probe: async (port) => {
        probed.push(port)
        if (port === 5432) return undefined
        return port === 5173 ? { title: "My app" } : {}
      },
      exclude: new Set([4097]),
      directory: "/work/app/",
    })
    expect(servers).toEqual([
      { port: 5173, url: "http://localhost:5173/", pid: 4100, process: "node", cwd: "/work/app", title: "My app", inProject: true },
      { port: 3000, url: "http://localhost:3000/", pid: 4200, process: "bun", cwd: "/work/other", inProject: false },
      { port: 7000, url: "http://localhost:7000/", pid: 834, process: "ControlCenter", cwd: "/", inProject: false },
    ])
    // Each port is asked once, and never one that is not on loopback or that is FlupCode's.
    expect(probed.sort()).toEqual([3000, 5173, 5432, 7000])
  })

  test("a folder whose name only starts the same is not the project", async () => {
    const servers = await listDevServers({
      platform: "darwin",
      run: async (_command, args) => (args.includes("cwd") ? "p4100\nfcwd\nn/work/app-old\n" : "p4100\ncnode\nn127.0.0.1:5173\n"),
      probe: async () => ({}),
      directory: "/work/app",
    })
    expect(servers[0]?.inProject).toBe(false)
  })

  test("Linux without lsof reads /proc; Windows reads netstat", async () => {
    const linux = await listDevServers({
      platform: "linux",
      run: async () => undefined,
      readText: async (path) =>
        path.endsWith("tcp") ? "header\n   0: 0100007F:1435 00000000:0000 0A 0 0 0 0 0 1\n" : undefined,
      probe: async () => ({}),
    })
    expect(linux.map((server) => server.port)).toEqual([5173])
    const windows = await listDevServers({
      platform: "win32",
      run: async (command) => (command === "netstat" ? "  TCP    127.0.0.1:3000   0.0.0.0:0   LISTENING   77\n" : undefined),
      probe: async () => ({}),
    })
    expect(windows).toEqual([{ port: 3000, url: "http://localhost:3000/", pid: 77, inProject: false }])
  })

  test("a title is read from the page's head", () => {
    expect(titleOf("<html><head><title> Vite  App </title>")).toBe("Vite App")
    expect(titleOf("{}")).toBeUndefined()
  })
})
