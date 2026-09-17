import { describe, expect, test } from "bun:test"
import {
  CHAT_PERMISSION,
  chatFileParts,
  chatGreeting,
  isChatSession,
  isCoworkSession,
  sessionChatClass,
} from "./chat"

describe("isChatSession", () => {
  test("a chat lives in the chats folder", () => {
    expect(isChatSession({ location: { directory: "/state" } }, "/state")).toBe(true)
    expect(isChatSession({ location: { directory: "/code/app" } }, "/state")).toBe(false)
  })

  test("nothing is a chat until the folder is known", () => {
    expect(isChatSession({ location: { directory: "/state" } }, undefined)).toBe(false)
    expect(isChatSession({}, "/state")).toBe(false)
  })
})

describe("isCoworkSession", () => {
  test("a cowork session runs the reserved agent", () => {
    expect(isCoworkSession({ agent: "cowork" })).toBe(true)
    expect(isCoworkSession({ agent: "build" })).toBe(false)
    expect(isCoworkSession({})).toBe(false)
  })
})

describe("sessionChatClass", () => {
  test("tells plain chats, cowork and code apart", () => {
    expect(sessionChatClass({ location: { directory: "/state" } }, "/state")).toBe("chat")
    expect(sessionChatClass({ agent: "cowork", location: { directory: "/code/app" } }, "/state")).toBe("cowork")
    expect(sessionChatClass({ location: { directory: "/code/app" } }, "/state")).toBeUndefined()
  })

  test("the cowork marker wins over the chats folder", () => {
    expect(sessionChatClass({ agent: "cowork", location: { directory: "/state" } }, "/state")).toBe("cowork")
  })
})

describe("CHAT_PERMISSION", () => {
  // The engine applies the last matching rule.
  const decide = (permission: string) =>
    CHAT_PERMISSION.findLast((rule) => rule.permission === "*" || rule.permission === permission)?.action

  test("allows only the web tools", () => {
    expect(decide("webfetch")).toBe("allow")
    expect(decide("websearch")).toBe("allow")
    expect(decide("bash")).toBe("deny")
    expect(decide("edit")).toBe("deny")
    expect(decide("read")).toBe("deny")
  })
})

describe("chatGreeting", () => {
  test("follows the time of day", () => {
    expect(chatGreeting("Raúl", 9)).toEqual({ key: "Good morning, {name}", params: { name: "Raúl" } })
    expect(chatGreeting("Raúl", 15).key).toBe("Good afternoon, {name}")
    expect(chatGreeting("Raúl", 22).key).toBe("Good evening, {name}")
    expect(chatGreeting("Raúl", 3).key).toBe("Good evening, {name}")
  })

  test("works without a name", () => {
    expect(chatGreeting("  ", 9)).toEqual({ key: "Good morning", params: undefined })
  })
})

describe("chatFileParts", () => {
  test("reads the mime type from data URIs", () => {
    expect(chatFileParts([{ uri: "data:image/png;base64,AAA", name: "shot.png" }])).toEqual([
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAA", filename: "shot.png" },
    ])
    expect(chatFileParts([{ uri: "file:///x" }])[0]?.mime).toBe("application/octet-stream")
  })
})
