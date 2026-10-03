/** The toolbar popup: whether the app is there, the pairing code to compare, and handing tabs over. */

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const message = (name: string) => chrome.i18n.getMessage(name)

element("name").textContent = message("name")
element("hand").textContent = message("handTab")
element("take-back").textContent = message("takeBack")
element("port-label").textContent = message("port")

const render = async () => {
  const current = await chrome.runtime.sendMessage<{ status: "offline" | "pairing" | "connected"; code: string; port: number }>({
    type: "status",
  })
  element("status").textContent = message(current.status)
  element("code").textContent = current.code
  element("code").hidden = current.status !== "pairing"
  element("actions").hidden = current.status !== "connected"
  const port = element<HTMLInputElement>("port")
  if (document.activeElement !== port) port.value = String(current.port)
}

element("hand").addEventListener("click", () => void chrome.runtime.sendMessage({ type: "hand" }).then(render))
element("take-back").addEventListener("click", () => void chrome.runtime.sendMessage({ type: "takeBack" }).then(render))
element<HTMLInputElement>("port").addEventListener("change", (event) => {
  void chrome.runtime.sendMessage({ type: "port", port: Number((event.target as HTMLInputElement).value) })
})

void render()
setInterval(() => void render(), 1000)
