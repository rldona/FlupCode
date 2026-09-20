/**
 * Split view: several sessions side by side in one window, each with its own transcript and input.
 * The focused pane is the app's selected session, so the sidebar, top bar and context panel follow it.
 */

/** Two is the usual case; more gets too narrow to read. */
export const MAX_PANES = 4

export type SplitState = { panes: string[]; focus: string | undefined }

/** Opens a session next to the open one, or focuses it when it is already a pane. */
export function openInSplit(state: SplitState, id: string): SplitState {
  if (state.panes.includes(id)) return { panes: state.panes, focus: id }
  if (state.panes.length === 0) {
    if (!state.focus || state.focus === id) return { panes: [], focus: id }
    return { panes: [state.focus, id], focus: id }
  }
  if (state.panes.length >= MAX_PANES) return { panes: replace(state.panes, state.focus, id), focus: id }
  return { panes: [...state.panes, id], focus: id }
}

/** Opening a session from the sidebar while split shows it in the focused pane. */
export function showInFocusedPane(state: SplitState, id: string): SplitState {
  if (state.panes.length === 0 || state.panes.includes(id)) return { panes: state.panes, focus: id }
  return { panes: replace(state.panes, state.focus, id), focus: id }
}

/** Closing down to one pane leaves split view with that session open. */
export function closePane(state: SplitState, id: string): SplitState {
  const index = state.panes.indexOf(id)
  if (index === -1) return state
  const panes = state.panes.filter((pane) => pane !== id)
  const focus = state.focus === id ? (panes[Math.min(index, panes.length - 1)] ?? undefined) : state.focus
  if (panes.length < 2) return { panes: [], focus: panes[0] ?? focus }
  return { panes, focus }
}

/** Drops panes whose session no longer exists. */
export function keepExisting(state: SplitState, exists: (id: string) => boolean): SplitState {
  const gone = state.panes.filter((pane) => !exists(pane))
  return gone.reduce((next, id) => closePane(next, id), state)
}

function replace(panes: string[], focus: string | undefined, id: string) {
  const index = focus ? panes.indexOf(focus) : -1
  const at = index === -1 ? panes.length - 1 : index
  return panes.map((pane, position) => (position === at ? id : pane))
}
