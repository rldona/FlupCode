import { asBytes, concat, text, utf8, type Bytes } from "./bytes"
import type { SecureChannel } from "./channel"

/** HTTP and WebSocket multiplexing over a secure channel (ADR-0010). */

const Type = {
  reqHead: 0x10,
  reqBody: 0x11,
  reqEnd: 0x12,
  resHead: 0x13,
  resBody: 0x14,
  resEnd: 0x15,
  abort: 0x16,
  /** The client read this many more bytes of a response (HE-02): the host may send that much more. */
  credit: 0x17,
  wsOpen: 0x20,
  wsOpened: 0x21,
  wsText: 0x22,
  wsBinary: 0x23,
  wsClose: 0x24,
  control: 0x30,
} as const

const CHUNK = 64 * 1024
/**
 * How far a response may run ahead of the phone reading it (HE-02). The host sends no more than this
 * past what the phone said it read, so a large artifact or a slow phone holds a window's worth of
 * memory on each side instead of the whole body. A client that predates flow control does not ask for
 * it, and is sent everything as before.
 */
export const FLOW_WINDOW = 1024 * 1024
/** The phone says what it read in steps of this, not per chunk. */
const CREDIT_STEP = FLOW_WINDOW / 4
/** The largest request body the host accepts from a phone; anything over is answered 413 unsent. */
export const MAX_REQUEST_BODY = 32 * 1024 * 1024
const NULL_BODY_STATUS = new Set([204, 205, 304])
const DROPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "origin",
  "referer",
  "cookie",
  "authorization",
  "accept-encoding",
])
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "set-cookie",
])

type BinaryType = "blob" | "arraybuffer"

export type ControlMessage = Record<string, unknown> & { type: string }

function encode(type: number, stream: number, payload: Uint8Array = new Uint8Array(0)) {
  const head = new Uint8Array(5)
  head[0] = type
  new DataView(head.buffer).setUint32(1, stream)
  return concat(head, payload)
}

function decode(data: Bytes) {
  if (data.byteLength < 5) return undefined
  return {
    type: data[0]!,
    stream: new DataView(data.buffer, data.byteOffset).getUint32(1),
    payload: data.subarray(5),
  }
}

function sendJson(channel: SecureChannel, type: number, stream: number, value: unknown) {
  channel.send(encode(type, stream, utf8(JSON.stringify(value))))
}

function sendChunks(channel: SecureChannel, type: number, stream: number, bytes: Uint8Array) {
  Array.from({ length: Math.ceil(bytes.byteLength / CHUNK) }, (_, index) =>
    bytes.subarray(index * CHUNK, (index + 1) * CHUNK),
  ).forEach((chunk) => channel.send(encode(type, stream, chunk)))
}

function uint32(value: number) {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

function readJson(payload: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(text(payload))
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function headerList(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"),
      )
    : []
}

function controlListeners() {
  const listeners = new Set<(message: ControlMessage) => void>()
  return {
    add(listener: (message: ControlMessage) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit(payload: Uint8Array) {
      const message = readJson(payload)
      if (typeof message.type !== "string") return
      listeners.forEach((listener) => listener(message as ControlMessage))
    },
  }
}

/** The subset of the browser WebSocket API used against the engine. */
export type EngineSocket = {
  readonly readyState: number
  binaryType: BinaryType
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
}

type ClientStream =
  | {
      kind: "http"
      resolve: (response: Response) => void
      reject: (error: unknown) => void
      controller?: ReadableStreamDefaultController<Bytes>
      /** Bytes of the body received, and how many of them the host was told were read. */
      received: number
      credited: number
    }
  | { kind: "ws"; socket: TunnelSocket }

class TunnelSocket implements EngineSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readyState = 0
  binaryType: BinaryType = "blob"
  onopen: ((event: Event) => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null
  onerror: ((event: Event) => void) | null = null

  constructor(
    private readonly transmit: (type: number, payload?: Uint8Array) => void,
    private readonly release: () => void,
  ) {}

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== 1) return
    if (typeof data === "string") return this.transmit(Type.wsText, utf8(data))
    if (data instanceof ArrayBuffer) return this.transmit(Type.wsBinary, new Uint8Array(data))
    this.transmit(Type.wsBinary, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return
    this.readyState = 2
    this.transmit(Type.wsClose, utf8(JSON.stringify({ code, reason })))
    this.finish(code, reason)
  }

  opened() {
    if (this.readyState !== 0) return
    this.readyState = 1
    this.onopen?.(new Event("open"))
  }

  message(data: string | Uint8Array) {
    if (this.readyState !== 1) return
    const payload =
      typeof data === "string"
        ? data
        : this.binaryType === "arraybuffer"
          ? data.slice().buffer
          : new Blob([data.slice()])
    this.onmessage?.(new MessageEvent("message", { data: payload }))
  }

  finish(code: number, reason: string, failed = false) {
    if (this.readyState === 3) return
    this.readyState = 3
    this.release()
    if (failed) this.onerror?.(new Event("error"))
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: !failed }))
  }
}

