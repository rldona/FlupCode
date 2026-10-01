import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CACHE_SELECTION_SOURCE } from "./cache-selection-source"
import { installEnginePlugins } from "./engine-plugins"
import { CACHE_SELECTION_PLUGIN_V2 } from "./engine-plugins-v2"

// The exact text the plugin inlines, evaluated here: the code under test is the code the engine runs.
type Message = { info: Record<string, any>; parts: Array<Record<string, any>> }
type Policy = { keepRecentTurns: number; minSavingsTokens: number; coldGapMs: number }
const selection = new Function(`${CACHE_SELECTION_SOURCE}\nreturn { selectForCache, coldStep, coldBoundary }`)() as {
  selectForCache: (messages: Message[], policy: Policy) => { messages: Message[]; trimmed: number; savedTokens: number }
  coldStep: (messages: Message[], coldGapMs: number) => boolean
  coldBoundary: (messages: Message[], index: number, coldGapMs: number) => boolean
}

const MINUTE = 60_000
const POLICY: Policy = { keepRecentTurns: 1, minSavingsTokens: 0, coldGapMs: 6 * MINUTE }

// A seeded generator, so a failing session can be replayed from its seed.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    const mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    const next = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

const TOOLS = ["read", "bash", "grep", "glob", "edit", "webfetch", "skill", "task", "todowrite", "evidence_read"]

