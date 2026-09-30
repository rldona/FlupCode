/**
 * A stub OpenAI-compatible model the engine talks to over real HTTP.
 *
 * Every chat request takes the next scripted reply from a queue, so a test decides exactly what the
 * "model" says: some text, or a tool call the engine then runs. Title requests (the engine asks the
 * model to name a new session) get a fixed title and never consume the queue, so a test does not
 * have to know when the engine decides to ask.
 */
export type Reply =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; input: unknown }
  /** Starts a reply and never finishes it, for a turn a test interrupts. */
  | { type: "hang" }

export function startModel() {
  const queue: Reply[] = []
  const requests: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      if (isTitleRequest(body)) return stream([...text("Contract")])
      requests.push(body)
      const reply = queue.shift() ?? { type: "text", text: "(no scripted reply)" }
      if (reply.type === "hang") return hang(request.signal)
      return stream(reply.type === "text" ? [...text(reply.text)] : [...tool(reply.name, reply.input)])
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    /** Queues the replies the next chat requests get, in order. */
    push: (...replies: Reply[]) => queue.push(...replies),
    /** Drops replies a failed flow left unused, so they do not answer the next one. */
    reset: () => queue.splice(0),
    /** The chat requests the engine made, title requests excluded. */
    requests,
    stop: () => server.stop(true),
  }
}

/** 1.x and 2.x word their title prompt differently; either one names the request. */
function isTitleRequest(body: unknown) {
  const serialized = JSON.stringify(body)
  return (
    serialized.includes("Generate a title for this conversation") || serialized.includes("You are a title generator")
  )
}

function* text(value: string) {
  yield chunk({ role: "assistant" })
  yield chunk({ content: value })
  yield chunk({}, "stop")
}

function* tool(name: string, input: unknown) {
  const id = `call_${crypto.randomUUID().slice(0, 8)}`
  yield chunk({ role: "assistant" })
  yield chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] })
  yield chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(input) } }] })
  yield chunk({}, "tool_calls")
}

function chunk(delta: Record<string, unknown>, finish?: string) {
  return {
    id: "chatcmpl-contract",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}),
  }
}

function hang(signal: AbortSignal) {
  const body = new ReadableStream({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ role: "assistant" }))}\n\n`))
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk({ content: "Working" }))}\n\n`))
      signal.addEventListener("abort", () => controller.close(), { once: true })
    },
  })
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

function stream(chunks: unknown[]) {
  const body = [...chunks.map((part) => `data: ${JSON.stringify(part)}\n\n`), "data: [DONE]\n\n"].join("")
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}
