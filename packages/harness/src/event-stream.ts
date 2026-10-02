import { anonymousFetch, engineFetch } from "./transport"

/**
 * How long a stream may go without a single byte before it is treated as dead. The engine beats
 * every 15 seconds on its event stream, so this is three missed beats. Without it a
 * socket that dies without closing — sleep, a NAT timeout, a dropped tunnel — leaves the read
 * pending forever, which is how the app could sit on "Connected" while the engine moved on.
 */
const STREAM_IDLE_TIMEOUT = 45_000

export async function* subscribeEvents(
  baseUrl: string,
  signal: AbortSignal | undefined,
  path: string,
  idleTimeout = STREAM_IDLE_TIMEOUT,
  /** The harness stream: not the engine, so without its credentials (see `anonymousFetch`). */
  anonymous = false,
  /** Extra headers for the stream request, e.g. the harness loopback bearer. */
  extraHeaders?: Record<string, string>,
) {
  // Own controller so an idle stream can be dropped without touching the caller's signal, which it
  // uses to tell a stream it ended from one it should reopen.
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) controller.abort()
  const fetch = anonymous ? anonymousFetch : engineFetch
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    headers: { Accept: "text/event-stream", ...extraHeaders },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) return
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let quiet = false
  while (true) {
    // Cancelling the reader, not just aborting the request, is what makes a pending read resolve:
    // a body the fetch never produced (the remote tunnel, a test transport) ignores the signal.
    const idle = setTimeout(() => {
      quiet = true
      abort()
      void reader.cancel().catch(() => undefined)
    }, idleTimeout)
    const { done, value } = await reader.read().finally(() => clearTimeout(idle))
    if (quiet) throw new Error("Event stream went quiet")
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n")
    let index = buffer.indexOf("\n\n")
    while (index !== -1) {
      const chunk = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
      if (data) {
        try {
          const event = JSON.parse(data) as { type?: string; data?: unknown; properties?: unknown }
          // Folder streams use the legacy shape, with the payload under `properties`.
          yield (
            event.data === undefined && event.properties !== undefined ? { ...event, data: event.properties } : event
          ) as { type?: string }
        } catch {
          // ignore malformed frames
        }
      }
      index = buffer.indexOf("\n\n")
    }
  }
}