// A session shaped like the engine's `{ info, parts }` list: turns of one user message and a few
// assistant steps, each step with text, reasoning and tool parts of every status and size, some already
// trimmed by D02 (with an evidence ref), some compacted by the engine's prune, and gaps from seconds to
// hours between turns so cold and warm boundaries both occur.
function session(seed: number): Message[] {
  const next = random(seed)
  const pick = <T>(items: T[]) => items[Math.floor(next() * items.length)]!
  const messages: Message[] = []
  let clock = 1_700_000_000_000
  let id = 0
  const turns = 1 + Math.floor(next() * 8)
  for (const turn of Array.from({ length: turns }, (_, index) => index)) {
    clock += turn === 0 ? 0 : pick([2_000, 30_000, 4 * MINUTE, 7 * MINUTE, 90 * MINUTE])
    messages.push({
      info: { id: `msg_${id++}`, sessionID: "ses_1", role: "user", time: { created: clock } },
      parts: [{ type: "text", text: `turn ${turn}: ${"x".repeat(Math.floor(next() * 50))}` }],
    })
    // Now and then a second user message queued right behind the first.
    if (next() < 0.1)
      messages.push({
        info: { id: `msg_${id++}`, sessionID: "ses_1", role: "user", time: { created: clock + 10 } },
        parts: [{ type: "text", text: "and also this" }],
      })
    const steps = 1 + Math.floor(next() * 4)
    for (const _ of Array.from({ length: steps })) {
      clock += 1_000
      const created = clock
      const parts = Array.from({ length: Math.floor(next() * 4) }, (_, index) => {
        const tool = pick(TOOLS)
        const status = pick(["completed", "completed", "completed", "error", "running"])
        const size = pick([10, 500, 2_000, 20_000, 120_000])
        const ref =
          next() < 0.2
            ? Math.floor(next() * 2 ** 52)
                .toString(16)
                .padStart(16, "0")
                .slice(0, 16)
            : undefined
        const output = (ref ? `evidence:${ref}\n` : "") + "o".repeat(size)
        const state =
          status === "completed"
            ? {
                status,
                input: { path: `/src/${index}.ts` },
                output,
                title: tool,
                metadata: ref && next() < 0.5 ? { evidenceRef: ref } : {},
                time: { start: clock, end: clock + 5, ...(next() < 0.1 ? { compacted: clock + 9 } : {}) },
                ...(next() < 0.2
                  ? { attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,AA" }] }
                  : {}),
              }
            : status === "error"
              ? { status, input: { cmd: "x" }, error: "boom", time: { start: clock, end: clock + 5 } }
              : { status, input: { cmd: "y" }, time: { start: clock } }
        return { type: "tool", id: `prt_${id}_${index}`, callID: `call_${id}_${index}`, tool, state }
      })
      clock += 1_000 + Math.floor(next() * 20_000)
      messages.push({
        info: {
          id: `msg_${id++}`,
          sessionID: "ses_1",
          role: "assistant",
          time: next() < 0.05 ? { created } : { created, completed: clock },
        },
        parts: [
          { type: "step-start" },
          ...(next() < 0.5 ? [{ type: "reasoning", text: "thinking" }] : []),
          { type: "text", text: "working" },
          ...parts,
        ],
      })
    }
  }
  return messages
}

const policies: Policy[] = [
  POLICY,
  { keepRecentTurns: 0, minSavingsTokens: 0, coldGapMs: 6 * MINUTE },
  { keepRecentTurns: 2, minSavingsTokens: 4_096, coldGapMs: 6 * MINUTE },
  { keepRecentTurns: 1, minSavingsTokens: 0, coldGapMs: 65 * MINUTE },
  { keepRecentTurns: 3, minSavingsTokens: 100_000, coldGapMs: 1 },
]

const SEEDS = Array.from({ length: 250 }, (_, index) => index + 1)

const bytes = (value: unknown) => JSON.stringify(value)

const boundaries = (messages: Message[], policy: Policy) =>
  messages.flatMap((_, index) => (selection.coldBoundary(messages, index, policy.coldGapMs) ? [index] : []))

describe("selectForCache: pair consistency", () => {
  test("every tool call keeps its result: same messages, parts, ids, tools, statuses and inputs", () => {
    for (const seed of SEEDS)
      for (const policy of policies) {
        const input = session(seed)
        const output = selection.selectForCache(input, policy).messages
        expect(output).toHaveLength(input.length)
        output.forEach((message, index) => {
          const original = input[index]!
          expect(message.info).toBe(original.info)
          expect(message.parts).toHaveLength(original.parts.length)
          message.parts.forEach((part, at) => {
            const before = original.parts[at]!
            expect(part.type).toBe(before.type)
            if (part.type !== "tool") return expect(part).toBe(before)
            expect([part.callID, part.tool, part.id, part.state.status]).toEqual([
              before.callID,
              before.tool,
              before.id,
              before.state.status,
            ])
            expect(part.state.input).toBe(before.state.input)
            // A completed call still carries a result: a string output, never a removed one.
            if (part.state.status === "completed") expect(typeof part.state.output).toBe("string")
            // Only a completed output is ever replaced; errors and interrupted calls are untouched.
            if (part.state.status !== "completed") expect(part).toBe(before)
          })
        })
      }
  })

  test("the result is a valid tool_use/tool_result sequence: each call id once, each with its result", () => {
    for (const seed of SEEDS) {
      const output = selection.selectForCache(session(seed), { ...POLICY, keepRecentTurns: 0 }).messages
      const calls = output.flatMap((message) => message.parts.filter((part) => part.type === "tool"))
      const ids = calls.map((part) => part.callID)
      expect(new Set(ids).size).toBe(ids.length)
      for (const part of calls)
        expect(part.state.status === "completed" ? typeof part.state.output : "settled").not.toBe("undefined")
    }
  })

  test("user messages, non-tool parts, exempt tools, compacted and short outputs are never touched", () => {
    for (const seed of SEEDS) {
      const input = session(seed)
      const output = selection.selectForCache(input, { ...POLICY, keepRecentTurns: 0 }).messages
      output.forEach((message, index) => {
        if (message.info.role === "user") expect(message).toBe(input[index]!)
        message.parts.forEach((part, at) => {
          const before = input[index]!.parts[at]!
          const exempt =
            part.type !== "tool" ||
            ["skill", "task", "todowrite", "todoread"].includes(part.tool) ||
            before.state?.time?.compacted ||
            typeof before.state?.output !== "string" ||
            before.state.output.length < 1024
          if (exempt) expect(part).toBe(before)
        })
      })
    }
  })

  test("does not mutate its input and is deterministic", () => {
    for (const seed of SEEDS)
      for (const policy of policies) {
        const input = session(seed)
        const snapshot = bytes(input)
        const first = selection.selectForCache(input, policy)
        expect(bytes(input)).toBe(snapshot)
        const second = selection.selectForCache(structuredClone(input), policy)
        expect(bytes(second)).toBe(bytes(first))
      }
  })
})

describe("selectForCache: the cached prefix", () => {
  test("without a cold boundary in between, a longer history renders the shorter one's bytes unchanged", () => {
    // Every step's request extends the previous step's history. The provider caches the previous
    // request's prefix, so the selection of a longer list must render the shared prefix byte for byte
    // as it did before, unless a cold boundary (where nothing is cached) lies between the two. Checking
    // each list against the one a message shorter proves every pair by transitivity.
    for (const seed of SEEDS.slice(0, 100))
      for (const policy of policies) {
        const full = session(seed)
        const cold = new Set(boundaries(full, policy))
        const selected = Array.from(
          { length: full.length + 1 },
          (_, end) => selection.selectForCache(full.slice(0, end), policy).messages,
        )
        for (const end of Array.from({ length: full.length }, (_, index) => index + 1)) {
          if (cold.has(end - 1)) continue
          selected[end - 1]!.forEach((message, index) => {
            const longer = selected[end]![index]!
            if (longer !== message) expect(bytes(longer)).toBe(bytes(message))
          })
        }
      }
  })

  test("everything from the last cold boundary on, and the recent turns before it, is byte-identical", () => {
    for (const seed of SEEDS)
      for (const policy of policies) {
        const input = session(seed)
        const output = selection.selectForCache(input, policy).messages
        const cold = boundaries(input, policy)
        const last = cold.at(-1)
        if (last === undefined) {
          expect(output).toEqual(input)
          continue
        }
        const users = input.flatMap((message, index) => (message.info.role === "user" && index < last ? [index] : []))
        const protectedFrom =
          policy.keepRecentTurns === 0
            ? last
            : users.length >= policy.keepRecentTurns
              ? users[users.length - policy.keepRecentTurns]!
              : 0
        // Protection is relative to each boundary, so the newest one bounds what can change.
        const earliest = Math.min(protectedFrom, last)
        expect(bytes(output.slice(earliest))).toBe(bytes(input.slice(earliest)))
      }
  })

  test("the step at a cold boundary is the only one where the trimmed set grows", () => {
    for (const seed of SEEDS.slice(0, 120)) {
      const full = session(seed)
      const counts = Array.from({ length: full.length }, (_, index) => ({
        cold: selection.coldStep(full.slice(0, index + 1), POLICY.coldGapMs),
        trimmed: selection.selectForCache(full.slice(0, index + 1), POLICY).trimmed,
      }))
      counts.forEach((entry, index) => {
        if (index === 0) return
        const previous = counts[index - 1]!
        if (!entry.cold) expect(entry.trimmed).toBe(previous.trimmed)
        expect(entry.trimmed).toBeGreaterThanOrEqual(previous.trimmed)
      })
    }
  })
})

// A small hand-built session for the rules that are easier to read than to generate.
function turn(input: { user: number; steps: Array<{ completed: number; outputs: Array<[string, number]> }> }) {
  return [
    {
      info: { id: `u${input.user}`, sessionID: "ses_1", role: "user", time: { created: input.user } },
      parts: [{ type: "text", text: "go" }],
    },
    ...input.steps.map((step, index) => ({
      info: {
        id: `a${input.user}_${index}`,
        sessionID: "ses_1",
        role: "assistant",
        time: { created: step.completed - 10, completed: step.completed },
      },
      parts: step.outputs.map(([tool, size], at) => ({
        type: "tool",
        callID: `c${input.user}_${index}_${at}`,
        tool,
        state: { status: "completed", input: {}, output: "o".repeat(size), metadata: {}, time: { start: 0, end: 1 } },
      })),
    })),
  ] as Message[]
}

describe("selectForCache: rules", () => {
  const T = 1_000_000_000
  const history = [
    ...turn({
      user: T,
      steps: [
        {
          completed: T + 1_000,
          outputs: [
            ["read", 40_000],
            ["bash", 20_000],
          ],
        },
      ],
    }),
    ...turn({ user: T + 2_000, steps: [{ completed: T + 3_000, outputs: [["grep", 8_000]] }] }),
  ]

  test("a warm step trims nothing", () => {
    const warm = [...history, ...turn({ user: T + 60_000, steps: [] })]
    expect(selection.coldStep(warm, POLICY.coldGapMs)).toBe(false)
    expect(selection.selectForCache(warm, POLICY)).toMatchObject({ trimmed: 0, savedTokens: 0 })
  })

  test("a cold step trims old outputs whole and keeps the recent turns", () => {
    const cold = [...history, ...turn({ user: T + 3_000 + 7 * MINUTE, steps: [] })]
    expect(selection.coldStep(cold, POLICY.coldGapMs)).toBe(true)
    const result = selection.selectForCache(cold, POLICY)
    expect(result.trimmed).toBe(2)
    expect(result.savedTokens).toBeGreaterThan(14_000)
    const outputs = result.messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "tool" ? [part.state.output as string] : [])),
    )
    expect(outputs[0]).toStartWith("[Old read output (40000 characters) cleared by FlupCode")
    expect(outputs[0]).toEndWith("Run the tool again if you still need it.]")
    expect(outputs[1]).toStartWith("[Old bash output")
    // The turn right before the boundary is the recent one kept whole.
    expect(outputs[2]).toHaveLength(8_000)
  })

  test("a D02 digest keeps its ref in the placeholder", () => {
    const digest = structuredClone(history)
    digest[1]!.parts[0]!.state.output = "evidence:0123456789abcdef\n" + "o".repeat(5_000)
    digest[1]!.parts[1]!.state.metadata = { evidenceRef: "fedcba9876543210" }
    const cold = [...digest, ...turn({ user: T + 3_000 + 7 * MINUTE, steps: [] })]
    const outputs = selection.selectForCache(cold, POLICY).messages[1]!.parts.map((part) => part.state.output)
    expect(outputs[0]).toContain("call evidence_read with ref 0123456789abcdef.")
    expect(outputs[1]).toContain("call evidence_read with ref fedcba9876543210.")
  })

  test("below minSavingsTokens a boundary trims nothing", () => {
    const cold = [...history, ...turn({ user: T + 3_000 + 7 * MINUTE, steps: [] })]
    expect(selection.selectForCache(cold, { ...POLICY, minSavingsTokens: 1_000_000 }).trimmed).toBe(0)
  })

  test("a user message queued behind another, or after an unfinished step, is never a boundary", () => {
    const queued = [
      ...history,
      ...turn({ user: T + 3_000 + 7 * MINUTE, steps: [] }),
      ...turn({ user: T + 3_000 + 7 * MINUTE + 5, steps: [] }),
    ]
    expect(selection.coldBoundary(queued, queued.length - 1, POLICY.coldGapMs)).toBe(false)
    const unfinished = structuredClone(history)
    delete unfinished.at(-1)!.info.time.completed
    expect(selection.coldStep([...unfinished, ...turn({ user: T + 90 * MINUTE, steps: [] })], POLICY.coldGapMs)).toBe(
      false,
    )
  })
})

