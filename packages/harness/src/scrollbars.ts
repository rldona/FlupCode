/**
 * Scrollbars show only while something scrolls, like macOS overlay scrollbars: the scrolled
 * element gets `fc-scrolling` for a moment after each scroll event (styled in shell.css).
 */
const hideAfter = 900
const timers = new WeakMap<Element, ReturnType<typeof setTimeout>>()

export function trackScrolling() {
  document.addEventListener(
    "scroll",
    (event) => {
      const element = event.target === document ? document.scrollingElement : event.target
      if (!(element instanceof Element)) return
      element.classList.add("fc-scrolling")
      clearTimeout(timers.get(element))
      timers.set(
        element,
        setTimeout(() => element.classList.remove("fc-scrolling"), hideAfter),
      )
    },
    { capture: true, passive: true },
  )
}
