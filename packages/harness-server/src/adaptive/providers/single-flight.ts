/**
 * Single-flight dedupe by key (FH-013b).
 *
 * Two concurrent callers asking the exact same question share one outbound call: the key carries
 * the kind, the inputs hash and the pinned model, so only genuinely identical questions collapse.
 * The entry is dropped when the promise settles, so a later call is free to ask again.
 */

export type SingleFlight = {
  run<T>(key: string, work: () => Promise<T>): Promise<T>
  size(): number
}

export function createSingleFlight(): SingleFlight {
  const inflight = new Map<string, Promise<unknown>>()

  return {
    size: () => inflight.size,
    run: <T>(key: string, work: () => Promise<T>): Promise<T> => {
      const existing = inflight.get(key)
      // The key encodes the kind and the redacted inputs, so the shared promise is the same answer.
      if (existing) return existing as Promise<T>
      const promise = work().finally(() => inflight.delete(key))
      inflight.set(key, promise)
      return promise
    },
  }
}
