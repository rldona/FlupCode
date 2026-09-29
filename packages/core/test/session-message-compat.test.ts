import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageCompat } from "@opencode-ai/core/session/message-compat"

const decode = Schema.decodeUnknownSync(SessionMessage.Message)
const equivalence = Schema.toEquivalence(SessionMessage.Message)

const model = { id: "model", providerID: "provider" }
const base = { id: "msg_base", type: "assistant" as const, agent: "build", model, time: { created: 0 } }
const userBase = { id: "msg_user", type: "user" as const, text: "hola", time: { created: 0 } }

const toolState = (message: SessionMessage.Message, index = 0): Record<string, unknown> => {
  if (message.type !== "assistant") throw new Error("expected assistant")
  const part = message.content[index]
  if (part.type !== "tool") throw new Error("expected tool")
  return part.state as Record<string, unknown>
}

// One fixture per drift class the normalizer must repair. Each one is rejected by the
// strict schema before normalization and must decode after it.
const driftFixtures: Record<string, unknown> = {
  "assistant text part without id": { ...base, content: [{ type: "text", text: "hi" }] },
  "assistant reasoning part without id": { ...base, content: [{ type: "reasoning", text: "why" }] },
  "assistant tool part without id": {
    ...base,
    content: [{ type: "tool", name: "bash", time: { created: 0 }, state: { status: "running", input: {} } }],
  },
  "running tool state without structured or content": {
    ...base,
    content: [
      { type: "tool", id: "call_running", name: "bash", time: { created: 0 }, state: { status: "running", input: {} } },
    ],
  },
  "completed tool state without structured or content": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_completed",
        name: "bash",
        time: { created: 0 },
        state: { status: "completed", input: {}, outputPaths: [] },
      },
    ],
  },
  "errored tool state without structured, content, or unknown error": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_error",
        name: "bash",
        time: { created: 0 },
        state: { status: "error", input: {}, error: { type: "provider.error", message: "rate limited" } },
      },
    ],
  },
  "completed tool state with metadata and no structured": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_metadata_completed",
        name: "bash",
        time: { created: 0 },
        state: { status: "completed", input: {}, metadata: { answer: 42 }, content: [] },
      },
    ],
  },
  "errored tool state with metadata and no structured": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_metadata_error",
        name: "bash",
        time: { created: 0 },
        state: {
          status: "error",
          input: {},
          metadata: { reason: "boom" },
          error: { type: "unknown", message: "boom" },
        },
      },
    ],
  },
  "completed tool state with metadata, structured and no content": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_metadata_both",
        name: "bash",
        time: { created: 0 },
        state: { status: "completed", input: {}, metadata: { legacy: 1 }, structured: { current: 2 } },
      },
    ],
  },
  "completed tool state with non-record metadata": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_metadata_invalid",
        name: "bash",
        time: { created: 0 },
        state: { status: "completed", input: {}, metadata: "not-a-record", content: [] },
      },
    ],
  },
  "user with a non conforming agent source": {
    ...userBase,
    agents: [{ name: "build", source: { type: "inline" } }],
  },
  "assistant provider error with a known message": {
    ...base,
    content: [],
    error: { type: "provider.error", message: "rate limited" },
  },
  "assistant error without a message": { ...base, content: [], error: { type: "aborted" } },
  "assistant string error": { ...base, content: [], error: "boom" },
  "tool state string error": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_error_string",
        name: "bash",
        time: { created: 0 },
        state: { status: "error", input: {}, error: "kaboom" },
      },
    ],
  },
  "legacy inline attachment": {
    ...userBase,
    files: [{ data: "YWJj", mime: "text/plain", name: "a.txt", source: { type: "inline" } }],
  },
  "legacy attachment with a non conforming source": {
    ...userBase,
    files: [{ data: "YWJj", mime: "text/plain", source: { type: "inline" } }],
  },
}

// Messages the strict schema already accepts: normalization must not touch them.
const validFixtures: Record<string, unknown> = {
  "assistant with identified parts": {
    ...base,
    content: [
      { type: "text", id: "text_1", text: "hi" },
      { type: "reasoning", id: "reason_1", text: "why" },
    ],
  },
  "assistant with a pending tool": {
    ...base,
    content: [
      { type: "tool", id: "call_pending", name: "bash", time: { created: 0 }, state: { status: "pending", input: "" } },
    ],
  },
  "assistant with a completed tool": {
    ...base,
    content: [
      {
        type: "tool",
        id: "call_completed",
        name: "bash",
        time: { created: 0 },
        state: { status: "completed", input: {}, structured: {}, content: [], outputPaths: [] },
      },
    ],
  },
  "user without attachments": { ...userBase },
  "user with a data uri attachment": {
    ...userBase,
    files: [{ uri: "data:text/plain;base64,YWJj", mime: "text/plain", name: "a.txt" }],
  },
  "user with a conforming source": {
    ...userBase,
    files: [{ uri: "data:text/plain;base64,YWJj", mime: "text/plain", source: { start: 0, end: 1, text: "a" } }],
  },
}

