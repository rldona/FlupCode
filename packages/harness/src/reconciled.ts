import { createEffect } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

/**
 * A resource-backed list whose rows keep their identity across refetches. The engine resends the
 * whole list on every event, and `<For>` matches by reference, so a plain resource rebuilds every
 * row and loses the state held inside it: an opened tool, a half-typed question answer. Reconciling
 * by id merges the new payload into the existing rows instead.
 */
export function createReconciledList<T extends { id: string }>(read: () => T[] | undefined) {
  const [list, setList] = createStore<T[]>([])
  createEffect(() => setList(reconcile(read() ?? [], { key: "id" })))
  return list
}
