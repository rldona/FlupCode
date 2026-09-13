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
  wsOpen: 0x20,
  wsOpened: 0x21,
  wsText: 0x22,
  wsBinary: 0x23,
  wsClose: 0x24,
  control: 0x30,
} as const

const CHUNK = 64 * 1024
const NULL_BODY_STATUS = new Set([101, 204, 205, 304])
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
const DROPPED_RESPONSE_HEADERS = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "set-cookie"])

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

function readJson(payload: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(text(payload))
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
}

function headerList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2 && entry.every((part) => typeof part === "string"))
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
    const payload = typeof data === "string" ? data : this.binaryType === "arraybuffer" ? data.slice().buffer : new Blob([data.slice()])
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
        return stream.socket.finish(typeof value.code === "number" ? value.code : 1006, typeof value.reason === "string" ? value.reason : "")
      }
      return
    }
    if (frame.type === Type.resHead) {
      const head = readJson(frame.payload)
      const status = typeof head.status === "number" ? head.status : 502
      const init = { status, statusText: typeof head.statusText === "string" ? head.statusText : "", headers: headerList(head.headers) }
      if (NULL_BODY_STATUS.has(status)) {
        streams.delete(frame.stream)
        return stream.resolve(new Response(null, init))
      }
      return stream.resolve(
        new Response(
          new ReadableStream<Bytes>({
            start(controller) {
              stream.controller = controller
            },
            cancel() {
              if (!streams.delete(frame.stream)) return
              channel.send(encode(Type.abort, frame.stream))
            },
          }),
          init,
        ),
      )
    }
    if (frame.type === Type.resBody) return stream.controller?.enqueue(frame.payload.slice())
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

  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (channel.closed) throw new TypeError("Remote connection closed")
    if (request.signal.aborted) throw request.signal.reason
    const url = new URL(request.url)
    const body = request.body ? new Uint8Array(await request.arrayBuffer()) : undefined
    const id = nextStream++
    const response = new Promise<Response>((resolve, reject) => streams.set(id, { kind: "http", resolve, reject }))
    sendJson(channel, Type.reqHead, id, { method: request.method, path: url.pathname + url.search, headers: [...request.headers] })
    if (body) sendChunks(channel, Type.reqBody, id, body)
    channel.send(encode(Type.reqEnd, id))
    const onAbort = () => {
      const stream = streams.get(id)
      if (!stream) return
      streams.delete(id)
      channel.send(encode(Type.abort, id))
      fail(stream, request.signal.reason instanceof Error ? request.signal.reason : new DOMException("Aborted", "AbortError"))
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

/** Host side of the tunnel: replays requests and sockets against the local engine. */
export function serveTunnel(
  channel: SecureChannel,
  options: {
    target: string
    /** `base64(user:pass)` for the engine, when it requires Basic auth. */
    credentials?: string
    fetch?: typeof globalThis.fetch
    createSocket?: (url: string) => HostSocket
  },
) {
  const doFetch = options.fetch ?? globalThis.fetch
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as HostSocket)
  const target = new URL(options.target)
  const control = controlListeners()
  const requests = new Map<number, { head: Record<string, unknown>; chunks: Uint8Array[]; abort: AbortController }>()
  const sockets = new Map<number, HostSocket>()

  const resolve = (path: unknown) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return undefined
    const url = new URL(path, target)
    return url.origin === target.origin ? url : undefined
  }

  const abortStream = (stream: number, message: string) =>
    sendJson(channel, Type.abort, stream, { message })

  const run = async (stream: number, entry: { head: Record<string, unknown>; chunks: Uint8Array[]; abort: AbortController }) => {
    const url = resolve(entry.head.path)
    if (!url) return abortStream(stream, "Invalid path")
    const headers = new Headers(headerList(entry.head.headers).filter(([name]) => !DROPPED_REQUEST_HEADERS.has(name.toLowerCase())))
    if (options.credentials) headers.set("authorization", `Basic ${options.credentials}`)
    const method = typeof entry.head.method === "string" ? entry.head.method.toUpperCase() : "GET"
    const response = await doFetch(url, {
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
      if (!requests.has(stream)) return reader.cancel()
      sendChunks(channel, Type.resBody, stream, chunk.value)
    }
    requests.delete(stream)
    channel.send(encode(Type.resEnd, stream))
  }

  const openSocket = (stream: number, head: Record<string, unknown>) => {
    const url = resolve(head.path)
    if (!url) return sendJson(channel, Type.wsClose, stream, { code: 1008, reason: "Invalid path" })
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

  channel.onMessage((data) => {
    const frame = decode(data)
    if (!frame) return
    if (frame.type === Type.control) return control.emit(frame.payload)
    if (frame.type === Type.reqHead)
      return requests.set(frame.stream, { head: readJson(frame.payload), chunks: [], abort: new AbortController() })
    if (frame.type === Type.reqBody) return requests.get(frame.stream)?.chunks.push(frame.payload.slice())
    if (frame.type === Type.reqEnd) {
      const entry = requests.get(frame.stream)
      if (!entry) return
      return void run(frame.stream, entry).catch((error: unknown) => {
        if (!requests.delete(frame.stream)) return
        abortStream(frame.stream, error instanceof Error ? error.message : String(error))
      })
    }
    if (frame.type === Type.abort) {
      const entry = requests.get(frame.stream)
      requests.delete(frame.stream)
      return entry?.abort.abort()
    }
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
    requests.forEach((entry) => entry.abort.abort())
    requests.clear()
    sockets.forEach((socket) => socket.close())
    sockets.clear()
  })

  return {
    onControl: control.add,
    sendControl: (message: ControlMessage) => sendJson(channel, Type.control, 0, message),
    close: () => channel.close(),
  }
}
