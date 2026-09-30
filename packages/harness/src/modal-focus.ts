/**
 * Moves the focus into a modal as it opens and gives it back to what opened it as it closes (AH-E06).
 *
 * Escape and the Tab loop are the app's own, done once for every dialog (H-24, `app.tsx`); this is the
 * half a dialog has to ask for, because only it knows when it mounts. The dialog itself takes the
 * focus, not its first button, so a screen reader reads its name first and Enter or Space never lands
 * on a destructive button by accident. It needs `tabIndex={-1}`.
 *
 * `returnTo` names where the focus goes back to when that is not simply what had it — a dialog opened
 * by a link rather than by a click, say. Returns the cleanup, for `onCleanup`. A focus the reader
 * moved elsewhere on purpose is left alone.
 */
export function holdModalFocus(dialog: HTMLElement, returnTo?: () => HTMLElement | null | undefined) {
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
  queueMicrotask(() => {
    if (!dialog.contains(document.activeElement)) dialog.focus()
  })
  return () => {
    const active = document.activeElement
    if (active && active !== document.body && !dialog.contains(active)) return
    const target = returnTo?.() ?? opener
    if (target?.isConnected) target.focus({ preventScroll: true })
  }
}