/** Client side of the tunnel: a `fetch` and a WebSocket factory that reach the host's engine. */
export function createTunnelClient(channel: SecureChannel) {
  const streams = new Map<number, ClientStream>()
  const control = controlListeners()
  let nextStream = 1

  const fail = (stream: ClientStream, error: Error) => {
    if (stream.kind === "ws") return stream.socket.finish(1006, error.message, true)
    stream.reject(error)
    try {
      stream.controller?.error(error)
    } catch {
      return
    }
  }

  channel.onMessage((data) => {
    const frame = decode(data)
    if (!frame) return
    if (frame.type === Type.control) return control.emit(frame.payload)
    const stream = streams.get(frame.stream)
    if (!stream) return
    if (stream.kind === "ws") {
      if (frame.type === Type.wsOpened) return stream.socket.opened()
      if (frame.type === Type.wsText) return stream.socket.message(text(frame.payload))
      if (frame.type === Type.wsBinary) return stream.socket.message(frame.payload.slice())
      if (frame.type === Type.wsClose) {
        const value = readJson(frame.payload)
        return stream.socket.finish(
          typeof value.code === "number" ? value.code : 1006,
          typeof value.reason === "string" ? value.reason : "",
        )
      }
      return
    }
    if (frame.type === Type.resHead) {
      const head = readJson(frame.payload)
      const status = typeof head.status === "number" ? head.status : 502
      const init = {
        status,
        statusText: typeof head.statusText === "string" ? head.statusText : "",
        headers: headerList(head.headers),
      }
      if (NULL_BODY_STATUS.has(status)) {
        streams.delete(frame.stream)
        return stream.resolve(new Response(null, init))
      }
      return stream.resolve(
        new Response(
          new ReadableStream<Bytes>(
            {
              start(controller) {
                stream.controller = controller
              },
              // Called as the reader takes chunks out: what left the queue was read, and the host may
              // send that much more.
              pull(controller) {
                const read = stream.received - (FLOW_WINDOW - (controller.desiredSize ?? 0)) - stream.credited
                if (read < CREDIT_STEP || !streams.has(frame.stream)) return
                stream.credited += read
                channel.send(encode(Type.credit, frame.stream, uint32(read)))
              },
              cancel() {
                if (!streams.delete(frame.stream)) return
                channel.send(encode(Type.abort, frame.stream))
              },
            },
            new ByteLengthQueuingStrategy({ highWaterMark: FLOW_WINDOW }),
          ),
          init,
        ),
      )
    }
    if (frame.type === Type.resBody) {
      stream.received += frame.payload.byteLength
      return stream.controller?.enqueue(frame.payload.slice())
    }
    if (frame.type === Type.resEnd) {
      streams.delete(frame.stream)
      return stream.controller?.close()
    }
    if (frame.type === Type.abort) {
      streams.delete(frame.stream)
      const value = readJson(frame.payload)
      fail(stream, new Error(typeof value.message === "string" ? value.message : "Remote request failed"))
    }
  })

  channel.onClose(() => {
    const error = new Error("Remote connection closed")
    streams.forEach((stream) => fail(stream, error))
    streams.clear()
  })

  const fetch = async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (channel.closed) throw new TypeError("Remote connection closed")
    if (request.signal.aborted) throw request.signal.reason
    const url = new URL(request.url)
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    const id = nextStream++
    const response = new Promise<Response>((resolve, reject) =>
      streams.set(id, { kind: "http", resolve, reject, received: 0, credited: 0 }),
    )
    sendJson(channel, Type.reqHead, id, {
      method: request.method,
      path: url.pathname + url.search,
      headers: [...request.headers],
      flow: true,
    })
    if (body) sendChunks(channel, Type.reqBody, id, body)
    channel.send(encode(Type.reqEnd, id))
    const onAbort = () => {
      const stream = streams.get(id)
      if (!stream) return
      streams.delete(id)
      channel.send(encode(Type.abort, id))
      fail(
        stream,
        request.signal.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"),
      )
    }
    request.signal.addEventListener("abort", onAbort, { once: true })
    return response
  }

  const socket = (url: string | URL): EngineSocket => {
    const id = nextStream++
    const target = new URL(url)
    const created = new TunnelSocket(
      (type, payload) => channel.send(encode(type, id, payload)),
      () => streams.delete(id),
    )
    streams.set(id, { kind: "ws", socket: created })
    if (channel.closed) {
      queueMicrotask(() => created.finish(1006, "Remote connection closed", true))
      return created
    }
    sendJson(channel, Type.wsOpen, id, { path: target.pathname + target.search })
    return created
  }

  return {
    fetch,
    socket,
    onControl: control.add,
    sendControl: (message: ControlMessage) => sendJson(channel, Type.control, 0, message),
    close: () => channel.close(),
    get closed() {
      return channel.closed
    },
    onClose: (handler: () => void) => channel.onClose(handler),
  }
}