describe("CACHE_SELECTION_PLUGIN_V2", () => {
  const dirs: string[] = []
  const servers: Array<() => void> = []
  afterEach(async () => {
    setSystemTime()
    for (const stop of servers.splice(0)) stop()
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
    delete process.env.FLUPCODE_CONFIG_DIR
    delete process.env.FLUPCODE_HARNESS_SERVER_URL
    delete process.env.FLUPCODE_SELECTION_REFRESH_MS
  })

  const temp = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "fc-cache-selection-"))
    dirs.push(dir)
    return dir
  }

  // The harness side: the policy is read per request, so a test can flip it mid-way.
  const harness = (policy: { current: unknown; status?: number }) => {
    const requests: Array<{ path: string; auth: string | null; method: string }> = []
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          auth: request.headers.get("authorization"),
          method: request.method,
        })
        if (policy.status && policy.status !== 200) return new Response("nope", { status: policy.status })
        return Response.json({ data: policy.current })
      },
    })
    servers.push(() => void server.stop(true))
    return { url: server.url.origin, requests }
  }

  // A request as 2.x hands it to the `context` hook (a tool's result is a `tool` message after its call,
  // and no message carries a time), with the events the plugin reads the times from: a user message's
  // delivery and an assistant step's end, each at its own time.
  type Part = { type: string; id?: string; name?: string; text?: string; result?: { type: string; value: string } }
  type Request = { messages: Array<{ id?: string; role: string; content: Part[] }>; events: Array<[number, Event]> }
  type Event = { type: string; data: Record<string, unknown> }

  const user = (id: string, delivered: number): Request => ({
    messages: [{ id, role: "user", content: [{ type: "text", text: "go" }] }],
    events: [[delivered, { type: "session.inbox.delivered", data: { sessionID: "ses_1", inboxID: id } }]],
  })
  const step = (id: string, ended: number, outputs: Array<[string, number]>): Request => ({
    messages: [
      {
        id,
        role: "assistant",
        content: outputs.map(([tool], at) => ({ type: "tool-call", id: `${id}_call_${at}`, name: tool })),
      },
      {
        role: "tool",
        content: outputs.map(([tool, size], at) => ({
          type: "tool-result",
          id: `${id}_call_${at}`,
          name: tool,
          result: { type: "text", value: "o".repeat(size) },
        })),
      },
    ],
    events: [[ended, { type: "session.step.ended", data: { sessionID: "ses_1", assistantMessageID: id } }]],
  })
  const join = (...requests: Request[]): Request => ({
    messages: requests.flatMap((request) => request.messages),
    events: requests.flatMap((request) => request.events),
  })

  const T = 1_900_000_000_000
  const history = () =>
    join(
      user("u1", T),
      step("a1", T + 1_000, [["read", 40_000]]),
      user("u2", T + 2_000),
      step("a2", T + 3_000, [["grep", 8_000]]),
    )
  const coldTurn = () => user("u3", T + 3_000 + 7 * MINUTE)
  // The next step of the cold turn, and a later turn after another cold gap.
  const nextStep = () => step("a3", T + 3_000 + 8 * MINUTE, [["bash", 3_000]])
  const laterTurn = () => user("u4", T + 3_000 + 20 * MINUTE)
  // Where each request's tool results sit: the old read and the recent grep.
  const read = (request: Request) => request.messages[2]!.content[0]!.result!.value
  const grep = (request: Request) => request.messages[5]!.content[0]!.result!.value

  const open = async (
    url: string | undefined,
    events: Array<[number, Event]> = [],
    token: string | false = "adaptive-secret",
  ) => {
    const config = await temp()
    const flupcode = await temp()
    process.env.FLUPCODE_CONFIG_DIR = flupcode
    if (url) process.env.FLUPCODE_HARNESS_SERVER_URL = url
    if (token) await writeFile(path.join(flupcode, "adaptive-token"), token)
    const { paths } = await installEnginePlugins(config, "v2")
    const target = paths.find((entry) => entry.endsWith(CACHE_SELECTION_PLUGIN_V2.file))!
    const plugin = (await import(pathToFileURL(target).href)).default as { setup: (ctx: unknown) => Promise<unknown> }
    // The clock stands at the newest event once they are all seen, which is when the requests are made.
    const now = Math.max(T, ...events.map(([at]) => at))
    setSystemTime(new Date(now))
    const hooks: Record<string, (input: unknown) => void> = {}
    await plugin.setup({
      location: { directory: "/project" },
      session: { hook: async (name: string, callback: (input: unknown) => void) => void (hooks[name] = callback) },
      event: {
        subscribe: () => ({
          async *[Symbol.asyncIterator]() {
            for (const [at, event] of events) {
              setSystemTime(new Date(at))
              yield event
            }
            setSystemTime(new Date(now))
          },
        }),
      },
    })
    return hooks
  }

  const settle = async (requests: unknown[], count: number) => {
    for (const _ of Array.from({ length: 100 })) {
      if (requests.length >= count) break
      await Bun.sleep(5)
    }
    await Bun.sleep(20)
  }

  const ENABLED = { enabled: true, keepRecentTurns: 1, minSavingsTokens: 0, coldGapMs: 6 * MINUTE }
  const everything = () => join(history(), coldTurn(), nextStep(), laterTurn()).events

  test("the plugin carries the same selection source the tests evaluate", () => {
    expect(CACHE_SELECTION_PLUGIN_V2.source).toContain(CACHE_SELECTION_SOURCE)
    expect(CACHE_SELECTION_PLUGIN_V2.source.match(/^export /gm)).toHaveLength(1)
  })

  test("fetches the policy once when it loads, never inside the hook, and trims in place at a cold step", async () => {
    const fixture = harness({ current: ENABLED })
    const request = join(history(), coldTurn())
    const hooks = await open(fixture.url, request.events)
    await settle(fixture.requests, 1)
    expect(fixture.requests).toEqual([
      { path: "/harness/adaptive/selection", auth: "Bearer adaptive-secret", method: "GET" },
    ])
    const messages = request.messages
    const first = messages[0]
    const result = messages[2]!.content[0]
    hooks.context!({ sessionID: "ses_1", messages })
    expect(fixture.requests).toHaveLength(1)
    // The same list the engine holds, with the old output replaced in its own tool-result.
    expect(request.messages).toBe(messages)
    expect(messages[0]).toBe(first)
    expect(messages[2]!.content[0]).toBe(result)
    expect(read(request)).toStartWith("[Old read output")
    expect(grep(request)).toHaveLength(8_000)
  })

  test("a warm step leaves the messages byte-identical", async () => {
    const fixture = harness({ current: ENABLED })
    const request = join(history(), user("u3", T + 60_000))
    const hooks = await open(fixture.url, request.events)
    await settle(fixture.requests, 1)
    const snapshot = bytes(request.messages)
    hooks.context!({ sessionID: "ses_1", messages: request.messages })
    expect(bytes(request.messages)).toBe(snapshot)
  })

  test("a policy change waits for the session's next cold step", async () => {
    process.env.FLUPCODE_SELECTION_REFRESH_MS = "20"
    const policy = { current: ENABLED as unknown }
    const fixture = harness(policy)
    const hooks = await open(fixture.url, everything())
    await settle(fixture.requests, 1)
    // Each step reloads the history, so each request is built afresh.
    const stepped = (request: Request) => {
      hooks.context!({ sessionID: "ses_1", messages: request.messages })
      return request
    }
    const cold = stepped(join(history(), coldTurn()))
    expect(read(cold)).toStartWith("[Old read output")
    const trimmed = bytes(cold.messages)

    // Switched off while the cache is warm: the next step still renders the same bytes.
    policy.current = { ...ENABLED, enabled: false }
    await settle(fixture.requests, fixture.requests.length + 2)
    const warm = stepped(join(history(), coldTurn(), nextStep()))
    expect(bytes(warm.messages.slice(0, cold.messages.length))).toBe(trimmed)

    // At the next cold step the new policy applies: nothing is trimmed any more.
    const later = stepped(join(history(), coldTurn(), nextStep(), laterTurn()))
    expect(read(later)).toHaveLength(40_000)
  })

  test("a paused session latches off at its next cold step, and other sessions keep the policy", async () => {
    process.env.FLUPCODE_SELECTION_REFRESH_MS = "20"
    const policy = { current: { ...ENABLED, pausedSessions: ["ses_1"] } as unknown }
    const fixture = harness(policy)
    const hooks = await open(fixture.url, everything())
    await settle(fixture.requests, 1)
    const paused = join(history(), coldTurn())
    hooks.context!({ sessionID: "ses_1", messages: paused.messages })
    expect(read(paused)).toHaveLength(40_000)

    // The same history in another session is trimmed as before.
    const other = join(history(), coldTurn())
    hooks.context!({ sessionID: "ses_2", messages: other.messages })
    expect(read(other)).toStartWith("[Old read output")

    // A malformed list is no pause at all.
    policy.current = { ...ENABLED, pausedSessions: "ses_1" }
    await settle(fixture.requests, fixture.requests.length + 2)
    const resumed = join(history(), coldTurn(), nextStep(), laterTurn())
    hooks.context!({ sessionID: "ses_1", messages: resumed.messages })
    expect(read(resumed)).toStartWith("[Old read output")
  })

  test("a control-arm session of the holdout keeps its messages whole; a treatment session is trimmed", async () => {
    // At a 0.5 share `ses_2` draws control for selection and `ses_1` treatment, as armFor does.
    const fixture = harness({ current: { ...ENABLED, holdoutFraction: 0.5 } })
    const hooks = await open(fixture.url, join(history(), coldTurn()).events)
    await settle(fixture.requests, 1)
    const control = join(history(), coldTurn())
    const snapshot = bytes(control.messages)
    hooks.context!({ sessionID: "ses_2", messages: control.messages })
    expect(bytes(control.messages)).toBe(snapshot)
    const treatment = join(history(), coldTurn())
    hooks.context!({ sessionID: "ses_1", messages: treatment.messages })
    expect(read(treatment)).toStartWith("[Old read output")
  })

  test("a share outside [0, 0.5] holds nothing out", async () => {
    const fixture = harness({ current: { ...ENABLED, holdoutFraction: 0.9 } })
    const request = join(history(), coldTurn())
    const hooks = await open(fixture.url, request.events)
    await settle(fixture.requests, 1)
    hooks.context!({ sessionID: "ses_2", messages: request.messages })
    expect(read(request)).toStartWith("[Old read output")
  })

  test("is off without an answer, on a non-200 or a malformed policy, and never throws", async () => {
    for (const current of [
      undefined,
      { enabled: true },
      { ...ENABLED, keepRecentTurns: -1 },
      { ...ENABLED, coldGapMs: 0 },
      "on",
    ]) {
      const fixture = harness({ current })
      const request = join(history(), coldTurn())
      const hooks = await open(fixture.url, request.events)
      await settle(fixture.requests, 1)
      const snapshot = bytes(request.messages)
      hooks.context!({ sessionID: "ses_1", messages: request.messages })
      expect(bytes(request.messages), JSON.stringify(current)).toBe(snapshot)
    }
    const failing = harness({ current: ENABLED, status: 500 })
    const request = join(history(), coldTurn())
    const hooks = await open(failing.url, request.events)
    await settle(failing.requests, 1)
    const snapshot = bytes(request.messages)
    hooks.context!({ sessionID: "ses_1", messages: request.messages })
    expect(bytes(request.messages)).toBe(snapshot)
    for (const input of [undefined, null, {}, { sessionID: "ses_1", messages: "x" }, { messages: [null, 1] }])
      hooks.context!(input)
  })

  test("registers nothing without a token or with a non-loopback base, and sends nothing", async () => {
    const fixture = harness({ current: ENABLED })
    expect(await open(fixture.url, [], false)).toEqual({})
    expect(await open("https://example.com")).toEqual({})
    await Bun.sleep(20)
    expect(fixture.requests).toHaveLength(0)
  })

  test("the engine loads it as a single default plugin", async () => {
    const config = await temp()
    const { paths } = await installEnginePlugins(config, "v2")
    const target = paths.find((entry) => entry.endsWith(CACHE_SELECTION_PLUGIN_V2.file))!
    const mod = await import(pathToFileURL(target).href)
    expect(Object.keys(mod)).toEqual(["default"])
    expect(mod.default.id).toBe("flupcode-cache-selection")
  })
})
