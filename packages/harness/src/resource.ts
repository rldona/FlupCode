import {
  createResource as createSolidResource,
  createSignal,
  type Accessor,
  type NoInfer,
  type Resource,
  type ResourceActions,
  type ResourceFetcher,
  type ResourceOptions,
  type ResourceSource,
} from "solid-js"

/** A resource that keeps its last value through a failed fetch, plus the failure that did it. */
export type StaleResource<T> = Resource<T> & { failure: Accessor<Error | undefined> }

/**
 * `createResource` whose fetches never reject. Reading an errored resource throws, which aborts the
 * render and freezes every view that depends on it; a failed fetch keeps the last value instead.
 * Failures are routine over the remote tunnel, so this matters most on phones.
 *
 * The failure is not swallowed, though: `failure()` holds the last one until a fetch succeeds, so a
 * view can say its data is stale instead of quietly showing an answer from before the engine went
 * away.
 */
export function createResource<T, S>(
  source: ResourceSource<S>,
  fetcher: ResourceFetcher<S, T>,
  options?: ResourceOptions<NoInfer<T>, S>,
): [StaleResource<T | undefined>, ResourceActions<T | undefined, S>] {
  const [failure, setFailure] = createSignal<Error | undefined>()
  const [value, actions] = createSolidResource(
    source,
    ((current: S, info: { value: T | undefined }) =>
      Promise.resolve()
        .then(() => fetcher(current, info as never))
        .then(
          (result) => {
            setFailure(undefined)
            return result
          },
          (cause: unknown) => {
            setFailure(cause instanceof Error ? cause : new Error(String(cause)))
            return info.value
          },
        )) as ResourceFetcher<S, T>,
    options,
  )
  return [Object.assign(value, { failure }), actions]
}