describe("SessionMessageCompat.normalize", () => {
  test("repairs every drift class into a strictly decodable message", () => {
    for (const [name, fixture] of Object.entries(driftFixtures)) {
      expect(() => decode(fixture), name).toThrow()
      expect(() => decode(SessionMessageCompat.normalize(fixture)), name).not.toThrow()
    }
  })

  test("is idempotent for drift and already valid messages", () => {
    for (const [name, fixture] of Object.entries({ ...driftFixtures, ...validFixtures })) {
      const once = SessionMessageCompat.normalize(fixture)
      const twice = SessionMessageCompat.normalize(once)
      expect(twice, name).toEqual(once)
      expect(equivalence(decode(once), decode(twice)), name).toBe(true)
    }
  })

  test("derives stable part ids from the message id and the part index", () => {
    const input = {
      ...base,
      id: "msg_parts",
      content: [
        { type: "text", text: "a" },
        { type: "reasoning", text: "b" },
        { type: "tool", name: "bash", time: { created: 0 }, state: { status: "running", input: {} } },
      ],
    }

    const message = decode(SessionMessageCompat.normalize(input))
    if (message.type !== "assistant") throw new Error("expected assistant")
    expect(message.content.map((part) => part.id)).toEqual([
      "compat_msg_parts_0",
      "compat_msg_parts_1",
      "compat_msg_parts_2",
    ])

    const again = decode(SessionMessageCompat.normalize(SessionMessageCompat.normalize(input)))
    if (again.type !== "assistant") throw new Error("expected assistant")
    expect(again.content.map((part) => part.id)).toEqual(message.content.map((part) => part.id))
  })

  test("leaves already valid messages untouched", () => {
    for (const [name, fixture] of Object.entries(validFixtures)) {
      expect(() => decode(fixture), name).not.toThrow()
      expect(SessionMessageCompat.normalize(fixture), name).toBe(fixture)
    }
  })

  test("rewrites legacy inline attachments preserving name and mime", () => {
    const input = {
      ...userBase,
      files: [{ data: "YWJj", mime: "text/plain", name: "a.txt", source: { type: "inline" } }],
    }

    const message = decode(SessionMessageCompat.normalize(input))
    if (message.type !== "user") throw new Error("expected user")
    expect(message.files).toEqual([{ uri: "data:text/plain;base64,YWJj", mime: "text/plain", name: "a.txt" }])

    const once = SessionMessageCompat.normalize(input)
    expect(SessionMessageCompat.normalize(once)).toEqual(once)
  })

  test("drops non conforming attachment sources and keeps conforming ones", () => {
    const bad = decode(
      SessionMessageCompat.normalize({
        ...userBase,
        files: [{ data: "YWJj", mime: "text/plain", source: { type: "inline" } }],
      }),
    )
    if (bad.type !== "user") throw new Error("expected user")
    expect(bad.files?.[0]).toEqual({ uri: "data:text/plain;base64,YWJj", mime: "text/plain" })
    expect(bad.files?.[0]).not.toHaveProperty("source")

    const good = decode(
      SessionMessageCompat.normalize({
        ...userBase,
        files: [{ uri: "data:text/plain;base64,YWJj", mime: "text/plain", source: { start: 0, end: 1, text: "a" } }],
      }),
    )
    if (good.type !== "user") throw new Error("expected user")
    expect(good.files?.[0]).toEqual({
      uri: "data:text/plain;base64,YWJj",
      mime: "text/plain",
      source: { start: 0, end: 1, text: "a" },
    })
  })

  test("maps tool metadata into structured for shaped states", () => {
    const completed = decode(
      SessionMessageCompat.normalize({
        ...base,
        content: [
          {
            type: "tool",
            id: "call_meta_completed",
            name: "bash",
            time: { created: 0 },
            state: { status: "completed", input: {}, metadata: { answer: 42, nested: { ok: true } }, content: [] },
          },
        ],
      }),
    )
    expect(toolState(completed).structured).toEqual({ answer: 42, nested: { ok: true } })

    const errored = decode(
      SessionMessageCompat.normalize({
        ...base,
        content: [
          {
            type: "tool",
            id: "call_meta_error",
            name: "bash",
            time: { created: 0 },
            state: {
              status: "error",
              input: {},
              metadata: { reason: "boom" },
              error: { type: "unknown", message: "boom" },
            },
          },
        ],
      }),
    )
    expect(toolState(errored).structured).toEqual({ reason: "boom" })
  })

  test("keeps an existing structured record over metadata", () => {
    const input = {
      ...base,
      content: [
        {
          type: "tool",
          id: "call_meta_both",
          name: "bash",
          time: { created: 0 },
          state: { status: "completed", input: {}, metadata: { legacy: 1 }, structured: { current: 2 } },
        },
      ],
    }

    expect(() => decode(input)).toThrow()
    expect(toolState(decode(SessionMessageCompat.normalize(input))).structured).toEqual({ current: 2 })
  })

  test("defaults structured to an empty record when metadata is not a record", () => {
    const input = {
      ...base,
      content: [
        {
          type: "tool",
          id: "call_meta_invalid",
          name: "bash",
          time: { created: 0 },
          state: { status: "completed", input: {}, metadata: "not-a-record", content: [] },
        },
      ],
    }

    expect(() => decode(input)).toThrow()
    expect(toolState(decode(SessionMessageCompat.normalize(input))).structured).toEqual({})
  })

  test("is idempotent when mapping metadata into structured", () => {
    const input = {
      ...base,
      content: [
        {
          type: "tool",
          id: "call_meta_idempotent",
          name: "bash",
          time: { created: 0 },
          state: { status: "running", input: {}, metadata: { progress: 1 } },
        },
      ],
    }

    const once = SessionMessageCompat.normalize(input)
    const twice = SessionMessageCompat.normalize(once)
    expect(twice).toEqual(once)
    expect(equivalence(decode(once), decode(twice))).toBe(true)
  })

  test("keeps normalize total for errors that JSON cannot serialize", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const cases: Record<string, unknown> = {
      bigint: 10n,
      circular,
      function: () => {},
      symbol: Symbol("boom"),
    }

    for (const [name, error] of Object.entries(cases)) {
      let normalized: unknown
      expect(() => (normalized = SessionMessageCompat.normalize({ ...base, content: [], error })), name).not.toThrow()
      const message = decode(normalized)
      if (message.type !== "assistant") throw new Error("expected assistant")
      expect(typeof message.error?.message, name).toBe("string")
      expect(message.error?.message.length, name).toBeGreaterThan(0)
      expect(message.error?.type, name).toBe("unknown")
    }
  })

  test("preserves an existing uri and drops a non conforming source", () => {
    const input = {
      ...userBase,
      files: [
        {
          uri: "data:text/plain;base64,T1JJRw==",
          mime: "text/plain",
          name: "a.txt",
          data: "ZGF0YQ==",
          source: { type: "inline" },
        },
      ],
    }

    const message = decode(SessionMessageCompat.normalize(input))
    if (message.type !== "user") throw new Error("expected user")
    expect(message.files?.[0]?.uri).toBe("data:text/plain;base64,T1JJRw==")
    expect(message.files?.[0]).not.toHaveProperty("source")
    expect(message.files?.[0]).not.toHaveProperty("data")
  })

  test("normalizes agent sources with the same policy as file sources", () => {
    const input = { ...userBase, agents: [{ name: "build", source: { type: "inline" } }] }

    expect(() => decode(input)).toThrow()
    const message = decode(SessionMessageCompat.normalize(input))
    if (message.type !== "user") throw new Error("expected user")
    expect(message.agents?.[0]).toEqual({ name: "build" })
    expect(message.agents?.[0]).not.toHaveProperty("source")
  })

  test("does not mutate its input while repairing drift", () => {
    const input = {
      ...base,
      content: [
        {
          type: "tool",
          id: "call_mutation",
          name: "bash",
          time: { created: 0 },
          state: { status: "completed", input: {}, metadata: { n: 1 } },
        },
        { type: "text", text: "legacy" },
      ],
    }
    const snapshot = structuredClone(input)

    SessionMessageCompat.normalize(input)

    expect(input).toEqual(snapshot)
  })
})

