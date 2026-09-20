// @refresh reload

import { render } from "solid-js/web"
import { App } from "./app"
import "./index.css"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("OpenHarness root element not found")

render(() => <App />, root)
