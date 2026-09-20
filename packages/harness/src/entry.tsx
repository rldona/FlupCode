// @refresh reload

import { render } from "solid-js/web"
import { App } from "./app"
import "./index.css"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("FlupCode root element not found")

render(() => <App />, root)

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js")
  })
}
