import type { SqliteRoutineRepository } from "./repository"
import type { Artifact, ServerEvent, StoredEvent } from "./types"

/**
 * Sent often enough that a client watching for silence can tell a quiet server from a dead socket.
 *
 * Well under Bun.serve's 10s idle cutoff: at exactly 10s the heartbeat raced the socket timeout
 * and long-lived event streams were cut with ERR_INCOMPLETE_CHUNKED_ENCODING.
 */
export const HEARTBEAT_MS = 5_000

/**
 * A client that falls this far behind is dropped rather than buffered. A queue that grows without a
 * bound turns one slow reader into the server's memory problem, and the client loses nothing by
 * being dropped: it reconnects with the sequence it last saw and reads the rest from the database.
 */
export const MAX_PENDING = 500

/**
 * The only fields of an artifact that may cross the stream: never its content, its path or its
 * folder. A reader that needs those asks the artifact route, which is guarded (WA-9).
 */
const PUBLIC_ARTIFACT_FIELDS = ["id", "kind", "title", "producer", "createdAt", "mime"] as const

const publicArtifact = (artifact: Artifact): Record<string, unknown> => {
  const view: Record<string, unknown> = {}
  for (const field of PUBLIC_ARTIFACT_FIELDS) view[field] = artifact[field]
  return view
}

/** A frame's event, with anything an artifact carries beyond what a reader needs stripped out. */
const safeEvent = (event: ServerEvent): ServerEvent =>
  event.type === "artifact.created" || event.type === "artifact.changed"
    ? ({ type: event.type, artifact: publicArtifact(event.artifact) } as ServerEvent)
    : event

const frame = (entry: StoredEvent) => `id: ${entry.seq}\ndata: ${JSON.stringify(safeEvent(entry.event))}\n\n`

/**
 * The server's event stream.
 *
 * Everything the store writes carries a sequence number, so a client says where it got to — in
 * `Last-Event-ID` or `?after=` — and gets what it missed from the database before it starts
 * following along. That is the difference between this and asking every five seconds: no gap, and
 * nothing asked for that has not changed.
 *
 * A client that says nothing gets nothing replayed. It has just read the lists it cares about, so
 * the history would tell it about runs and routines that have since been deleted — which is exactly
 * what happened: every reconnect resurrected every run the server had ever started.
 */
export function eventStream(repository: SqliteRoutineRepository, afterSeq: number | undefined) {
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text))
          return true
        } catch {
          return false
        }
      }

      let cursor = afterSeq ?? repository.lastSeq()
      // The catch-up is read before the subscription starts publishing, and anything that arrives
      // while it runs is caught by the sequence check below rather than sent twice.
      if (afterSeq !== undefined) {
        for (const entry of repository.listEvents(afterSeq, MAX_PENDING)) {
          cursor = entry.seq
          send(frame(entry))
        }
      }

      unsubscribe = repository.subscribe((entry) => {
        if (entry.seq <= cursor) return
        cursor = entry.seq
        if (!send(frame(entry))) close()
      })

      heartbeat = setInterval(() => {
        if (!send(": heartbeat\n\n")) close()
      }, HEARTBEAT_MS)

      send(`: connected ${cursor}\n\n`)
    },
    cancel() {
      close()
    },
  })

  function close() {
    unsubscribe?.()
    unsubscribe = undefined
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = undefined
  }

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
      "access-control-expose-headers": "*",
    },
  })
}

/**
 * Where a client says it got to: the header a browser resends by itself, or an explicit cursor.
 *
 * Undefined when it says nothing, which is not the same as zero: zero means "from the beginning",
 * and a client that never saw an event has no history to be told about.
 */
export function resumeFrom(request: Request) {
  const header = Number(request.headers.get("last-event-id"))
  if (Number.isFinite(header) && header > 0) return header
  const after = Number(new URL(request.url).searchParams.get("after"))
  return Number.isFinite(after) && after > 0 ? after : undefined
}
