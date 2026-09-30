import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { CACHE_SELECTION_PLUGIN, CACHE_SELECTION_SOURCE, installEnginePlugins } from "./engine-plugins"

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

describe("CACHE_SELECTION_PLUGIN", () => {
  const dirs: string[] = []
  const servers: Array<() => void> = []
  afterEach(async () => {
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

  const open = async (url: string | undefined, token: string | false = "adaptive-secret") => {
    const config = await temp()
    const flupcode = await temp()
    process.env.FLUPCODE_CONFIG_DIR = flupcode
    if (url) process.env.FLUPCODE_HARNESS_SERVER_URL = url
    if (token) await writeFile(path.join(flupcode, "adaptive-token"), token)
    const { paths } = await installEnginePlugins(config)
    const target = paths.find((entry) => entry.endsWith(CACHE_SELECTION_PLUGIN.file))!
    const factory = (await import(pathToFileURL(target).href)).flupcodeCacheSelection
    return (await factory({ directory: "/project" })) as Record<
      string,
      (input: unknown, output: unknown) => Promise<void>
    >
  }

  const settle = async (requests: unknown[], count: number) => {
    for (const _ of Array.from({ length: 100 })) {
      if (requests.length >= count) break
      await Bun.sleep(5)
    }
    await Bun.sleep(20)
  }

  const ENABLED = { enabled: true, keepRecentTurns: 1, minSavingsTokens: 0, coldGapMs: 6 * MINUTE }
  const T = 1_000_000_000
  const history = () => [
    ...turn({ user: T, steps: [{ completed: T + 1_000, outputs: [["read", 40_000]] }] }),
    ...turn({ user: T + 2_000, steps: [{ completed: T + 3_000, outputs: [["grep", 8_000]] }] }),
  ]
  const coldTurn = () => turn({ user: T + 3_000 + 7 * MINUTE, steps: [] })

  test("the plugin carries the same selection source the tests evaluate", () => {
    expect(CACHE_SELECTION_PLUGIN.source).toContain(CACHE_SELECTION_SOURCE)
    expect(CACHE_SELECTION_PLUGIN.source.match(/^export /gm)).toHaveLength(1)
  })

  test("fetches the policy once when it loads, never inside the hook, and trims in place at a cold step", async () => {
    const fixture = harness({ current: ENABLED })
    const hooks = await open(fixture.url)
    await settle(fixture.requests, 1)
    expect(fixture.requests).toEqual([
      { path: "/harness/adaptive/selection", auth: "Bearer adaptive-secret", method: "GET" },
    ])
    const messages = [...history(), ...coldTurn()]
    const user = messages[0]
    const output = { messages }
    await hooks["experimental.chat.messages.transform"]!({}, output)
    expect(fixture.requests).toHaveLength(1)
    // The same array the engine holds, with the old output replaced and everything else as it was.
    expect(output.messages).toBe(messages)
    expect(messages[0]).toBe(user)
    expect(messages[1]!.parts[0]!.state.output).toStartWith("[Old read output")
    expect(messages[3]!.parts[0]!.state.output).toHaveLength(8_000)
  })

  test("a warm step leaves the messages byte-identical", async () => {
    const fixture = harness({ current: ENABLED })
    const hooks = await open(fixture.url)
    await settle(fixture.requests, 1)
    const messages = [...history(), ...turn({ user: T + 60_000, steps: [] })]
    const snapshot = bytes(messages)
    await hooks["experimental.chat.messages.transform"]!({}, { messages })
    expect(bytes(messages)).toBe(snapshot)
  })

  test("a policy change waits for the session's next cold step", async () => {
    process.env.FLUPCODE_SELECTION_REFRESH_MS = "20"
    const policy = { current: ENABLED as unknown }
    const fixture = harness(policy)
    const hooks = await open(fixture.url)
    await settle(fixture.requests, 1)
    const transform = hooks["experimental.chat.messages.transform"]!
    const step = async (messages: Message[]) => {
      await transform({}, { messages })
      return messages
    }
    const cold = await step([...history(), ...coldTurn()])
    const trimmed = bytes(cold)

    // Switched off while the cache is warm: the next steps still render the same bytes.
    policy.current = { ...ENABLED, enabled: false }
    await settle(fixture.requests, fixture.requests.length + 2)
    // The next step of the same turn: its list ends with the step before it, so it is warm.
    const warm = await step([
      ...history(),
      ...coldTurn(),
      ...turn({ user: 0, steps: [{ completed: T + 3_000 + 8 * MINUTE, outputs: [["bash", 3_000]] }] }).slice(1),
    ])
    expect(bytes(warm.slice(0, cold.length))).toBe(trimmed)

    // At the next cold step the new policy applies: nothing is trimmed any more.
    // Each step reloads the history from storage, so the next list is built afresh.
    const later = await step([
      ...history(),
      ...coldTurn(),
      ...turn({ user: 0, steps: [{ completed: T + 3_000 + 8 * MINUTE, outputs: [["bash", 3_000]] }] }).slice(1),
      ...turn({ user: T + 3_000 + 20 * MINUTE, steps: [] }),
    ])
    expect(later[1]!.parts[0]!.state.output).toHaveLength(40_000)
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
      const hooks = await open(fixture.url)
      await settle(fixture.requests, 1)
      const messages = [...history(), ...coldTurn()]
      const snapshot = bytes(messages)
      await hooks["experimental.chat.messages.transform"]!({}, { messages })
      expect(bytes(messages)).toBe(snapshot)
    }
    const failing = harness({ current: ENABLED, status: 500 })
    const hooks = await open(failing.url)
    await settle(failing.requests, 1)
    const messages = [...history(), ...coldTurn()]
    const snapshot = bytes(messages)
    await hooks["experimental.chat.messages.transform"]!({}, { messages })
    expect(bytes(messages)).toBe(snapshot)
    for (const output of [undefined, null, {}, { messages: "x" }, { messages: [null, 1] }])
      await hooks["experimental.chat.messages.transform"]!({}, output)
  })

  test("registers nothing without a token or with a non-loopback base, and sends nothing", async () => {
    const fixture = harness({ current: ENABLED })
    expect(await open(fixture.url, false)).toEqual({})
    expect(await open("https://example.com")).toEqual({})
    await Bun.sleep(20)
    expect(fixture.requests).toHaveLength(0)
  })

  test("the engine loads it as a single plugin export", async () => {
    const config = await temp()
    await mkdir(path.join(config, "plugins"), { recursive: true })
    const { paths } = await installEnginePlugins(config)
    const target = paths.find((entry) => entry.endsWith(CACHE_SELECTION_PLUGIN.file))!
    const mod = await import(pathToFileURL(target).href)
    expect(Object.keys(mod)).toEqual(["flupcodeCacheSelection"])
  })
})
