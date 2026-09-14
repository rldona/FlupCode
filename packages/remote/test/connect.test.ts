import { describe, expect, test } from "bun:test"
import { connectRelayClient, encodeRelayMessage } from "../src"

/** Minimal WebSocket stand-in: the client only assigns handlers and calls send/close. */
type FakeSocket = {
  binaryType: string
  onmessage?: (event: { data: unknown }) => void
  onclose?: (event: { code: number; reason: string }) => void
  onerror?: () => void
  closed: boolean
  send: (data: unknown) => void
  close: (code?: number, reason?: string) => void
}

function fakeSocket(): FakeSocket {
  const socket: FakeSocket = {
    binaryType: "",
    closed: false,
    send: () => {},
    close: () => {
      socket.closed = true
      socket.onclose?.({ code: 1000, reason: "" })
    },
  }
  return socket
}

describe("connectRelayClient", () => {
  test("resolves once the relay reports the host is reachable", async () => {
    let socket = fakeSocket()
    const promise = connectRelayClient({
      relay: "wss://relay.test",
      hostId: "host",
      createSocket: () => {
        socket = fakeSocket()
        return socket as unknown as WebSocket
      },
    })
    socket.onmessage?.({ data: encodeRelayMessage({ t: "ready" }) })
    expect((await promise).closed).toBe(false)
  })

  test("rejects instead of waiting forever when the relay never answers", async () => {
    let socket = fakeSocket()
    const promise = connectRelayClient({
      relay: "wss://relay.test",
      hostId: "host",
      timeout: 20,
      createSocket: () => {
        socket = fakeSocket()
        return socket as unknown as WebSocket
      },
    })
    await expect(promise).rejects.toThrow("Relay connection timed out")
    expect(socket.closed).toBe(true)
  })

  test("rejects when the relay closes before ready", async () => {
    let socket = fakeSocket()
    const promise = connectRelayClient({
      relay: "wss://relay.test",
      hostId: "host",
      createSocket: () => {
        socket = fakeSocket()
        return socket as unknown as WebSocket
      },
    })
    socket.onclose?.({ code: 4404, reason: "Host offline" })
    await expect(promise).rejects.toThrow("Host offline")
  })
})
