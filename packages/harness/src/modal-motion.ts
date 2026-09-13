/**
 * Modals unmount as soon as they close, so their exit is played by a stand-in: when a modal
 * backdrop leaves the DOM, a copy of it is put back just long enough to fade and sink away.
 */
const selector = ".fc-modal-backdrop"
const duration = 180

export function animateModalExits() {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
  const observer = new MutationObserver((records) => {
    if (reduced.matches) return
    // Inside the app root so the copy keeps its layout variables and zoom.
    const host = document.querySelector(".fc-app") ?? document.body
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof HTMLElement)) continue
        const backdrops = node.matches(selector) ? [node] : [...node.querySelectorAll<HTMLElement>(selector)]
        for (const backdrop of backdrops) {
          if (backdrop.classList.contains("fc-modal-leaving")) continue
          const ghost = backdrop.cloneNode(true) as HTMLElement
          ghost.classList.add("fc-modal-leaving")
          ghost.setAttribute("aria-hidden", "true")
          ghost.querySelectorAll("[id]").forEach((element) => element.removeAttribute("id"))
          host.append(ghost)
          setTimeout(() => ghost.remove(), duration)
        }
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
}