export type TunnelClient = ReturnType<typeof createTunnelClient>

type HostSocket = {
  readyState: number
  binaryType: BinaryType
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  onerror: ((event: Event) => void) | null
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
}

type HostRequest = {
  head: Record<string, unknown>
  chunks: Uint8Array[]
  /** Bytes of body received; past `MAX_REQUEST_BODY` the chunks are dropped and the answer is 413. */
  size: number
  abort: AbortController
  /** How much more of the response the client may be sent; unbounded for a client without flow control. */
  window: number
  wake?: () => void
}

/**
 * Host side of the tunnel: replays requests and sockets against the local engine, and `/harness/*`
 * against the harness beside it (HE-02) with the remote host's own bearer.
 */
export function serveTunnel(
  channel: SecureChannel,
  options: {
    target: string
    /** `base64(user:pass)` for the engine, when it requires Basic auth. */
    credentials?: string
    /**
     * FlupCode's harness, which `/harness/*` reaches instead of the engine, and the `remote`-scoped
     * token it is called with: read on each call, so a token the harness rotated is picked up. Without
     * one the call goes out with no bearer, and the harness refuses it.
     */
    harness?: { target: string; token: () => string | undefined }
    fetch?: typeof globalThis.fetch
    createSocket?: (url: string) => HostSocket
  },
) {
  const doFetch = options.fetch ?? globalThis.fetch
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as HostSocket)
  const target = new URL(options.target)
  const control = controlListeners()
  const requests = new Map<number, HostRequest>()
  const sockets = new Map<number, HostSocket>()

  /** Where a path goes, decided on the path it resolves to: `/harness/../api` is the engine's. */
  const resolve = (path: unknown) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return undefined
    const url = new URL(path, target)
    if (url.origin !== target.origin) return undefined
    const harness = options.harness && (url.pathname === "/harness" || url.pathname.startsWith("/harness/"))
    if (!harness) return { url, harness: false }
    return { url: new URL(url.pathname + url.search, options.harness!.target), harness: true }
  }

  const abortStream = (stream: number, message: string) => sendJson(channel, Type.abort, stream, { message })

  const answer = (stream: number, status: number, body: Record<string, unknown>) => {
    requests.delete(stream)
    sendJson(channel, Type.resHead, stream, { status, statusText: "", headers: [["content-type", "application/json"]] })
    channel.send(encode(Type.resBody, stream, utf8(JSON.stringify(body))))
    channel.send(encode(Type.resEnd, stream))
  }

  /** Sends a body piece once the client has room for it; false once the request is gone. */
  const sendBody = async (stream: number, entry: HostRequest, bytes: Uint8Array) => {
    for (let offset = 0; offset < bytes.byteLength; offset += CHUNK) {
      while (entry.window <= 0 && requests.has(stream)) await new Promise<void>((wake) => (entry.wake = wake))
      if (!requests.has(stream)) return false
      const piece = bytes.subarray(offset, offset + CHUNK)
      entry.window -= piece.byteLength
      channel.send(encode(Type.resBody, stream, piece))
    }
    return true
  }

  const run = async (stream: number, entry: HostRequest) => {
    if (entry.size > MAX_REQUEST_BODY)
      return answer(stream, 413, { error: "Request body too large for remote control", code: "too_large" })
    const route = resolve(entry.head.path)
    if (!route) return abortStream(stream, "Invalid path")
    const headers = new Headers(
      headerList(entry.head.headers).filter(([name]) => !DROPPED_REQUEST_HEADERS.has(name.toLowerCase())),
    )
    const token = route.harness ? options.harness!.token() : undefined
    if (token) headers.set("authorization", `Bearer ${token}`)
    if (!route.harness && options.credentials) headers.set("authorization", `Basic ${options.credentials}`)
    const method = typeof entry.head.method === "string" ? entry.head.method.toUpperCase() : "GET"
    const response = await doFetch(route.url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" || entry.chunks.length === 0 ? undefined : concat(...entry.chunks),
      signal: entry.abort.signal,
    })
    sendJson(channel, Type.resHead, stream, {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers].filter(([name]) => !DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())),
    })
    if (NULL_BODY_STATUS.has(response.status)) return requests.delete(stream)
    const reader = response.body?.getReader()
    while (reader) {
      const chunk = await reader.read()
      if (chunk.done) break
      if (!(await sendBody(stream, entry, chunk.value))) return reader.cancel()
    }
    requests.delete(stream)
    channel.send(encode(Type.resEnd, stream))
  }

  const openSocket = (stream: number, head: Record<string, unknown>) => {
    const route = resolve(head.path)
    if (!route) return sendJson(channel, Type.wsClose, stream, { code: 1008, reason: "Invalid path" })
    // The harness has no sockets: its stream is a plain request.
    if (route.harness) return sendJson(channel, Type.wsClose, stream, { code: 1008, reason: "Not a socket" })
    const url = route.url
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
    if (options.credentials) url.searchParams.set("auth_token", options.credentials)
    const socket = createSocket(url.toString())
    socket.binaryType = "arraybuffer"
    sockets.set(stream, socket)
    socket.onopen = () => channel.send(encode(Type.wsOpened, stream))
    socket.onmessage = (event) => {
      const data: unknown = event.data
      if (typeof data === "string") return channel.send(encode(Type.wsText, stream, utf8(data)))
      void asBytes(data as ArrayBuffer).then((bytes) => channel.send(encode(Type.wsBinary, stream, bytes)))
    }
    socket.onclose = (event) => {
      if (!sockets.delete(stream)) return
      sendJson(channel, Type.wsClose, stream, { code: event.code, reason: event.reason })
    }
    socket.onerror = () => undefined
  }

  const forget = (stream: number) => {
    const entry = requests.get(stream)
    requests.delete(stream)
    entry?.abort.abort()
    entry?.wake?.()
  }

  channel.onMessage((data) => {
    const frame = decode(data)
    if (!frame) return
    if (frame.type === Type.control) return control.emit(frame.payload)
    if (frame.type === Type.reqHead) {
      const head = readJson(frame.payload)
      return requests.set(frame.stream, {
        head,
        chunks: [],
        size: 0,
        abort: new AbortController(),
        window: head.flow === true ? FLOW_WINDOW : Number.POSITIVE_INFINITY,
      })
    }
    if (frame.type === Type.reqBody) {
      const entry = requests.get(frame.stream)
      if (!entry) return
      entry.size += frame.payload.byteLength
      // Past the cap nothing more is kept: the request is answered 413 when it ends.
      if (entry.size > MAX_REQUEST_BODY) return void (entry.chunks = [])
      return entry.chunks.push(frame.payload.slice())
    }
    if (frame.type === Type.reqEnd) {
      const entry = requests.get(frame.stream)
      if (!entry) return
      return void run(frame.stream, entry).catch((error: unknown) => {
        if (!requests.delete(frame.stream)) return
        abortStream(frame.stream, error instanceof Error ? error.message : String(error))
      })
    }
    if (frame.type === Type.credit) {
      const entry = requests.get(frame.stream)
      if (!entry || frame.payload.byteLength !== 4) return
      entry.window += new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0)
      const wake = entry.wake
      entry.wake = undefined
      return wake?.()
    }
    if (frame.type === Type.abort) return forget(frame.stream)
    if (frame.type === Type.wsOpen) return openSocket(frame.stream, readJson(frame.payload))
    const socket = sockets.get(frame.stream)
    if (!socket) return
    if (frame.type === Type.wsText) return socket.send(text(frame.payload))
    if (frame.type === Type.wsBinary) return socket.send(frame.payload.slice())
    if (frame.type === Type.wsClose) {
      sockets.delete(frame.stream)
      socket.close()
    }
  })

  channel.onClose(() => {
    Array.from(requests.keys()).forEach(forget)
    sockets.forEach((socket) => socket.close())
    sockets.clear()
  })

  return {
    onControl: control.add,
    sendControl: (message: ControlMessage) => sendJson(channel, Type.control, 0, message),
    close: () => channel.close(),
  }
}
