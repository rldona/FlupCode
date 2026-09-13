// @refresh reload

import { ErrorBoundary, render } from "solid-js/web"
import { App } from "./app"
import "./index.css"
import { trackScrolling } from "./scrollbars"
import { animateModalExits } from "./modal-motion"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("FlupCode root element not found")

trackScrolling()
animateModalExits()

// An error that takes the whole app down is handed to the startup guard (public/boot.js), which
// shows it with reload and reset instead of leaving a blank page.
render(
  () => (
    <ErrorBoundary
      fallback={(error) => {
        console.error(error)
        queueMicrotask(() => window.dispatchEvent(new CustomEvent("flupcode:fatal", { detail: error })))
        return null
      }}
    >
      <App />
    </ErrorBoundary>
  ),
  root,
)

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js")
  })
}
