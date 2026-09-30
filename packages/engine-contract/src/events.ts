/**
 * One of the engine's SSE streams, recorded from the moment it is opened.
 *
 * FlupCode reads two: the per-folder `/event?directory=` (legacy frames, `{type, properties}`) that
 * carries the transcript, and the global `/api/event` (`{type, data}`). Both are normalised to
 * `{type, data}` so a test reads them the same way.
 */
export type EngineEvent = { type: string; data: Record<string, unknown> }

export function recordEvents(url: string, authorization: string) {
  const events: EngineEvent[] = []
  const waiters: Array<{ match: (event: EngineEvent) => boolean; resolve: (event: EngineEvent) => void }> = []
  const controller = new AbortController()
  const opened = Promise.withResolvers<void>()

  void (async () => {
    const response = await fetch(url, {
      headers: { authorization, accept: "text/event-stream" },
      signal: controller.signal,
    }).catch(() => undefined)
    // An engine that does not know the route can still answer 200 with its web UI's HTML (OpenCode 2
    // does for `/event`), so only an event stream counts as opened.
    const type = response?.headers.get("content-type") ?? ""
    if (!response?.ok || !response.body || !type.includes("text/event-stream"))
      return opened.reject(new Error(`${url} is not an event stream (${response?.status} ${type})`))
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
      if (chunk.done) return
      buffer += decoder.decode(chunk.value, { stream: true })
      for (let end = buffer.indexOf("\n\n"); end !== -1; end = buffer.indexOf("\n\n")) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n")
        if (!data) continue
        const parsed = JSON.parse(data) as { type?: string; properties?: unknown; data?: unknown; payload?: unknown }
        // `/global/event` wraps the frame in `payload`; the others do not.
        const body = (parsed.payload ?? parsed) as { type?: string; properties?: unknown; data?: unknown }
        if (!body.type) continue
        const event = { type: body.type, data: (body.properties ?? body.data ?? {}) as Record<string, unknown> }
        if (event.type === "server.connected") opened.resolve()
        events.push(event)
        waiters.splice(0).forEach((waiter) => (waiter.match(event) ? waiter.resolve(event) : waiters.push(waiter)))
      }
    }
  })()

  return {
    events,
    /** Resolves once the engine has sent `server.connected`: events after it are not missed. */
    opened: opened.promise,
    /** The first event, already seen or still to come, that `match` accepts. */
    until: (match: (event: EngineEvent) => boolean, timeout = 30_000) => {
      const seen = events.find(match)
      if (seen) return Promise.resolve(seen)
      return new Promise<EngineEvent>((resolve, reject) => {
        waiters.push({ match, resolve })
        setTimeout(() => {
          const types = [...new Set(events.map((event) => event.type))].join(", ")
          reject(new Error(`No matching event on ${url} within ${timeout}ms. Seen: ${types}`))
        }, timeout)
      })
    },
    close: () => controller.abort(),
  }
}

/**
 * The event types a flow produced, in order, as a fixture can hold them: heartbeats dropped,
 * and runs of the same type collapsed, because how many deltas a reply streams depends on chunking.
 */
export function eventShape(events: EngineEvent[], belongs: (event: EngineEvent) => boolean = () => true) {
  return events
    .filter((event) => event.type !== "server.heartbeat" && belongs(event))
    .map((event) => event.type)
    .filter((type, index, types) => type !== types[index - 1])
}
