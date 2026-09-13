import { createResource as createSolidResource } from "solid-js"

/**
 * `createResource` whose fetches never reject. Reading an errored resource throws, which aborts the
 * render and freezes every view that depends on it; a failed fetch keeps the last value instead.
 * Failures are routine over the remote tunnel, so this matters most on phones.
 */
export const createResource = ((
  source: unknown,
  fetcher: (source: unknown, info: { value: unknown }) => unknown,
  options?: unknown,
) =>
  createSolidResource(
    source as never,
    ((value: unknown, info: { value: unknown }) =>
      Promise.resolve()
        .then(() => fetcher(value, info))
        .catch(() => info.value)) as never,
    options as never,
  )) as typeof createSolidResource