describe("SessionMessageCompat decoders", () => {
  test("decodeMessageSync and decodeRowSync normalize legacy input", () => {
    expect(SessionMessageCompat.decodeMessageSync({ ...base, content: [{ type: "text", text: "hi" }] }).id).toBe(
      SessionMessage.ID.make("msg_base"),
    )

    const row = {
      id: "msg_row",
      type: "assistant",
      data: { agent: "build", model, content: [{ type: "text", text: "hi" }], time: { created: 0 } },
    }
    const message = SessionMessageCompat.decodeRowSync(row)
    expect(message.id).toBe(SessionMessage.ID.make("msg_row"))
    if (message.type !== "assistant") throw new Error("expected assistant")
    expect(message.content[0]).toMatchObject({ type: "text", id: "compat_msg_row_0" })
  })

  test("decodeMessage normalizes through the Effect API", async () => {
    const message = await Effect.runPromise(
      SessionMessageCompat.decodeMessage({ ...base, content: [{ type: "text", text: "hi" }] }),
    )
    expect(message.id).toBe(SessionMessage.ID.make("msg_base"))
    if (message.type !== "assistant") throw new Error("expected assistant")
    expect(message.content[0]).toMatchObject({ type: "text", id: "compat_msg_base_0" })
  })

  test("decodeRow decodes rows through the Effect API", async () => {
    const row = {
      id: "msg_row_effect",
      type: "assistant",
      data: { agent: "build", model, content: [{ type: "reasoning", text: "why" }], time: { created: 0 } },
    }

    const message = await Effect.runPromise(SessionMessageCompat.decodeRow(row))
    expect(message.id).toBe(SessionMessage.ID.make("msg_row_effect"))
    if (message.type !== "assistant") throw new Error("expected assistant")
    expect(message.content[0]).toMatchObject({ type: "reasoning", id: "compat_msg_row_effect_0" })
  })

  test("rejects drift that normalization cannot repair", () => {
    expect(() => SessionMessageCompat.decodeMessageSync({ ...base, content: "not an array" })).toThrow()
  })
})
