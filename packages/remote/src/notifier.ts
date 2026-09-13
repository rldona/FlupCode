import type { PushNotification } from "./webpush"

/**
 * Watches the engine's event stream and reports what a phone should be told about (ADR-0011):
 * a permission request, a question, a finished turn or a failed step.
 */

export type EngineNotification = Pick<PushNotification, "kind" | "sessionID" | "session" | "detail">

/** A step that ends without tool calls ends the turn, unless another step starts soon after. */
const FINISH_DELAY = 2_500

export function watchEngineEvents(input: {
  engine: string
  credentials?: string
  fetch?: typeof globalThis.fetch
  onNotification: (notification: EngineNotification) => void
  /** Delay before a turn counts as finished; tests shorten it. */
  finishDelay?: number
}) {
  const doFetch = input.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { accept: "text/event-stream" }
  if (input.credentials) headers.authorization = `Basic ${input.credentials}`
  const controller = new AbortController()
  const finishing = new Map<string, ReturnType<typeof setTimeout>>()
  const titles = new Map<string, string>()

  const title = async (sessionID: string) => {
    const cached = titles.get(sessionID)
    if (cached) return cached
    const response = await doFetch(new URL(`/api/session/${encodeURIComponent(sessionID)}`, input.engine), {
      headers: input.credentials ? { authorization: `Basic ${input.credentials}` } : {},
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
    }).catch(() => undefined)
    const body = response?.ok
      ? ((await response.json().catch(() => undefined)) as { data?: { title?: string } })
      : undefined
    const value = body?.data?.title?.trim() || "Session"
    titles.set(sessionID, value)
    return value
  }

  const emit = (kind: EngineNotification["kind"], sessionID: string, detail?: string) =>
    void title(sessionID).then((session) => {
      if (controller.signal.aborted) return
      input.onNotification({ kind, sessionID, session, ...(detail ? { detail } : {}) })
    })

  const handle = (event: { type?: unknown; data?: unknown }) => {
    const data = (typeof event.data === "object" && event.data !== null ? event.data : {}) as Record<string, unknown>
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    if (!sessionID || typeof event.type !== "string") return
    if (event.type === "session.updated" || event.type === "session.next.titled") titles.delete(sessionID)
    if (event.type === "session.next.step.started" || event.type === "session.next.prompted") {
      clearTimeout(finishing.get(sessionID))
      return void finishing.delete(sessionID)
    }
    if (event.type === "session.next.step.ended") {
      clearTimeout(finishing.get(sessionID))
      if (data.finish === "tool-calls") return void finishing.delete(sessionID)
      finishing.set(
        sessionID,
        setTimeout(() => {
          finishing.delete(sessionID)
          emit("finished", sessionID)
        }, input.finishDelay ?? FINISH_DELAY),
      )
      return
    }
    if (event.type === "session.next.step.failed") {
      clearTimeout(finishing.get(sessionID))
      finishing.delete(sessionID)
      return emit("failed", sessionID)
    }
    if (event.type === "permission.v2.asked") {
      const resources = Array.isArray(data.resources) ? data.resources.filter((item) => typeof item === "string") : []
      const action = typeof data.action === "string" ? data.action : undefined
      return emit("permission", sessionID, [action, resources.join(", ")].filter(Boolean).join(": "))
    }
    if (event.type === "question.v2.asked") {
      const first = Array.isArray(data.questions)
        ? (data.questions[0] as { question?: unknown } | undefined)
        : undefined
      return emit("question", sessionID, typeof first?.question === "string" ? first.question : undefined)
    }
  }

  const run = async () => {
    for (let attempt = 0; !controller.signal.aborted; attempt++) {
      const response = await doFetch(new URL("/api/event", input.engine), {
        headers,
        signal: controller.signal,
      }).catch(() => undefined)
      const reader = response?.ok ? response.body?.getReader() : undefined
      if (reader) attempt = 0
      const decoder = new TextDecoder()
      let buffer = ""
      while (reader) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }))
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n")
        const blocks = buffer.split("\n\n")
        buffer = blocks.pop() ?? ""
        blocks.forEach((block) => {
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (!data) return
          try {
            handle(JSON.parse(data) as { type?: unknown; data?: unknown })
          } catch {
            return
          }
        })
      }
      if (controller.signal.aborted) return
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** attempt)))
    }
  }

  void run()

  return {
    stop() {
      controller.abort()
      finishing.forEach((timer) => clearTimeout(timer))
      finishing.clear()
    },
  }
}
