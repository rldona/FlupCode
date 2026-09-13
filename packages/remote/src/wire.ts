import type { Bytes } from "./bytes"

/**
 * An ordered, message-oriented byte pipe (a relayed WebSocket, or one channel of the host socket).
 * Producers call `push` / `end`; consumers either pull with `next` or subscribe with `listen`.
 */
export class Wire {
  #queue: Bytes[] = []
  #waiters: ((data: Bytes | undefined) => void)[] = []
  #listener: ((data: Bytes) => void) | undefined
  #closeHandlers = new Set<() => void>()
  #closed = false

  constructor(
    private readonly transmit: (data: Bytes) => void,
    private readonly terminate: (code?: number, reason?: string) => void = () => {},
  ) {}

  get closed() {
    return this.#closed
  }

  send(data: Bytes) {
    if (this.#closed) return
    this.transmit(data)
  }

  close(code?: number, reason?: string) {
    if (this.#closed) return
    this.terminate(code, reason)
    this.end()
  }

  push(data: Bytes) {
    if (this.#closed) return
    if (this.#listener) return this.#listener(data)
    const waiter = this.#waiters.shift()
    if (waiter) return waiter(data)
    this.#queue.push(data)
  }

  end() {
    if (this.#closed) return
    this.#closed = true
    this.#waiters.splice(0).forEach((waiter) => waiter(undefined))
    this.#closeHandlers.forEach((handler) => handler())
    this.#closeHandlers.clear()
  }

  next(): Promise<Bytes | undefined> {
    const queued = this.#queue.shift()
    if (queued) return Promise.resolve(queued)
    if (this.#closed) return Promise.resolve(undefined)
    return new Promise((resolve) => this.#waiters.push(resolve))
  }

  listen(listener: (data: Bytes) => void) {
    this.#listener = listener
    this.#queue.splice(0).forEach(listener)
  }

  onClose(handler: () => void) {
    if (this.#closed) return handler()
    this.#closeHandlers.add(handler)
  }
}

/** Two wires connected to each other, for tests and in-process use. */
export function wirePair() {
  const a: Wire = new Wire(
    (data) => queueMicrotask(() => b.push(data)),
    () => queueMicrotask(() => b.end()),
  )
  const b: Wire = new Wire(
    (data) => queueMicrotask(() => a.push(data)),
    () => queueMicrotask(() => a.end()),
  )
  return [a, b] as const
}
